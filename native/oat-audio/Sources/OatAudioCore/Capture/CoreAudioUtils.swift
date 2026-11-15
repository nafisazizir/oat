import CoreAudio
import Foundation

/// Errors that carry a protocol error code (PROTOCOL.md) for the `error` event.
public protocol CodedError: Error {
    var code: String { get }
}

public struct CoreAudioError: CodedError, CustomStringConvertible {
    public let code: String
    public let status: OSStatus
    public let what: String

    public init(_ code: String, _ status: OSStatus, _ what: String) {
        self.code = code
        self.status = status
        self.what = what
    }

    public var description: String { "\(what) failed (OSStatus \(status) \(fourCC(status)))" }
}

func fourCC(_ status: OSStatus) -> String {
    let u = UInt32(bitPattern: status)
    let bytes = [24, 16, 8, 0].map { UInt8((u >> UInt32($0)) & 0xFF) }
    guard bytes.allSatisfy({ $0 >= 32 && $0 < 127 }) else { return "" }
    return "'" + String(decoding: bytes, as: UTF8.self) + "'"
}

func check(_ status: OSStatus, _ code: String, _ what: String) throws {
    if status != noErr { throw CoreAudioError(code, status, what) }
}

enum CA {
    static func address(_ selector: AudioObjectPropertySelector,
                        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                        element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain)
        -> AudioObjectPropertyAddress
    {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
    }

    static func defaultDevice(input: Bool) throws -> AudioObjectID {
        var addr = address(input ? kAudioHardwarePropertyDefaultInputDevice : kAudioHardwarePropertyDefaultOutputDevice)
        var id = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &id),
                  "no_device", "read default \(input ? "input" : "output") device")
        guard id != kAudioObjectUnknown else {
            throw CoreAudioError("no_device", 0, "no default \(input ? "input" : "output") device")
        }
        return id
    }

    static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
        var addr = address(selector)
        var value: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        try withUnsafeMutablePointer(to: &value) { ptr in
            try check(AudioObjectGetPropertyData(object, &addr, 0, nil, &size, ptr), "property", "read string property")
        }
        guard let v = value else { throw CoreAudioError("property", 0, "nil string property") }
        return v.takeRetainedValue() as String
    }

    static func deviceUID(_ device: AudioObjectID) throws -> String {
        try string(device, kAudioDevicePropertyDeviceUID)
    }

    static func deviceName(_ device: AudioObjectID) -> String {
        (try? string(device, kAudioObjectPropertyName)) ?? "device \(device)"
    }

    /// Core Audio process object for a PID (kAudioObjectUnknown if the process has no audio presence yet).
    static func processObject(pid: pid_t) -> AudioObjectID {
        var addr = address(kAudioHardwarePropertyTranslatePIDToProcessObject)
        var qualifier = pid
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &addr,
            UInt32(MemoryLayout<pid_t>.size), &qualifier, &size, &object)
        return status == noErr ? object : AudioObjectID(kAudioObjectUnknown)
    }

    static func tapFormat(_ tap: AudioObjectID) throws -> AudioStreamBasicDescription {
        var addr = address(kAudioTapPropertyFormat)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioObjectGetPropertyData(tap, &addr, 0, nil, &size, &asbd), "tap_format", "read tap format")
        return asbd
    }

    static func nominalSampleRate(_ device: AudioObjectID) -> Double? {
        var addr = address(kAudioDevicePropertyNominalSampleRate)
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        let status = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &rate)
        return status == noErr && rate > 0 ? rate : nil
    }

    /// Number of streams in the given scope (each stream = one AudioBuffer in IO buffer lists).
    static func streamCount(_ device: AudioObjectID, input: Bool) -> Int {
        var addr = address(kAudioDevicePropertyStreams,
                           scope: input ? kAudioObjectPropertyScopeInput : kAudioObjectPropertyScopeOutput)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &addr, 0, nil, &size) == noErr else { return 0 }
        return Int(size) / MemoryLayout<AudioStreamID>.size
    }

    /// Listen for a property change on `object` (default: the system object, for default-device switches).
    /// Returns a remover, or nil if the object does not support listening to that property.
    static func listen(_ selector: AudioObjectPropertySelector,
                       object: AudioObjectID = AudioObjectID(kAudioObjectSystemObject),
                       queue: DispatchQueue,
                       _ handler: @escaping @Sendable () -> Void) -> (@Sendable () -> Void)?
    {
        var addr = address(selector)
        let block: AudioObjectPropertyListenerBlock = { _, _ in handler() }
        let status = AudioObjectAddPropertyListenerBlock(object, &addr, queue, block)
        guard status == noErr else { return nil }
        // The block is only used as an identity token for removal.
        nonisolated(unsafe) let block2 = block
        return {
            let block = block2
            var addr = address(selector)
            AudioObjectRemovePropertyListenerBlock(object, &addr, queue, block)
        }
    }
}

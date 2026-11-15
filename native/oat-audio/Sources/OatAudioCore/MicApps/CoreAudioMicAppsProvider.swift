import CoreAudio
import Darwin
import Foundation

/// Real `MicAppsProvider`: Core Audio process objects (macOS 14.2+). Reads the HAL's list of client processes
/// (`kAudioHardwarePropertyProcessObjectList`) and, for each, `kAudioProcessPropertyIsRunningInput`, `…PID` and
/// `…BundleID`. These are metadata reads on the HAL's process objects: no audio is captured, no tap or IO is
/// started. `appBundleId` comes from the executable path (`proc_pidpath`) → outermost `.app` → its Info.plist.
///
/// Not run by agents or tests (they use `--fixture` / an injected provider): whether these reads can ever show
/// a TCC prompt is not documented by Apple, so the first real run is part of the human checkpoint (README).
public final class CoreAudioMicAppsProvider: MicAppsProvider, @unchecked Sendable {
    /// pid → outermost app bundle id (nil = none). A pid's executable does not change, so this is cached
    /// while the pid stays in the process list.
    private var appBundleCache: [Int32: String?] = [:]

    public init() {}

    public func snapshot() throws -> [MicAppProcess] {
        var out: [MicAppProcess] = []
        var seen = Set<Int32>()
        for object in try processObjects() {
            guard Self.uint32(object, kAudioProcessPropertyIsRunningInput) == 1 else { continue }
            guard let pid = Self.pid(object) else { continue }
            seen.insert(pid)
            let bundleId = (try? CA.string(object, kAudioProcessPropertyBundleID)).flatMap { $0.isEmpty ? nil : $0 }
            out.append(MicAppProcess(pid: pid, bundleId: bundleId, appBundleId: appBundleId(pid)))
        }
        appBundleCache = appBundleCache.filter { seen.contains($0.key) }
        return out
    }

    private func processObjects() throws -> [AudioObjectID] {
        var addr = CA.address(kAudioHardwarePropertyProcessObjectList)
        let system = AudioObjectID(kAudioObjectSystemObject)
        var size: UInt32 = 0
        try check(AudioObjectGetPropertyDataSize(system, &addr, 0, nil, &size), "process_list", "read process list size")
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard !ids.isEmpty else { return [] }
        try ids.withUnsafeMutableBytes { buf in
            try check(AudioObjectGetPropertyData(system, &addr, 0, nil, &size, buf.baseAddress!),
                      "process_list", "read process list")
        }
        return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.size))
    }

    private static func uint32(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> UInt32? {
        var addr = CA.address(selector)
        var value: UInt32 = 0
        var size = UInt32(MemoryLayout<UInt32>.size)
        return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr ? value : nil
    }

    private static func pid(_ object: AudioObjectID) -> Int32? {
        var addr = CA.address(kAudioProcessPropertyPID)
        var value: pid_t = 0
        var size = UInt32(MemoryLayout<pid_t>.size)
        return AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &value) == noErr && value > 0 ? value : nil
    }

    private func appBundleId(_ pid: Int32) -> String? {
        if let cached = appBundleCache[pid] { return cached }
        let id = Self.executablePath(pid).flatMap(Self.outermostAppBundleId)
        appBundleCache[pid] = id
        return id
    }

    static func executablePath(_ pid: Int32) -> String? {
        var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        let n = proc_pidpath(pid, &buf, UInt32(buf.count))
        guard n > 0 else { return nil }
        return String(decoding: buf.prefix(Int(n)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    /// `/Applications/Foo.app/Contents/Frameworks/Foo Helper.app/Contents/MacOS/Foo Helper` → Foo.app's id.
    static func outermostAppBundleId(_ executablePath: String) -> String? {
        guard let path = outermostAppPath(executablePath) else { return nil }
        return Bundle(path: path)?.bundleIdentifier
    }

    static func outermostAppPath(_ executablePath: String) -> String? {
        let parts = executablePath.split(separator: "/", omittingEmptySubsequences: false)
        guard let i = parts.firstIndex(where: { $0.hasSuffix(".app") }) else { return nil }
        return parts[...i].joined(separator: "/")
    }
}

@preconcurrency import AVFoundation
import Darwin
import Foundation

/// Permission status without prompting.
///
/// - Microphone: `AVCaptureDevice.authorizationStatus(for: .audio)` — a read-only query, never prompts.
/// - System audio: there is no public read-only API. We call TCC's `TCCAccessPreflight` for
///   `kTCCServiceAudioCapture` through `dlsym` (best effort, preflight never prompts). If the symbol is missing
///   the status is `unknown`; the real answer then arrives on first capture (a denied tap delivers silence).
///
/// Note: for an unbundled CLI, TCC attributes the request to the *responsible* process (the terminal, or the
/// Electron app that spawned us), so results reflect that app's grants.
public enum Permissions {
    public static func microphoneStatus() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "unknown"
        }
    }

    public static func systemAudioStatus() -> (status: String, method: String) {
        typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int32
        guard let handle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
              let sym = dlsym(handle, "TCCAccessPreflight")
        else { return ("unknown", "unavailable") }
        let preflight = unsafeBitCast(sym, to: Preflight.self)
        let result = preflight("kTCCServiceAudioCapture" as CFString, nil)
        switch result {
        case 0: return ("granted", "tcc_preflight")
        case 1: return ("denied", "tcc_preflight")
        case 2: return ("not_determined", "tcc_preflight")
        default: return ("unknown", "tcc_preflight")
        }
    }

    public static var systemAudioSupported: Bool {
        ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 14, minorVersion: 4, patchVersion: 0))
    }

    public static func json() -> JSONValue {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let system = systemAudioStatus()
        return .object([
            ("microphone", .string(microphoneStatus())),
            ("system_audio", .string(system.status)),
            ("system_audio_method", .string(system.method)),
            ("system_audio_supported", .bool(systemAudioSupported)),
            ("os_version", .string("\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)")),
            ("prompted", .bool(false)),
        ])
    }
}

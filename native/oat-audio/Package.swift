// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "oat-audio",
    platforms: [
        // Core Audio process taps (CATapDescription / AudioHardwareCreateProcessTap) need macOS 14.2+;
        // we target 14.4 as the supported floor (SPEC §5).
        .macOS("14.4"),
    ],
    products: [
        .executable(name: "oat-audio", targets: ["oat-audio"]),
        .library(name: "OatAudioCore", targets: ["OatAudioCore"]),
    ],
    targets: [
        .target(
            name: "OatAudioCore",
            linkerSettings: [
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreAudio"),
                .linkedFramework("AudioToolbox"),
            ]
        ),
        .executableTarget(
            name: "oat-audio",
            dependencies: ["OatAudioCore"]
        ),
        .testTarget(
            name: "OatAudioCoreTests",
            dependencies: ["OatAudioCore"]
        ),
    ]
)

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
                .linkedFramework("EventKit"),
                .linkedFramework("CoreGraphics"),
            ]
        ),
        .executableTarget(
            name: "oat-audio",
            dependencies: ["OatAudioCore"],
            exclude: ["Info.plist"],
            linkerSettings: [
                // Embed Info.plist (`__TEXT,__info_plist`) so the bare executable carries the Calendars usage
                // descriptions; without them `calendar request-access` is killed by TCC instead of prompting.
                .unsafeFlags([
                    "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
                    "-Xlinker", "\(Context.packageDirectory)/Sources/oat-audio/Info.plist",
                ]),
            ]
        ),
        .testTarget(
            name: "OatAudioCoreTests",
            dependencies: ["OatAudioCore"]
        ),
    ]
)

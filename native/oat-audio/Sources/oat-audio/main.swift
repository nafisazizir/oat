import Darwin
import Foundation
import OatAudioCore

func printJSON(_ value: JSONValue) {
    print(value.serialized())
}

func runCapture(_ options: CaptureOptions) -> Never {
    // A vanished reader must surface as a write error, not kill us mid-flush.
    signal(SIGPIPE, SIG_IGN)

    let clock = HostCaptureClock()
    let sources: [CaptureSource] = options.sources.map { id in
        if options.synthetic {
            let cap = options.durationSeconds.map { Int(($0 * Double(options.sampleRate)).rounded()) }
            return SyntheticSource(id: id, sampleRate: options.sampleRate, clock: clock, maxSamples: cap)
        }
        switch id {
        case .mic:
            return MicSource(sampleRate: options.sampleRate, clock: clock, echoCancellation: options.aec)
        default:
            return SystemAudioSource(sampleRate: options.sampleRate, clock: clock,
                                     excludePIDs: options.excludePIDs.map { pid_t($0) })
        }
    }
    // Writer queue holds ~5 s of audio for all sources; beyond that the oldest audio is dropped (`overrun`).
    let capacity = max(64 * 1024, 5 * options.sampleRate * 2 * max(1, options.sources.count))
    let sink = QueuedFrameSink(fd: STDOUT_FILENO, capacityBytes: capacity, sampleRate: options.sampleRate)
    let session = CaptureSession(options: options, sources: sources, sink: sink, clock: clock)
    session.onFinished { code in
        Log.info("stopped (exit \(code))")
        exit(code)
    }

    // SIGINT / SIGTERM → graceful stop (flush + `stopped`).
    var signalSources: [DispatchSourceSignal] = []
    for sig in [SIGINT, SIGTERM] {
        signal(sig, SIG_IGN)
        let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
        src.setEventHandler { session.stop(reason: .signal) }
        src.resume()
        signalSources.append(src)
    }

    let mode = StdinMode.detect()
    let stdin = StdinControl(
        mode: mode,
        onCommand: { session.handle($0) },
        onInvalid: { session.reportError(code: "invalid_command", message: $0) },
        onEOF: { session.stop(reason: .stdinEOF) })

    Log.info("capture: sources=\(options.sources.map(\.name)) rate=\(options.sampleRate) synthetic=\(options.synthetic) stdin=\(mode)")
    session.start()
    stdin.start()
    withExtendedLifetime(signalSources) {
        RunLoop.main.run()
    }
    exit(0)
}

let args = Array(CommandLine.arguments.dropFirst())
do {
    switch try CLI.parse(args) {
    case .help:
        print(CLI.usage)
    case .version:
        printJSON(.object([("version", .string(OatProtocol.toolVersion)), ("protocol", .int(OatProtocol.version))]))
    case .permissions:
        printJSON(Permissions.json())
    case .capture(let options):
        runCapture(options)
    }
} catch {
    FileHandle.standardError.write(Data("oat-audio: \(error)\n\n\(CLI.usage)\n".utf8))
    exit(64)
}

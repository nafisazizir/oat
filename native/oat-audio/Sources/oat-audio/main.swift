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

func writeStdout(_ text: String) {
    FileHandle.standardOutput.write(Data(text.utf8))
}

/// Exit codes: 0 ok · 1 failure (bad fixture, EventKit error) · 64 usage · 77 no Calendars access.
func calendarFail(_ error: Error) -> Never {
    FileHandle.standardError.write(Data("oat-audio: calendar: \(error)\n".utf8))
    if let e = error as? CalendarError, e.kind == .notAuthorized { exit(77) }
    if error is CLIError { exit(64) }
    exit(1)
}

func calendarStore(_ fixture: String?) throws -> (CalendarEventStore, String) {
    if let fixture { return (try FixtureCalendarStore(path: fixture), "fixture") }
    return (EventKitCalendarStore(), "eventkit")
}

func runCalendar(_ command: CalendarCommand) -> Never {
    do {
        switch command {
        case .status(let fixture):
            // The static EventKit query never prompts and never instantiates a store.
            let json = try fixture.map { CalendarRunner.statusJSON(try FixtureCalendarStore(path: $0).authorization(), source: "fixture") }
                ?? CalendarRunner.statusJSON(EventKitCalendarStore.authorization(), source: "eventkit")
            writeStdout(json.serialized() + "\n")
            exit(0)

        case .requestAccess:
            // Human use only: this is the one path that can show the macOS Calendars prompt.
            let store = EventKitCalendarStore()
            Task {
                let auth = await store.requestAccess()
                writeStdout(CalendarRunner.statusJSON(auth, source: "eventkit").serialized() + "\n")
                exit(auth.canRead ? 0 : 77)
            }
            RunLoop.main.run()
            exit(0)

        case .events(let options):
            let (store, _) = try calendarStore(options.fixture)
            let lines = try CalendarRunner.eventLines(store: store, options: options)
            writeStdout(lines.map { $0 + "\n" }.joined())
            exit(0)

        case .watch(let options):
            let (store, source) = try calendarStore(options.fixture)
            let auth = store.authorization()
            guard auth.canRead else { throw CalendarError(.notAuthorized, "calendar access is \(auth.rawValue)") }
            let lock = NSLock()
            let emit: @Sendable (String) -> Void = { line in
                lock.lock()
                writeStdout(line + "\n")
                lock.unlock()
            }
            let debouncer = Debouncer(delay: Double(options.debounceMs) / 1000) {
                emit(CalendarRunner.watchLine("changed"))
            }
            try store.observeChanges { debouncer.signal() }
            var signalSources: [DispatchSourceSignal] = []
            for sig in [SIGINT, SIGTERM] {
                signal(sig, SIG_IGN)
                let src = DispatchSource.makeSignalSource(signal: sig, queue: .global())
                src.setEventHandler { exit(0) }
                src.resume()
                signalSources.append(src)
            }
            let stdin = StdinControl(
                mode: StdinMode.detect(),
                onCommand: { if $0 == .stop { exit(0) } },
                onInvalid: { Log.info("calendar watch: ignoring stdin line: \($0)") },
                onEOF: { exit(0) })
            stdin.start()
            emit(CalendarRunner.watchLine("ready", source: source))
            Log.info("calendar watch: source=\(source) debounce=\(options.debounceMs)ms")
            withExtendedLifetime((store, signalSources, debouncer)) {
                RunLoop.main.run()
            }
            exit(0)
        }
    } catch {
        calendarFail(error)
    }
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
    case .calendar(let command):
        runCalendar(command)
    case .capture(let options):
        runCapture(options)
    }
} catch {
    FileHandle.standardError.write(Data("oat-audio: \(error)\n\n\(CLI.usage)\n".utf8))
    exit(64)
}

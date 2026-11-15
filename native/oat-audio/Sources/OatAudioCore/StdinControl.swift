import Darwin
import Foundation

/// How stdin is treated, decided from what fd 0 actually is.
public enum StdinMode: Equatable, Sendable {
    /// Pipe / socket (how Electron spawns us) or a TTY: read commands; EOF means stop.
    case commandsStopOnEOF
    /// Regular file redirect: read commands, ignore EOF.
    case commandsIgnoreEOF
    /// /dev/null or another non-tty character device: nothing to read (a closed-by-default stdin must not
    /// stop the capture immediately, e.g. when run from a CI shell).
    case ignore

    public static func detect(fd: Int32 = STDIN_FILENO) -> StdinMode {
        var st = stat()
        guard fstat(fd, &st) == 0 else { return .ignore }
        let type = st.st_mode & S_IFMT
        if type == S_IFIFO || type == S_IFSOCK { return .commandsStopOnEOF }
        if isatty(fd) == 1 { return .commandsStopOnEOF }
        if type == S_IFREG { return .commandsIgnoreEOF }
        return .ignore
    }
}

/// Reads newline-delimited JSON control commands from stdin on a background thread.
public final class StdinControl: @unchecked Sendable {
    private let fd: Int32
    private let mode: StdinMode
    private let onCommand: @Sendable (ControlCommand) -> Void
    private let onInvalid: @Sendable (String) -> Void
    private let onEOF: @Sendable () -> Void

    public init(fd: Int32 = STDIN_FILENO, mode: StdinMode,
                onCommand: @escaping @Sendable (ControlCommand) -> Void,
                onInvalid: @escaping @Sendable (String) -> Void,
                onEOF: @escaping @Sendable () -> Void)
    {
        self.fd = fd
        self.mode = mode
        self.onCommand = onCommand
        self.onInvalid = onInvalid
        self.onEOF = onEOF
    }

    public func start() {
        guard mode != .ignore else { return }
        let thread = Thread { [self] in self.run() }
        thread.name = "oat-audio.stdin"
        thread.start()
    }

    private func run() {
        var splitter = LineSplitter()
        var buf = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(fd, &buf, buf.count)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { break }
            for line in splitter.feed(Data(buf[0..<n])) { handle(line) }
        }
        if let last = splitter.finish() { handle(last) }
        if mode == .commandsStopOnEOF { onEOF() }
    }

    private func handle(_ line: String) {
        do {
            if let cmd = try ControlCommand.parse(line: line) { onCommand(cmd) }
        } catch {
            onInvalid("\(error)")
        }
    }
}

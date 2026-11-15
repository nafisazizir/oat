import Foundation

/// Commands accepted on stdin as newline-delimited JSON: `{"cmd":"pause"|"resume"|"stop"}`.
public enum ControlCommand: String, Sendable, Equatable {
    case pause
    case resume
    case stop
}

public enum ControlParseError: Error, Equatable, CustomStringConvertible {
    case notJSONObject
    case missingCmd
    case unknownCmd(String)

    public var description: String {
        switch self {
        case .notJSONObject: return "control line is not a JSON object"
        case .missingCmd: return "control object has no string \"cmd\""
        case .unknownCmd(let c): return "unknown cmd \"\(c)\""
        }
    }
}

extension ControlCommand {
    /// Parse one line. Returns nil for blank lines. Unknown extra fields are ignored (forward compatible).
    public static func parse(line: String) throws -> ControlCommand? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }
        guard let data = trimmed.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data),
              let dict = obj as? [String: Any]
        else { throw ControlParseError.notJSONObject }
        guard let cmd = dict["cmd"] as? String else { throw ControlParseError.missingCmd }
        guard let parsed = ControlCommand(rawValue: cmd) else { throw ControlParseError.unknownCmd(cmd) }
        return parsed
    }
}

/// Splits a byte stream into `\n`-terminated lines (tolerates `\r\n`). Lines longer than `maxLineLength`
/// are discarded to bound memory.
public struct LineSplitter: Sendable {
    private var buffer = Data()
    private var discarding = false
    public let maxLineLength: Int

    public init(maxLineLength: Int = 64 * 1024) {
        self.maxLineLength = maxLineLength
    }

    public mutating func feed(_ chunk: Data) -> [String] {
        var lines: [String] = []
        for byte in chunk {
            if byte == 0x0A {
                if !discarding {
                    var line = String(decoding: buffer, as: UTF8.self)
                    if line.hasSuffix("\r") { line.removeLast() }
                    lines.append(line)
                }
                buffer.removeAll(keepingCapacity: true)
                discarding = false
            } else if !discarding {
                buffer.append(byte)
                if buffer.count > maxLineLength {
                    buffer.removeAll()
                    discarding = true
                }
            }
        }
        return lines
    }

    /// Remaining unterminated text at EOF.
    public mutating func finish() -> String? {
        defer { buffer.removeAll(); discarding = false }
        guard !discarding, !buffer.isEmpty else { return nil }
        return String(decoding: buffer, as: UTF8.self)
    }
}

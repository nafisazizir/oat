import Foundation

public enum ConferenceProvider: String, Sendable, Equatable, CaseIterable {
    case zoom
    case googleMeet = "google_meet"
    case teams
}

public struct ConferenceLink: Sendable, Equatable {
    public var provider: ConferenceProvider
    public var url: String

    public init(provider: ConferenceProvider, url: String) {
        self.provider = provider
        self.url = url
    }
}

/// Finds a Zoom / Google Meet / Microsoft Teams join link in an event's URL, location or notes.
///
/// The rules are mirrored by `detectConferenceLink` in `@oat/core` (TypeScript); both are tested against the
/// shared cases in `fixtures/calendar/conference-links.json`, so keep the two in step:
/// - fields are searched in the order url → location → notes; the first field with a link wins;
/// - within a field the earliest link wins, whatever its provider;
/// - a link ends at whitespace, `<`, `>`, `"` or `'`; trailing `.,;:!?)]}*` are trimmed.
public enum ConferenceLinks {
    /// Same pattern text as the TypeScript side (case-insensitive).
    public static let patterns: [(ConferenceProvider, String)] = [
        (.zoom, #"https?://(?:[a-z0-9-]+\.)*(?:zoom\.us|zoomgov\.com)/(?:j|s|w|my|wc/join)/[^\s<>"']+"#),
        (.googleMeet, #"https?://meet\.google\.com/(?:[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}|lookup/[a-z0-9_-]+)(?:\?[^\s<>"']*)?"#),
        (.teams, #"https?://(?:teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)/(?:l/meetup-join|meet)/[^\s<>"']+"#),
    ]

    private static let trailing: Set<Character> = [".", ",", ";", ":", "!", "?", ")", "]", "}", "*"]

    private static let compiled: [(ConferenceProvider, NSRegularExpression)] = patterns.map {
        // The patterns are constants; a failure here is a programming error caught by the tests.
        ($0.0, try! NSRegularExpression(pattern: $0.1, options: [.caseInsensitive]))
    }

    public static func detect(url: String?, location: String?, notes: String?) -> ConferenceLink? {
        for field in [url, location, notes] {
            if let field, let link = firstLink(in: field) { return link }
        }
        return nil
    }

    /// The earliest join link in `text`, or nil.
    public static func firstLink(in text: String) -> ConferenceLink? {
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        var best: (location: Int, link: ConferenceLink)?
        for (provider, regex) in compiled {
            guard let m = regex.firstMatch(in: text, options: [], range: full) else { continue }
            if let b = best, b.location <= m.range.location { continue }
            best = (m.range.location, ConferenceLink(provider: provider, url: trim(ns.substring(with: m.range))))
        }
        return best?.link
    }

    private static func trim(_ s: String) -> String {
        var out = s
        while let last = out.last, trailing.contains(last) { out.removeLast() }
        return out
    }
}

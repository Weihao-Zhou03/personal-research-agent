import Foundation

public enum RetryAfter {
    public static let maximumDelay: TimeInterval = 86_400
    /// HTTP delta-seconds or IMF-fixdate. Invalid/missing values pause for 60 seconds.
    public static func deadline(_ value: String?, now: Date = Date()) -> Date {
        let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        var delay: TimeInterval = 60
        if !raw.isEmpty, raw.utf8.allSatisfy({ (48...57).contains($0) }), let seconds = Double(raw), seconds.isFinite {
            delay = seconds
        } else if !raw.isEmpty {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
            formatter.isLenient = false
            if let date = formatter.date(from: raw) { delay = date.timeIntervalSince(now) }
        }
        return now.addingTimeInterval(max(1, min(maximumDelay, delay)))
    }
}

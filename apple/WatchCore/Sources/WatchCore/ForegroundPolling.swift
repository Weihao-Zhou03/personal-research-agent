public enum ForegroundPolling {
    /// At most 55 seconds of scheduled foreground waits; each request is separately bounded.
    public static let delays: [UInt64] = [5, 10, 20, 20]
    public static func hasPendingAsk(_ items: [FeedItem]) -> Bool {
        items.contains { $0.type == "ask" && ["queued", "running", "waiting_retry"].contains($0.status) }
    }
}

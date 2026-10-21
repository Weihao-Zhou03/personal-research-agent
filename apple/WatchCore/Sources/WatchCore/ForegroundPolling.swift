public enum ForegroundPolling {
    /// At most 55 seconds of scheduled foreground waits; each request is separately bounded.
    public static let delays: [UInt64] = [5, 10, 20, 20]
}

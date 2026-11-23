import Foundation

/// Opening and refreshing the results list can only perform authenticated reads.
/// The caller's fence is rechecked between requests and before accepting a result.
public enum ReadOnlyWatchReader {
    @MainActor
    public static func feed(client: APIClient, identity: BackendIdentity, secret: String,
                            cursor: String? = nil, isCurrent: () -> Bool) async throws -> FeedResponse {
        guard isCurrent(), !Task.isCancelled, client.origin == identity.backendOrigin else {
            throw WatchCoreError.identityChanged
        }
        let me = try await client.me(secret: secret)
        guard isCurrent(), !Task.isCancelled, try me.identity(origin: client.origin) == identity else {
            throw WatchCoreError.identityChanged
        }
        guard me.capabilities.feed else { throw APIError(code: "SCOPE_DENIED", status: 403) }
        let result = try await client.feed(secret: secret, cursor: cursor)
        guard isCurrent(), !Task.isCancelled else { throw WatchCoreError.identityChanged }
        guard result.schemaVersion == "1" else { throw WatchCoreError.unsupportedSchema }
        return result
    }
}

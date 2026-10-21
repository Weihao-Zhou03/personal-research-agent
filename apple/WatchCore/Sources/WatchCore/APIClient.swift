import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct APIError: Error, Equatable, Sendable {
    public let code: String
    public let status: Int
    public let retryable: Bool
    public init(code: String, status: Int = 0, retryable: Bool = false) {
        self.code = code; self.status = status; self.retryable = retryable
    }
}

private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public struct PairingRequest: Codable, Sendable {
    public let pairingRequestID: String
    public let deviceSecretHash: String
    public let deviceName: String
    enum CodingKeys: String, CodingKey {
        case pairingRequestID = "pairing_request_id", deviceSecretHash = "device_secret_hash", deviceName = "device_name"
    }
    public init(pairingRequestID: String, deviceSecretHash: String, deviceName: String) {
        self.pairingRequestID = pairingRequestID; self.deviceSecretHash = deviceSecretHash; self.deviceName = deviceName
    }
}

public struct Diagnostics: Codable, Sendable {
    public let schemaVersion: String
    public let version: String
    public let requestID: String
    enum CodingKeys: String, CodingKey { case schemaVersion = "schema_version", version, requestID = "request_id" }
}

public final class APIClient: @unchecked Sendable {
    public let origin: String
    private let session: URLSession
    public init(origin: String, session: URLSession? = nil) throws {
        self.origin = try BackendIdentity(backendOrigin: origin, deploymentID: "validate", ownerID: "validate").backendOrigin
        if let session { self.session = session } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 15
            config.timeoutIntervalForResource = 20
            config.urlCache = nil
            config.httpCookieStorage = nil
            config.httpShouldSetCookies = false
            self.session = URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
        }
    }

    public func diagnostics() async throws -> Diagnostics { try await request("/api/v1/diagnostics") }
    public func pair(_ body: PairingRequest) async throws -> PairingResponse {
        try await request("/api/v1/pairings", method: "POST", body: JSONEncoder().encode(body))
    }
    public func pairingStatus(id: String, secret: String) async throws -> PairingResponse {
        // Server pairing IDs are pair_<lowercase UUID>. Validate rather than encoding the
        // underscore/hyphens: Node's URL.pathname preserves those percent escapes and the
        // server deliberately matches only the canonical ID path.
        guard id.utf8.count == 41,
              id.range(of: "^pair_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", options: .regularExpression) != nil,
              UUID(uuidString: String(id.dropFirst(5))) != nil else {
            throw APIError(code: "INVALID_PAIRING_ID")
        }
        return try await request("/api/v1/pairings/\(id)", secret: secret)
    }
    public func me(secret: String) async throws -> DeviceIdentityResponse {
        try await request("/api/v1/watch/me", secret: secret)
    }
    public func feed(secret: String) async throws -> FeedResponse {
        try await request("/api/v1/watch/feed", secret: secret)
    }
    public func capture(_ item: OutboxItem, secret: String) async throws -> CaptureReceipt {
        guard item.identity.backendOrigin == origin, item.state == .submissionUnknown else {
            throw WatchCoreError.identityChanged
        }
        return try await request("/api/v1/watch/captures", method: "POST", secret: secret,
            body: item.requestBody, idempotencyKey: item.clientRequestID.uuidString.lowercased())
    }

    private func request<Response: Decodable>(_ path: String, method: String = "GET", secret: String? = nil,
                                               body: Data? = nil, idempotencyKey: String? = nil) async throws -> Response {
        guard let url = URL(string: origin + path) else { throw WatchCoreError.invalidOrigin }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let secret { request.setValue("Bearer \(secret)", forHTTPHeaderField: "Authorization") }
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        let data: Data; let response: URLResponse
        do { (data, response) = try await session.data(for: request) }
        catch { throw APIError(code: "NETWORK_UNAVAILABLE", retryable: true) }
        guard let http = response as? HTTPURLResponse else { throw APIError(code: "INVALID_RESPONSE") }
        guard (200..<300).contains(http.statusCode) else {
            struct Envelope: Decodable {
                struct Detail: Decodable { let code: String; let retryable: Bool }
                let error: Detail
            }
            let envelope = try? JSONDecoder().decode(Envelope.self, from: data)
            let code = envelope?.error.code ?? "HTTP_\(http.statusCode)"
            // Only structured codes leave this layer, never raw upstream bodies or credentials.
            throw APIError(code: code, status: http.statusCode,
                retryable: envelope?.error.retryable ?? (http.statusCode == 429 || http.statusCode >= 500))
        }
        guard data.count <= 1_048_576 else { throw APIError(code: "RESPONSE_TOO_LARGE") }
        do { return try JSONDecoder().decode(Response.self, from: data) }
        catch { throw APIError(code: "INVALID_RESPONSE", status: http.statusCode) }
    }
}

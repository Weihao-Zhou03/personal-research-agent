import Foundation
import XCTest
@testable import WatchCore

private final class StubProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw APIError(code: "NO_TEST_HANDLER") }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class APIClientTests: XCTestCase {
    func testSharedNodeSwiftContractFixture() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        let data = try Data(contentsOf: root.appendingPathComponent("test/fixtures/watch-contract.json"))
        struct Fixture: Decodable {
            struct Vector: Decodable { let device_secret: String; let device_secret_hash: String }
            struct Request: Decodable { let client_request_id: String; let body: CapturePayload }
            let schema_version: String
            let pairing_vector: Vector
            let capture_request: Request
            let capture_response: CaptureReceipt
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: data)
        XCTAssertEqual(fixture.schema_version, "1")
        XCTAssertEqual(CredentialHash.sha256(fixture.pairing_vector.device_secret), fixture.pairing_vector.device_secret_hash)
        XCTAssertNotNil(UUID(uuidString: fixture.capture_request.client_request_id))
        XCTAssertEqual(fixture.capture_request.body.workspaceID, fixture.capture_response.workspaceID)
        XCTAssertTrue(fixture.capture_request.body.text.hasPrefix("  "))
        XCTAssertEqual(fixture.capture_response.captureID, "cap_fixture")
    }

    private func client() throws -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        addTeardownBlock { StubProtocol.handler = nil }
        return try APIClient(origin: "https://agent.example.invalid", session: URLSession(configuration: config))
    }
    func testCaptureUsesExactPersistedBytesAndSameIdempotencyKeyOnRetry() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let identity = try BackendIdentity(backendOrigin: "https://agent.example.invalid", deploymentID: "d1", ownerID: "o1")
        let outbox = try Outbox(directory: dir)
        let original = try await outbox.enqueue(text: "不丢原文 \n", workspace: .init(id: "ws_1", name: "资料"), identity: identity)
        let attempt = try await outbox.beginAttempt(id: original.id, identity: identity)
        let api = try client()
        StubProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/watch/captures")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-only-secret")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Idempotency-Key"), original.id.uuidString.lowercased())
            var body = request.httpBody
            if body == nil, let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var received = Data(), buffer = [UInt8](repeating: 0, count: 1024)
                while stream.hasBytesAvailable {
                    let count = stream.read(&buffer, maxLength: 1024)
                    if count <= 0 { break }
                    received.append(contentsOf: buffer.prefix(count))
                }
                body = received
            }
            XCTAssertEqual(body, original.requestBody)
            return (201, Data("""
                {"schema_version":"1","capture_id":"cap_1","workspace_id":"ws_1","status":"saved","index_status":"pending","accepted_at":"2026-10-21T09:00:01Z"}
                """.utf8))
        }
        let first = try await api.capture(attempt, secret: "test-only-secret")
        let again = try await outbox.beginAttempt(id: original.id, identity: identity)
        let replay = try await api.capture(again, secret: "test-only-secret")
        XCTAssertEqual(first.captureID, replay.captureID)
        XCTAssertEqual(again.requestBody, original.requestBody)
    }

    func testStructuredErrorDoesNotExposeMessageOrRawUpstreamBody() async throws {
        let api = try client()
        StubProtocol.handler = { _ in
            (403, Data("""
                {"error":{"code":"WORKSPACE_UNAVAILABLE","message":"private upstream content","retryable":false,"request_id":"req_1"}}
                """.utf8))
        }
        do { _ = try await api.me(secret: "test-only-secret"); XCTFail() }
        catch let error as APIError {
            XCTAssertEqual(error.code, "WORKSPACE_UNAVAILABLE")
            XCTAssertEqual(error.status, 403)
            XCTAssertFalse(error.retryable)
            XCTAssertFalse(String(describing: error).contains("private upstream"))
        }
    }

    func testInvalidSuccessNeverBecomesAcknowledgement() async throws {
        let api = try client()
        StubProtocol.handler = { _ in (200, Data("not json".utf8)) }
        do { _ = try await api.me(secret: "test-only-secret"); XCTFail() }
        catch let error as APIError { XCTAssertEqual(error.code, "INVALID_RESPONSE") }
    }

    func testPairingStatusUsesExactCanonicalPathWithoutEscapingUnderscoreOrHyphens() async throws {
        let api = try client()
        let id = "pair_01234567-89ab-4cde-8fab-0123456789ab"
        StubProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString,
                "https://agent.example.invalid/api/v1/pairings/pair_01234567-89ab-4cde-8fab-0123456789ab")
            XCTAssertEqual(request.url?.path, "/api/v1/pairings/" + id)
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-only-secret")
            return (200, Data("""
                {"schema_version":"1","pairing_id":"\(id)","status":"pending","user_code":"ABCD2345","expires_at":"2026-10-21T09:10:00Z","approval_url":"https://agent.example.invalid/owner#pair"}
                """.utf8))
        }
        let response = try await api.pairingStatus(id: id, secret: "test-only-secret")
        XCTAssertEqual(response.pairingID, id)
        XCTAssertEqual(response.status, "pending")
    }

    func testPairingStatusRejectsNonCanonicalOrUnsafeIDsBeforeNetworking() async throws {
        let api = try client()
        StubProtocol.handler = { _ in
            XCTFail("Invalid pairing IDs must never reach URLSession")
            return (500, Data())
        }
        for id in ["pair_../owner", "pair_a/b", "pair_a%2Fb", "pair_01234567-89ab-4cde-8fab-0123456789ab?x=1",
                   "pair_01234567-89AB-4cde-8fab-0123456789ab", "pair_01234567-89ab-4cde-8fab-0123456789ab\n",
                   "pair_not-a-uuid", "other_01234567-89ab-4cde-8fab-0123456789ab"] {
            do { _ = try await api.pairingStatus(id: id, secret: "test-only-secret"); XCTFail("Accepted invalid ID") }
            catch let error as APIError { XCTAssertEqual(error.code, "INVALID_PAIRING_ID") }
        }
    }

    func testRevokedAndExpiredPairingsDecodeWithoutIdentityFields() throws {
        for status in ["revoked", "expired", "denied"] {
            let data = Data("""
                {"schema_version":"1","pairing_id":"pair_01234567-89ab-4cde-8fab-0123456789ab","status":"\(status)","expires_at":"2026-10-21T09:10:00Z"}
                """.utf8)
            let response = try JSONDecoder().decode(PairingResponse.self, from: data)
            XCTAssertEqual(response.status, status)
            XCTAssertNil(response.ownerID)
            XCTAssertNil(response.deploymentID)
            XCTAssertNil(response.deviceID)
            XCTAssertNil(response.defaultWorkspace)
            XCTAssertNil(response.allowedWorkspaces)
            XCTAssertNil(response.deviceExpiresAt)
        }
    }
}

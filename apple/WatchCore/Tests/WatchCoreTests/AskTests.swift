import Foundation
import XCTest
@testable import WatchCore

private final class AskProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, [String: String], Data))?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let (status, headers, data) = try Self.handler!(request)
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

final class AskTests: XCTestCase {
    private let jobID = "job_01234567-89ab-4cde-8fab-0123456789ab"
    private func fixture() throws -> [String: Any] {
        var root = URL(fileURLWithPath: #filePath); for _ in 0..<5 { root.deleteLastPathComponent() }
        return try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("test/fixtures/watch-ask-contract.json"))) as! [String: Any]
    }
    private func data(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    private func identity() throws -> BackendIdentity { try .init(backendOrigin: "https://agent.example.invalid", deploymentID: "d", ownerID: "o") }
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: url) }; return url
    }
    private func client() throws -> APIClient {
        let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [AskProtocol.self]
        addTeardownBlock { AskProtocol.handler = nil }
        return try APIClient(origin: "https://agent.example.invalid", session: URLSession(configuration: config))
    }
    func testAskRestartAndReceiptPreserveQuestionBytesAndOriginalWorkspace() async throws {
        let values = try fixture(), dir = try directory(), owner = try identity()
        let body = try JSONDecoder().decode(AskPayload.self, from: data(values["ask_body"]!))
        let store = try Outbox(directory: dir)
        let item = try await store.enqueue(text: body.question, workspace: .init(id: body.workspaceID, name: "原空间"), identity: owner, operation: "ask")
        _ = try await store.beginAttempt(id: item.id, identity: owner)
        let restarted = try Outbox(directory: dir)
        let retry = try await restarted.beginAttempt(id: item.id, identity: owner)
        XCTAssertEqual(retry.requestBody, item.requestBody); XCTAssertEqual(retry.id, item.id)
        let actual = try JSONDecoder().decode(AskPayload.self, from: retry.requestBody)
        XCTAssertEqual(actual.question, body.question)
        let receipt = try JSONDecoder().decode(AskReceipt.self, from: data(values["ask_receipt"]!))
        try await restarted.acknowledgeAsk(id: item.id, identity: owner, receipt: receipt)
        let confirmed = await restarted.allItems()
        XCTAssertEqual(confirmed.first?.serverResourceID, jobID); XCTAssertEqual(confirmed.first?.state, .acknowledged)
    }
    func testCaptureAndAskShareCapacityAndAskUses1000UnicodeScalarLimit() async throws {
        let store = try Outbox(directory: directory()), owner = try identity(), ws = Workspace(id: "ws", name: "资料")
        for _ in 0..<99 { _ = try await store.enqueue(text: "笔记", workspace: ws, identity: owner) }
        _ = try await store.enqueue(text: String(repeating: "😀", count: 1000), workspace: ws, identity: owner, operation: "ask")
        do { _ = try await store.enqueue(text: "第101条", workspace: ws, identity: owner, operation: "ask"); XCTFail() }
        catch { XCTAssertEqual(error as? WatchCoreError, .capacityReached) }
        let separate = try Outbox(directory: directory())
        do { _ = try await separate.enqueue(text: String(repeating: "中", count: 1001), workspace: ws, identity: owner, operation: "ask"); XCTFail() }
        catch { XCTAssertEqual(error as? WatchCoreError, .textTooLong) }
    }
    func testJobReadsUseGETAndBriefIsStructuredWithoutStartingGeneration() async throws {
        let values = try fixture(), api = try client(), expected = jobID
        AskProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET"); XCTAssertNil(request.httpBody)
            if request.url?.path == "/api/v1/watch/jobs/\(expected)/brief" { return (200, [:], try self.data(values["brief"]!)) }
            XCTAssertEqual(request.url?.path, "/api/v1/watch/jobs/\(expected)")
            return (200, [:], try self.data(values["job_status"]!))
        }
        let status = try await api.jobStatus(id: jobID, secret: "test-secret")
        XCTAssertTrue(status.terminal)
        if case .ready(let brief) = try await api.jobBrief(id: jobID, secret: "test-secret") {
            XCTAssertEqual(brief.watchBrief.bullets.count, 1); XCTAssertEqual(brief.sourceCount, 1)
        } else { XCTFail() }
    }
    func testNotReadyBriefAndInvalidJobIDAreNotRenderedAsCompletedResults() async throws {
        let api = try client()
        AskProtocol.handler = { _ in (202, [:], Data("{\"status\":\"not_ready\"}".utf8)) }
        if case .notReady = try await api.jobBrief(id: jobID, secret: "test-secret") {} else { XCTFail() }
        do { _ = try await api.jobStatus(id: "job_../owner", secret: "test-secret"); XCTFail() }
        catch let error as APIError { XCTAssertEqual(error.code, "INVALID_JOB_ID") }
    }
    func testFeedUsesTwentyItemCursorPageAndPreservesMixedTypes() async throws {
        let api = try client()
        AskProtocol.handler = { request in
            let parts = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            XCTAssertEqual(request.httpMethod, "GET"); XCTAssertEqual(parts.path, "/api/v1/watch/feed")
            XCTAssertEqual(parts.queryItems?.first(where: { $0.name == "limit" })?.value, "20")
            XCTAssertEqual(parts.queryItems?.first(where: { $0.name == "cursor" })?.value, "opaque+/=&cursor")
            XCTAssertTrue(parts.percentEncodedQuery?.contains("opaque%2B") == true)
            return (200, [:], Data("{\"schema_version\":\"1\",\"items\":[],\"next_cursor\":null}".utf8))
        }
        let page = try await api.feed(secret: "test-secret", cursor: "opaque+/=&cursor")
        XCTAssertNil(page.nextCursor)
        XCTAssertEqual(ForegroundPolling.delays.reduce(0, +), 55)
    }

    private func meBody(owner: String = "o") -> Data {
        Data("""
        {"schema_version":"1","owner_id":"\(owner)","deployment_id":"d","device_id":"device_1","default_workspace":null,"allowed_workspaces":[],"device_expires_at":"2027-01-01T00:00:00Z","capabilities":{"capture":true,"ask":true,"feed":true}}
        """.utf8)
    }

    @MainActor
    func testResultsRefreshOnlyReadsMeAndTwentyItemFeedEvenWhenAskIsEnabled() async throws {
        let api = try client(), owner = try identity()
        var paths: [String] = []
        AskProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET"); XCTAssertNil(request.httpBody)
            XCTAssertNil(request.value(forHTTPHeaderField: "Idempotency-Key"))
            paths.append(request.url!.path)
            if request.url!.path == "/api/v1/watch/me" { return (200, [:], self.meBody()) }
            XCTAssertEqual(request.url!.path, "/api/v1/watch/feed")
            XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "20")
            return (200, [:], Data("{\"schema_version\":\"1\",\"items\":[],\"next_cursor\":null}".utf8))
        }
        _ = try await ReadOnlyWatchReader.feed(client: api, identity: owner, secret: "test-secret", isCurrent: { true })
        XCTAssertEqual(paths, ["/api/v1/watch/me", "/api/v1/watch/feed"])
    }

    @MainActor
    func testChangedIdentityOrContentClearBetweenReadsPreventsFeedRequest() async throws {
        let api = try client(), owner = try identity()
        var requests = 0, checks = 0
        AskProtocol.handler = { request in
            requests += 1
            XCTAssertEqual(request.url!.path, "/api/v1/watch/me")
            return (200, [:], self.meBody())
        }
        do {
            _ = try await ReadOnlyWatchReader.feed(client: api, identity: owner, secret: "test-secret") {
                checks += 1; return checks == 1
            }
            XCTFail("A local deletion/identity change must fence the next read")
        } catch { XCTAssertEqual(error as? WatchCoreError, .identityChanged) }
        XCTAssertEqual(requests, 1)
        AskProtocol.handler = { _ in requests += 1; return (200, [:], self.meBody(owner: "another-owner")) }
        do {
            _ = try await ReadOnlyWatchReader.feed(client: api, identity: owner, secret: "test-secret", isCurrent: { true })
            XCTFail()
        } catch { XCTAssertEqual(error as? WatchCoreError, .identityChanged) }
        XCTAssertEqual(requests, 2)
    }

    @MainActor
    func testLateFeedResponseAfterContentClearIsRejected() async throws {
        let api = try client(), owner = try identity()
        var checks = 0
        AskProtocol.handler = { request in
            if request.url!.path == "/api/v1/watch/me" { return (200, [:], self.meBody()) }
            return (200, [:], Data("{\"schema_version\":\"1\",\"items\":[],\"next_cursor\":null}".utf8))
        }
        do {
            _ = try await ReadOnlyWatchReader.feed(client: api, identity: owner, secret: "test-secret") {
                checks += 1; return checks < 3
            }
            XCTFail("A response arriving after local clear must not repopulate a cache")
        } catch { XCTAssertEqual(error as? WatchCoreError, .identityChanged) }
        XCTAssertEqual(checks, 3)
    }

    func testFeedPollingOnlyContinuesForPendingAskAndHasBoundedWaits() throws {
        func item(type: String, status: String) throws -> FeedItem {
            try JSONDecoder().decode(FeedItem.self, from: Data("""
            {"id":"item","type":"\(type)","workspace_id":"ws","title":"资料","status":"\(status)","accepted_at":"2026-10-21T09:00:00Z"}
            """.utf8))
        }
        XCTAssertFalse(ForegroundPolling.hasPendingAsk([]))
        XCTAssertFalse(ForegroundPolling.hasPendingAsk([try item(type: "capture", status: "saved")]))
        for status in ["completed", "failed", "cancelled", "needs_attention"] {
            XCTAssertFalse(ForegroundPolling.hasPendingAsk([try item(type: "ask", status: status)]))
        }
        for status in ["queued", "running", "waiting_retry"] {
            XCTAssertTrue(ForegroundPolling.hasPendingAsk([try item(type: "ask", status: status)]))
        }
        XCTAssertEqual(ForegroundPolling.delays, [5, 10, 20, 20])
        XCTAssertLessThanOrEqual(ForegroundPolling.delays.reduce(0, +), 60)
    }
    func testHTTP429PropagatesRetryAfterDeadlineWithoutBodyLeak() async throws {
        let api = try client(), before = Date()
        AskProtocol.handler = { _ in (429, ["Retry-After":"120"], Data("{\"error\":{\"code\":\"RATE_LIMITED\",\"retryable\":true,\"message\":\"private\"}}".utf8)) }
        do { _ = try await api.me(secret: "test-secret"); XCTFail() }
        catch let error as APIError {
            XCTAssertEqual(error.status, 429)
            XCTAssertGreaterThanOrEqual(try XCTUnwrap(error.retryAfterUntil).timeIntervalSince(before), 119)
            XCTAssertFalse(String(describing: error).contains("private"))
        }
    }
}

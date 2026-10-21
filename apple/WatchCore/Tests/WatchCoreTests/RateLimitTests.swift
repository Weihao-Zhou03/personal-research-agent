import Foundation
import XCTest
@testable import WatchCore

final class RateLimitTests: XCTestCase {
    func testDeltaSecondsHTTPDateFallbackAndUpperBound() {
        let now = Date(timeIntervalSince1970: 1_792_576_800)
        XCTAssertEqual(RetryAfter.deadline("120", now: now).timeIntervalSince(now), 120)
        let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        XCTAssertEqual(RetryAfter.deadline(formatter.string(from: now.addingTimeInterval(300)), now: now).timeIntervalSince(now), 300)
        XCTAssertEqual(RetryAfter.deadline("bogus", now: now).timeIntervalSince(now), 60)
        XCTAssertEqual(RetryAfter.deadline(nil, now: now).timeIntervalSince(now), 60)
        XCTAssertEqual(RetryAfter.deadline("999999999999", now: now).timeIntervalSince(now), 86_400)
        XCTAssertEqual(RetryAfter.deadline("0", now: now).timeIntervalSince(now), 1)
    }

    func testOperationWidePauseSurvivesRestartAndKeepsPayloadUnchanged() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let identity = try BackendIdentity(backendOrigin: "https://agent.example.invalid", deploymentID: "d", ownerID: "o")
        let other = try BackendIdentity(backendOrigin: "https://agent.example.invalid", deploymentID: "d", ownerID: "other")
        let now = Date()
        let store = try Outbox(directory: directory)
        let first = try await store.enqueue(text: "第一条", workspace: .init(id: "ws", name: "原空间"), identity: identity)
        let second = try await store.enqueue(text: "第二条", workspace: .init(id: "ws", name: "原空间"), identity: identity)
        _ = try await store.beginAttempt(id: first.id, identity: identity, now: now)
        try await store.recordRateLimit(identity: identity, operation: "capture", until: now.addingTimeInterval(120), now: now)
        let restarted = try Outbox(directory: directory)
        for id in [first.id, second.id] {
            do { _ = try await restarted.beginAttempt(id: id, identity: identity, now: now.addingTimeInterval(119)); XCTFail() }
            catch { XCTAssertEqual(error as? WatchCoreError, .rateLimited) }
        }
        let askPause = await restarted.pauseUntil(identity: identity, operation: "ask", now: now)
        let otherPause = await restarted.pauseUntil(identity: other, operation: "capture", now: now)
        XCTAssertNil(askPause); XCTAssertNil(otherPause)
        let retry = try await restarted.beginAttempt(id: first.id, identity: identity, now: now.addingTimeInterval(121))
        XCTAssertEqual(retry.id, first.id); XCTAssertEqual(retry.requestBody, first.requestBody)
        let retained = await restarted.allItems()
        XCTAssertEqual(retained.first(where: { $0.id == second.id })?.attemptCount, 0)
        XCTAssertEqual(retry.payload.workspaceID, "ws")
    }
}

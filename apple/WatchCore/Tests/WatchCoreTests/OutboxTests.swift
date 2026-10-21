import XCTest
@testable import WatchCore

final class OutboxTests: XCTestCase {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: url) }
        return url
    }
    private func identity(owner: String = "owner_1") throws -> BackendIdentity {
        try BackendIdentity(backendOrigin: "https://agent.example.invalid", deploymentID: "deployment_1", ownerID: owner)
    }
    private let space = Workspace(id: "ws_1", name: "论文阅读")

    func testRestartPreservesExactOriginalPayloadAndID() async throws {
        let dir = try directory(), owner = try identity()
        let first = try Outbox(directory: dir)
        let item = try await first.enqueue(text: "  中文\n不修改原文 😀  ", workspace: space, identity: owner,
            createdAt: Date(timeIntervalSince1970: 1_792_512_000))
        _ = try await first.beginAttempt(id: item.id, identity: owner)
        let restarted = try Outbox(directory: dir)
        let loadedItems = await restarted.allItems()
        let loaded = try XCTUnwrap(loadedItems.first)
        XCTAssertEqual(loaded.id, item.id)
        XCTAssertEqual(loaded.requestBody, item.requestBody)
        XCTAssertEqual(loaded.payload, item.payload)
        XCTAssertEqual(loaded.state, .submissionUnknown)
        XCTAssertEqual(loaded.attemptCount, 1)
        let retry = try await restarted.beginAttempt(id: item.id, identity: owner)
        XCTAssertEqual(retry.requestBody, item.requestBody)
        XCTAssertEqual(retry.payload.workspaceID, "ws_1")
    }

    func testUnknownCannotBeCancelledAndAcknowledgementSurvivesRestart() async throws {
        let dir = try directory(), owner = try identity(), store = try Outbox(directory: dir)
        let item = try await store.enqueue(text: "一条灵感", workspace: space, identity: owner)
        _ = try await store.beginAttempt(id: item.id, identity: owner)
        do { try await store.cancelNeverAttempted(id: item.id); XCTFail("Must not cancel uncertain POST") }
        catch { XCTAssertEqual(error as? WatchCoreError, .invalidState) }
        try await store.acknowledge(id: item.id, identity: owner,
            receipt: .init(captureID: "cap_1", workspaceID: "ws_1", acceptedAt: "2026-10-21T09:00:01Z"))
        let restarted = try Outbox(directory: dir)
        let items = await restarted.allItems()
        XCTAssertEqual(items.first?.serverResourceID, "cap_1")
        XCTAssertEqual(items.first?.state, .acknowledged)
        let count = await restarted.pendingCount()
        XCTAssertEqual(count, 0)
    }

    func testIdentityChangeFreezesOriginalAndCannotAcknowledgeWrongSpace() async throws {
        let store = try Outbox(directory: directory()), owner = try identity()
        let item = try await store.enqueue(text: "不要改投空间", workspace: space, identity: owner)
        do { _ = try await store.beginAttempt(id: item.id, identity: identity(owner: "owner_2")); XCTFail() }
        catch { XCTAssertEqual(error as? WatchCoreError, .identityChanged) }
        _ = try await store.beginAttempt(id: item.id, identity: owner)
        do {
            try await store.acknowledge(id: item.id, identity: owner,
                receipt: .init(captureID: "cap_1", workspaceID: "ws_other", acceptedAt: "2026-10-21T09:00:01Z"))
            XCTFail()
        } catch { XCTAssertEqual(error as? WatchCoreError, .invalidAcknowledgement) }
        let items = await store.allItems()
        XCTAssertEqual(items.first?.state, .submissionUnknown)
    }

    func testClearCacheRetainsEveryUnconfirmedText() async throws {
        let store = try Outbox(directory: directory()), owner = try identity()
        let pending = try await store.enqueue(text: "未传输", workspace: space, identity: owner)
        let unknown = try await store.enqueue(text: "已发送但响应丢失", workspace: space, identity: owner)
        _ = try await store.beginAttempt(id: unknown.id, identity: owner)
        let ack = try await store.enqueue(text: "已确认", workspace: space, identity: owner)
        _ = try await store.beginAttempt(id: ack.id, identity: owner)
        try await store.acknowledge(id: ack.id, identity: owner,
            receipt: .init(captureID: "cap_1", workspaceID: "ws_1", acceptedAt: "2026-10-21T09:00:01Z"))
        try await store.clearAcknowledged()
        let retained = await store.allItems()
        XCTAssertEqual(Set(retained.map(\.id)), Set([pending.id, unknown.id]))
        try await store.cancelNeverAttempted(id: pending.id)
        let afterCancel = await store.allItems()
        XCTAssertEqual(afterCancel.count, 1)
    }

    func testCapacityRejectsNewEntryWithoutOverwritingOriginals() async throws {
        let store = try Outbox(directory: directory()), owner = try identity()
        for i in 0..<100 { _ = try await store.enqueue(text: "笔记\(i)", workspace: space, identity: owner) }
        do { _ = try await store.enqueue(text: "第101条", workspace: space, identity: owner); XCTFail() }
        catch { XCTAssertEqual(error as? WatchCoreError, .capacityReached) }
        let items = await store.allItems()
        XCTAssertEqual(items.count, 100)
        let sizeStore = try Outbox(directory: directory())
        let largeText = String(repeating: "😀", count: 4000)
        for _ in 0..<65 { _ = try await sizeStore.enqueue(text: largeText, workspace: space, identity: owner) }
        do {
            _ = try await sizeStore.enqueue(text: largeText, workspace: space, identity: owner)
            XCTFail()
        } catch { XCTAssertEqual(error as? WatchCoreError, .capacityReached) }
        let count = await sizeStore.pendingCount()
        XCTAssertEqual(count, 65)
        do {
            _ = try await sizeStore.enqueue(text: String(repeating: "中", count: 4001), workspace: space, identity: owner)
            XCTFail()
        } catch { XCTAssertEqual(error as? WatchCoreError, .textTooLong) }
    }

    func testCorruptJournalDoesNotSilentlyResetToEmpty() throws {
        let dir = try directory()
        try Data("{bad json".utf8).write(to: dir.appendingPathComponent("outbox-v1.json"))
        XCTAssertThrowsError(try Outbox(directory: dir))
    }

    func testFailedDiskCommitDoesNotReportSavedInMemory() async throws {
        let dir = try directory(), store = try Outbox(directory: dir)
        // Occupy the journal destination with a directory to force atomic write failure.
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("outbox-v1.json"), withIntermediateDirectories: false)
        do { _ = try await store.enqueue(text: "不能伪报已保存", workspace: space, identity: identity()); XCTFail() }
        catch { /* Expected filesystem failure; do not publish a false local save. */ }
        let items = await store.allItems()
        XCTAssertTrue(items.isEmpty)
    }

    func testHTTPSOriginAndUTF8CredentialHash() throws {
        XCTAssertThrowsError(try BackendIdentity(backendOrigin: "http://example.com", deploymentID: "d", ownerID: "o"))
        XCTAssertThrowsError(try BackendIdentity(backendOrigin: "https://user:pass@example.com", deploymentID: "d", ownerID: "o"))
        XCTAssertThrowsError(try BackendIdentity(backendOrigin: "https://example.com/path", deploymentID: "d", ownerID: "o"))
        XCTAssertEqual(try BackendIdentity(backendOrigin: "https://EXAMPLE.com:443/", deploymentID: "d", ownerID: "o").backendOrigin,
            "https://example.com")
        XCTAssertEqual(CredentialHash.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        // 32-byte Base64URL text: the server hashes these 43 UTF-8 characters, not decoded bytes.
        XCTAssertEqual(CredentialHash.sha256("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
            "0f007385b6f9d4b7eeb2748605afe1a984a0a3bfa3f014d09e2a784ce9e5cd1a")
    }
}

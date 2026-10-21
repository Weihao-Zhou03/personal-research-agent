import Foundation

/// Persistent state machine. A failed disk write never becomes an in-memory success.
public actor Outbox {
    private struct Journal: Codable { let schemaVersion: Int; var items: [OutboxItem] }
    private var journal: Journal
    private let fileURL: URL
    public static let maximumItems = 100
    public static let maximumTextBytes = 1_048_576

    public init(directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        fileURL = directory.appendingPathComponent("outbox-v1.json")
        if FileManager.default.fileExists(atPath: fileURL.path) {
            journal = try JSONDecoder().decode(Journal.self, from: Data(contentsOf: fileURL))
            guard journal.schemaVersion == 1 else { throw WatchCoreError.unsupportedSchema }
            guard Set(journal.items.map(\.id)).count == journal.items.count else { throw WatchCoreError.invalidState }
            for item in journal.items {
                let validatedIdentity = try BackendIdentity(backendOrigin: item.identity.backendOrigin,
                    deploymentID: item.identity.deploymentID, ownerID: item.identity.ownerID)
                let savedPayload = try JSONDecoder().decode(CapturePayload.self, from: item.requestBody)
                guard item.identity == validatedIdentity, item.operation == "capture", item.attemptCount >= 0,
                      savedPayload == item.payload,
                      item.state != .acknowledged || (item.serverResourceID != nil && item.attemptCount > 0),
                      item.attemptCount == 0 || item.state != .pending
                else { throw WatchCoreError.invalidState }
            }
        } else { journal = Journal(schemaVersion: 1, items: []) }
    }

    public func allItems() -> [OutboxItem] { journal.items }
    public func pendingCount() -> Int { journal.items.filter { $0.state != .acknowledged }.count }

    @discardableResult
    public func enqueue(text: String, workspace: Workspace, identity: BackendIdentity,
                        requestID: UUID = UUID(), createdAt: Date = Date()) throws -> OutboxItem {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !workspace.id.isEmpty else { throw WatchCoreError.invalidText }
        guard text.unicodeScalars.count <= 4000 else { throw WatchCoreError.textTooLong }
        guard !journal.items.contains(where: { $0.id == requestID }) else { throw WatchCoreError.duplicateRequest }
        let unsent = journal.items.filter { $0.state != .acknowledged }
        guard unsent.count < Self.maximumItems,
              unsent.reduce(0, { $0 + $1.payload.text.utf8.count }) + text.utf8.count <= Self.maximumTextBytes
        else { throw WatchCoreError.capacityReached }
        let payload = CapturePayload(workspaceID: workspace.id, text: text,
            createdAtClient: ISO8601DateFormatter().string(from: createdAt))
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let item = OutboxItem(clientRequestID: requestID, operation: "capture", identity: identity,
            workspaceNameAtCreation: workspace.name, payload: payload, requestBody: try encoder.encode(payload),
            state: .pending, attemptCount: 0, serverResourceID: nil, lastErrorCode: nil)
        var next = journal; next.items.append(item); try commit(next)
        return item
    }

    /// Call and persist BEFORE beginning POST. Termination at any later point is uncertain delivery.
    public func beginAttempt(id: UUID, identity: BackendIdentity) throws -> OutboxItem {
        guard let index = journal.items.firstIndex(where: { $0.id == id }) else { throw WatchCoreError.missingItem }
        guard journal.items[index].identity == identity else { throw WatchCoreError.identityChanged }
        guard journal.items[index].state != .acknowledged else { throw WatchCoreError.invalidState }
        var next = journal
        next.items[index].state = .submissionUnknown
        next.items[index].attemptCount += 1
        next.items[index].lastErrorCode = nil
        try commit(next)
        return journal.items[index]
    }

    public func acknowledge(id: UUID, identity: BackendIdentity, receipt: CaptureReceipt) throws {
        guard let index = journal.items.firstIndex(where: { $0.id == id }) else { throw WatchCoreError.missingItem }
        let item = journal.items[index]
        guard item.identity == identity else { throw WatchCoreError.identityChanged }
        guard receipt.schemaVersion == "1", receipt.status == "saved", !receipt.captureID.isEmpty,
              receipt.workspaceID == item.payload.workspaceID, item.attemptCount > 0,
              item.serverResourceID == nil || item.serverResourceID == receipt.captureID
        else { throw WatchCoreError.invalidAcknowledgement }
        var next = journal
        next.items[index].state = .acknowledged
        next.items[index].serverResourceID = receipt.captureID
        next.items[index].lastErrorCode = nil
        try commit(next)
    }

    public func recordFailure(id: UUID, code: String, blocked: Bool) throws {
        guard let index = journal.items.firstIndex(where: { $0.id == id }) else { throw WatchCoreError.missingItem }
        guard journal.items[index].state != .acknowledged else { return }
        var next = journal
        next.items[index].state = blocked ? .blocked : .submissionUnknown
        next.items[index].lastErrorCode = code
        try commit(next)
    }

    public func cancelNeverAttempted(id: UUID) throws {
        guard let item = journal.items.first(where: { $0.id == id }) else { throw WatchCoreError.missingItem }
        guard item.state != .acknowledged, item.attemptCount == 0 else { throw WatchCoreError.invalidState }
        var next = journal; next.items.removeAll { $0.id == id }; try commit(next)
    }

    public func clearAcknowledged() throws {
        var next = journal; next.items.removeAll { $0.state == .acknowledged }; try commit(next)
    }

    private func commit(_ next: Journal) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let data = try encoder.encode(next)
        #if os(watchOS) || os(iOS)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
        #else
        try data.write(to: fileURL, options: .atomic)
        #endif
        journal = next
    }
}

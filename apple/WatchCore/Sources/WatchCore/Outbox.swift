import Foundation

/// Persistent state machine. A failed disk write never becomes an in-memory success.
public actor Outbox {
    private struct Pause: Codable { let identity: BackendIdentity; let operation: String; var until: Date }
    private struct Journal: Codable {
        let schemaVersion: Int
        var items: [OutboxItem]
        var pauses: [Pause]
        enum CodingKeys: String, CodingKey { case schemaVersion, items, pauses }
        init(schemaVersion: Int, items: [OutboxItem], pauses: [Pause] = []) {
            self.schemaVersion = schemaVersion; self.items = items; self.pauses = pauses
        }
        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
            items = try values.decode([OutboxItem].self, forKey: .items)
            pauses = try values.decodeIfPresent([Pause].self, forKey: .pauses) ?? []
        }
    }
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
                let bodyMatches: Bool
                if item.operation == "capture" {
                    bodyMatches = try JSONDecoder().decode(CapturePayload.self, from: item.requestBody) == item.payload
                } else if item.operation == "ask" {
                    let ask = try JSONDecoder().decode(AskPayload.self, from: item.requestBody)
                    bodyMatches = ask.workspaceID == item.payload.workspaceID && ask.question == item.payload.text && ask.createdAtClient == item.payload.createdAtClient
                } else { throw WatchCoreError.invalidState }
                guard item.identity == validatedIdentity, item.attemptCount >= 0, bodyMatches,
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
                        requestID: UUID = UUID(), createdAt: Date = Date(), operation: String = "capture") throws -> OutboxItem {
        guard ["capture", "ask"].contains(operation) else { throw WatchCoreError.invalidState }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !workspace.id.isEmpty else { throw WatchCoreError.invalidText }
        guard text.unicodeScalars.count <= (operation == "ask" ? 1000 : 4000) else { throw WatchCoreError.textTooLong }
        guard !journal.items.contains(where: { $0.id == requestID }) else { throw WatchCoreError.duplicateRequest }
        let unsent = journal.items.filter { $0.state != .acknowledged }
        guard unsent.count < Self.maximumItems,
              unsent.reduce(0, { $0 + $1.payload.text.utf8.count }) + text.utf8.count <= Self.maximumTextBytes
        else { throw WatchCoreError.capacityReached }
        let payload = CapturePayload(workspaceID: workspace.id, text: text,
            createdAtClient: ISO8601DateFormatter().string(from: createdAt))
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let body: Data
        if operation == "ask" {
            body = try encoder.encode(AskPayload(workspaceID: payload.workspaceID, question: text, createdAtClient: payload.createdAtClient))
        } else { body = try encoder.encode(payload) }
        let item = OutboxItem(clientRequestID: requestID, operation: operation, identity: identity,
            workspaceNameAtCreation: workspace.name, payload: payload, requestBody: body,
            state: .pending, attemptCount: 0, serverResourceID: nil, lastErrorCode: nil)
        var next = journal; next.items.append(item); try commit(next)
        return item
    }

    /// Call and persist BEFORE beginning POST. Termination at any later point is uncertain delivery.
    public func beginAttempt(id: UUID, identity: BackendIdentity, now: Date = Date()) throws -> OutboxItem {
        guard let index = journal.items.firstIndex(where: { $0.id == id }) else { throw WatchCoreError.missingItem }
        guard journal.items[index].identity == identity else { throw WatchCoreError.identityChanged }
        guard journal.items[index].state != .acknowledged else { throw WatchCoreError.invalidState }
        guard pauseUntil(identity: identity, operation: journal.items[index].operation, now: now) == nil else {
            throw WatchCoreError.rateLimited
        }
        var next = journal
        next.items[index].state = .submissionUnknown
        next.items[index].attemptCount += 1
        next.items[index].lastErrorCode = nil
        try commit(next)
        return journal.items[index]
    }

    public func pauseUntil(identity: BackendIdentity, operation: String, now: Date = Date()) -> Date? {
        journal.pauses.filter { $0.identity == identity && $0.operation == operation && $0.until > now }.map(\.until).max()
    }

    /// Operation-wide, shared by every item and preserved across restart/re-pairing.
    public func recordRateLimit(identity: BackendIdentity, operation: String, until: Date, now: Date = Date()) throws {
        guard ["capture", "ask"].contains(operation), until.timeIntervalSince1970.isFinite else {
            throw WatchCoreError.invalidState
        }
        var next = journal
        next.pauses.removeAll { $0.until <= now }
        let bounded = max(now.addingTimeInterval(1), min(until, now.addingTimeInterval(RetryAfter.maximumDelay)))
        if let index = next.pauses.firstIndex(where: { $0.identity == identity && $0.operation == operation }) {
            next.pauses[index].until = max(next.pauses[index].until, bounded)
        } else { next.pauses.append(Pause(identity: identity, operation: operation, until: bounded)) }
        try commit(next)
    }

    public func acknowledge(id: UUID, identity: BackendIdentity, receipt: CaptureReceipt) throws {
        guard let index = journal.items.firstIndex(where: { $0.id == id }) else { throw WatchCoreError.missingItem }
        let item = journal.items[index]
        guard item.identity == identity else { throw WatchCoreError.identityChanged }
        guard item.operation == "capture", receipt.schemaVersion == "1", receipt.status == "saved", !receipt.captureID.isEmpty,
              receipt.workspaceID == item.payload.workspaceID, item.attemptCount > 0,
              item.serverResourceID == nil || item.serverResourceID == receipt.captureID
        else { throw WatchCoreError.invalidAcknowledgement }
        var next = journal
        next.items[index].state = .acknowledged
        next.items[index].serverResourceID = receipt.captureID
        next.items[index].lastErrorCode = nil
        try commit(next)
    }

    public func acknowledgeAsk(id: UUID, identity: BackendIdentity, receipt: AskReceipt) throws {
        guard let index = journal.items.firstIndex(where: { $0.id == id }) else { throw WatchCoreError.missingItem }
        let item = journal.items[index]
        guard item.identity == identity else { throw WatchCoreError.identityChanged }
        guard item.operation == "ask", receipt.schemaVersion == "1", !receipt.jobID.isEmpty,
              ["queued", "running", "waiting_retry", "completed", "failed", "cancelled", "needs_attention"].contains(receipt.status),
              receipt.workspaceID == item.payload.workspaceID, item.attemptCount > 0,
              item.serverResourceID == nil || item.serverResourceID == receipt.jobID else { throw WatchCoreError.invalidAcknowledgement }
        var next = journal
        next.items[index].state = .acknowledged; next.items[index].serverResourceID = receipt.jobID
        next.items[index].lastErrorCode = nil; try commit(next)
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

    /// Destructive, explicit UI action only. Disconnect/cache cleanup must never call this.
    /// Late acknowledgements cannot recreate removed IDs: acknowledge requires an existing item.
    public func deleteAllLocalContentAfterConfirmation() throws {
        try commit(Journal(schemaVersion: 1, items: [], pauses: []))
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

import Foundation

public enum WatchCoreError: Error, Equatable {
    case invalidOrigin, invalidText, textTooLong, capacityReached, duplicateRequest
    case invalidState, missingItem, identityChanged, invalidAcknowledgement, unsupportedSchema
}

public struct BackendIdentity: Codable, Equatable, Sendable {
    public let backendOrigin: String
    public let deploymentID: String
    public let ownerID: String

    public init(backendOrigin: String, deploymentID: String, ownerID: String) throws {
        guard let parts = URLComponents(string: backendOrigin), parts.scheme == "https",
              let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, ["", "/"].contains(parts.path),
              !deploymentID.isEmpty, !ownerID.isEmpty else { throw WatchCoreError.invalidOrigin }
        var origin = URLComponents()
        origin.scheme = "https"
        origin.host = host.lowercased()
        origin.port = parts.port == 443 ? nil : parts.port
        guard let value = origin.string else { throw WatchCoreError.invalidOrigin }
        self.backendOrigin = value
        self.deploymentID = deploymentID
        self.ownerID = ownerID
    }
}

public struct Workspace: Codable, Equatable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

public struct CapturePayload: Codable, Equatable, Sendable {
    public let workspaceID: String
    public let text: String
    public let createdAtClient: String
    enum CodingKeys: String, CodingKey {
        case workspaceID = "workspace_id", text, createdAtClient = "created_at_client"
    }
    public init(workspaceID: String, text: String, createdAtClient: String) {
        self.workspaceID = workspaceID; self.text = text; self.createdAtClient = createdAtClient
    }
}

public enum OutboxState: String, Codable, Sendable {
    case pending
    case submissionUnknown = "submission_unknown"
    case blocked
    case acknowledged
}

public struct OutboxItem: Codable, Identifiable, Equatable, Sendable {
    public var id: UUID { clientRequestID }
    public let clientRequestID: UUID
    public let operation: String
    public let identity: BackendIdentity
    public let workspaceNameAtCreation: String
    public let payload: CapturePayload
    // Encode once, then retransmit these exact bytes after process restarts.
    public let requestBody: Data
    public internal(set) var state: OutboxState
    public internal(set) var attemptCount: Int
    public internal(set) var serverResourceID: String?
    public internal(set) var lastErrorCode: String?
}

public struct CaptureReceipt: Codable, Equatable, Sendable {
    public let schemaVersion: String
    public let captureID: String
    public let workspaceID: String
    public let status: String
    public let indexStatus: String
    public let acceptedAt: String
    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version", captureID = "capture_id", workspaceID = "workspace_id"
        case status, indexStatus = "index_status", acceptedAt = "accepted_at"
    }
    public init(schemaVersion: String = "1", captureID: String, workspaceID: String, status: String = "saved", indexStatus: String = "pending", acceptedAt: String) {
        self.schemaVersion = schemaVersion; self.captureID = captureID; self.workspaceID = workspaceID
        self.status = status; self.indexStatus = indexStatus; self.acceptedAt = acceptedAt
    }
}

public struct DeviceIdentityResponse: Codable, Sendable {
    public let schemaVersion: String
    public let ownerID: String
    public let deploymentID: String
    public let deviceID: String
    public let defaultWorkspace: Workspace?
    public let allowedWorkspaces: [Workspace]
    public let deviceExpiresAt: String
    public let capabilities: Capabilities
    public struct Capabilities: Codable, Sendable { public let capture: Bool; public let ask: Bool; public let feed: Bool }
    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version", ownerID = "owner_id", deploymentID = "deployment_id"
        case deviceID = "device_id", defaultWorkspace = "default_workspace", allowedWorkspaces = "allowed_workspaces"
        case deviceExpiresAt = "device_expires_at", capabilities
    }
    public func identity(origin: String) throws -> BackendIdentity {
        guard schemaVersion == "1" else { throw WatchCoreError.unsupportedSchema }
        return try BackendIdentity(backendOrigin: origin, deploymentID: deploymentID, ownerID: ownerID)
    }
}

public struct PairingResponse: Codable, Sendable {
    public let schemaVersion: String
    public let pairingID: String
    public let userCode: String?
    public let expiresAt: String
    public let approvalURL: String?
    public let status: String
    public let ownerID: String?
    public let deploymentID: String?
    public let deviceID: String?
    public let defaultWorkspace: Workspace?
    public let allowedWorkspaces: [Workspace]?
    public let deviceExpiresAt: String?
    enum CodingKeys: String, CodingKey {
        case schemaVersion = "schema_version", pairingID = "pairing_id", userCode = "user_code"
        case expiresAt = "expires_at", approvalURL = "approval_url", status
        case ownerID = "owner_id", deploymentID = "deployment_id", deviceID = "device_id"
        case defaultWorkspace = "default_workspace", allowedWorkspaces = "allowed_workspaces", deviceExpiresAt = "device_expires_at"
    }
}

public struct FeedResponse: Codable, Sendable {
    public let schemaVersion: String
    public let items: [FeedItem]
    public let nextCursor: String?
    enum CodingKeys: String, CodingKey { case schemaVersion = "schema_version", items, nextCursor = "next_cursor" }
}
public struct FeedItem: Codable, Identifiable, Sendable {
    public let id: String
    public let type: String
    public let workspaceID: String
    public let title: String
    public let status: String
    public let indexStatus: String?
    public let acceptedAt: String
    enum CodingKeys: String, CodingKey {
        case id, type, workspaceID = "workspace_id", title, status
        case indexStatus = "index_status", acceptedAt = "accepted_at"
    }
}

import Foundation
import Security
import WatchCore

struct ActiveConnection: Codable {
    let secret: String
    let identity: BackendIdentity
    let deviceID: String
    var defaultWorkspace: Workspace?
    var allowedWorkspaces: [Workspace]
    var askAvailable: Bool?
    let expiresAt: String
}

struct PendingPairing: Codable {
    let origin: String
    let requestID: String
    let secret: String
    let deviceName: String
    var pairingID: String?
    var userCode: String?
    var expiresAt: String?
    var approvalURL: String?

    static func create(origin: String) throws -> Self {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw VaultError.unavailable
        }
        let secret = Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return Self(origin: origin, requestID: UUID().uuidString.lowercased(), secret: secret,
            deviceName: "我的 Apple Watch")
    }
    var request: PairingRequest {
        PairingRequest(pairingRequestID: requestID, deviceSecretHash: CredentialHash.sha256(secret), deviceName: deviceName)
    }
}

enum VaultError: Error { case unavailable }

/// Pending and active entries are separate. A failed replacement pairing leaves active intact.
enum DeviceVault {
    private static let service = "personal-research-agent.connection.v1"
    static func load<T: Decodable>(_ type: T.Type, account: String) throws -> T? {
        var query = base(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw VaultError.unavailable }
        return try JSONDecoder().decode(type, from: data)
    }
    static func save<T: Encodable>(_ value: T, account: String) throws {
        let data = try JSONEncoder().encode(value)
        let attrs: [String: Any] = [kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(base(account) as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var insert = base(account); attrs.forEach { insert[$0.key] = $0.value }
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else { throw VaultError.unavailable }
        } else if status != errSecSuccess { throw VaultError.unavailable }
    }
    static func remove(account: String) throws {
        let result = SecItemDelete(base(account) as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw VaultError.unavailable }
    }
    private static func base(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
            kSecAttrAccount as String: account]
    }
}

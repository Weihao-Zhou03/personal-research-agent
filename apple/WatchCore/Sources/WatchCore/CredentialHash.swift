import Foundation
import CryptoKit

public enum CredentialHash {
    /// Hash the UTF-8 Base64URL string, not the original random bytes.
    public static func sha256(_ secret: String) -> String {
        SHA256.hash(data: Data(secret.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

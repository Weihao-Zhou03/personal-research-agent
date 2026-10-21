import Foundation
import SwiftUI
import WatchCore

@MainActor
final class WatchModel: ObservableObject {
    @Published private(set) var active: ActiveConnection?
    @Published private(set) var pending: PendingPairing?
    @Published private(set) var items: [OutboxItem] = []
    @Published private(set) var feed: [FeedItem] = []
    @Published private(set) var feedDate: Date?
    @Published private(set) var nextFeedCursor: String?
    @Published private(set) var jobStatuses: [String: JobStatus] = [:]
    @Published private(set) var briefs: [String: BriefResult] = [:]
    @Published private(set) var jobCacheDate: Date?
    @Published private(set) var message = ""
    @Published private(set) var diagnostic = "尚未连接真实服务"
    @Published private(set) var busy = false
    @Published var selectedWorkspaceID = ""

    let origin: String
    private var outbox: Outbox?
    private let support: URL
    private var foreground = false

    var workspace: Workspace? {
        active?.allowedWorkspaces.first { $0.id == selectedWorkspaceID } ?? active?.defaultWorkspace
    }
    var pendingCount: Int { items.filter { $0.state != .acknowledged }.count }
    var askAvailable: Bool { active?.askAvailable == true }

    init() {
        origin = Bundle.main.object(forInfoDictionaryKey: "APIBaseURL") as? String ?? ""
        support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ResearchAgent", isDirectory: true)
        do {
            outbox = try Outbox(directory: support)
            active = try DeviceVault.load(ActiveConnection.self, account: "active")
            pending = try DeviceVault.load(PendingPairing.self, account: "pending")
            if let connection = active, connection.identity.backendOrigin != (try? APIClient(origin: origin).origin) {
                // Keep the old Keychain record, but do not activate it against a new configured backend.
                active = nil
                message = "服务地址改变，请重新连接。旧原文已冻结。"
            }
            selectedWorkspaceID = active?.defaultWorkspace?.id ?? ""
            loadFeed(); loadJobs()
        } catch { message = "本地保存不可用。请保留应用数据，暂勿卸载。" }
    }

    func setForeground(_ value: Bool) async {
        foreground = value
        await refreshItems()
        if value { await sync() }
    }
    func refreshItems() async { items = await outbox?.allItems() ?? [] }

    func diagnose() async {
        do {
            let result = try await APIClient(origin: origin).diagnostics()
            diagnostic = "服务 \(result.version)\n请求 \(result.requestID)"
        } catch { diagnostic = "服务不可达：\(code(error))" }
    }

    func startPairing() async {
        guard foreground, !busy else { return }; busy = true; defer { busy = false }
        do {
            let client = try APIClient(origin: origin)
            // Retry an existing request after a lost response with identical secret, ID and name.
            var value: PendingPairing
            if let existing = pending { value = existing }
            else { value = try PendingPairing.create(origin: client.origin) }
            guard value.origin == client.origin else { throw WatchCoreError.identityChanged }
            try DeviceVault.save(value, account: "pending")
            pending = value
            let response = try await client.pair(value.request)
            guard pending?.requestID == value.requestID, pending?.secret == value.secret else {
                throw APIError(code: "CONNECTION_CHANGED")
            }
            guard response.schemaVersion == "1" else { throw WatchCoreError.unsupportedSchema }
            value.pairingID = response.pairingID; value.userCode = response.userCode
            value.expiresAt = response.expiresAt
            if let link = response.approvalURL, let url = URL(string: link),
               url.scheme == "https", url.host == URL(string: client.origin)?.host,
               url.port == URL(string: client.origin)?.port { value.approvalURL = link }
            try DeviceVault.save(value, account: "pending"); pending = value
            message = "请在已登录的网页核对并批准。"
            try await applyPairing(response, pending: value)
        } catch { message = "连接未完成：\(code(error))。可安全重试。" }
    }

    func checkPairing() async {
        guard foreground, !busy, let value = pending, let id = value.pairingID else { return }
        busy = true; defer { busy = false }
        do {
            let response = try await APIClient(origin: value.origin).pairingStatus(id: id, secret: value.secret)
            try await applyPairing(response, pending: value)
        } catch { message = "配对状态未确认：\(code(error))" }
    }

    private func applyPairing(_ response: PairingResponse, pending value: PendingPairing) async throws {
        guard self.pending?.requestID == value.requestID, self.pending?.secret == value.secret else {
            throw APIError(code: "CONNECTION_CHANGED")
        }
        guard response.schemaVersion == "1", value.pairingID == nil || value.pairingID == response.pairingID else {
            throw APIError(code: "INVALID_RESPONSE")
        }
        switch response.status {
        case "approved":
            guard let owner = response.ownerID, let deployment = response.deploymentID,
                  let device = response.deviceID, let expires = response.deviceExpiresAt,
                  let allowed = response.allowedWorkspaces else { throw APIError(code: "INVALID_RESPONSE") }
            let identity = try BackendIdentity(backendOrigin: value.origin, deploymentID: deployment, ownerID: owner)
            let next = ActiveConnection(secret: value.secret, identity: identity, deviceID: device,
                defaultWorkspace: response.defaultWorkspace, allowedWorkspaces: allowed, askAvailable: nil, expiresAt: expires)
            try DeviceVault.save(next, account: "active") // Commit identity and secret in a single Keychain update.
            active = next; selectedWorkspaceID = next.defaultWorkspace?.id ?? ""
            feed = []; feedDate = nil; nextFeedCursor = nil; jobStatuses = [:]; briefs = [:]
            loadFeed(); loadJobs()
            try DeviceVault.remove(account: "pending"); pending = nil
            message = "已连接。旧身份的待发送内容继续保留并冻结。"
        case "expired", "denied", "cancelled", "revoked":
            try DeviceVault.remove(account: "pending"); pending = nil
            message = "本次配对已失效，可重新申请；原连接和待发送内容仍保留。"
        case "pending": message = "等待网页批准。"
        default: throw APIError(code: "INVALID_PAIRING_STATUS")
        }
    }

    func saveCapture(_ text: String, operation: String = "capture") async -> Bool {
        guard let active, let workspace, let outbox else { message = "请先连接并选择空间。"; return false }
        guard operation != "ask" || askAvailable else { message = "资料问答暂未就绪，现有待发送问题仍保留。"; return false }
        do {
            _ = try await outbox.enqueue(text: text, workspace: workspace, identity: active.identity, operation: operation)
            await refreshItems()
            message = "已保存在手表，待上传。"
            return true
        } catch { message = "未能保存：\(code(error))"; return false }
    }

    /// Foreground/manual only. Each item is attempted once per invocation; no background promise.
    func sync() async {
        guard foreground, !busy, let active, let outbox else { return }
        busy = true; defer { busy = false }
        do {
            let configuredOrigin = try APIClient(origin: origin).origin
            guard configuredOrigin == active.identity.backendOrigin else { throw WatchCoreError.identityChanged }
            let client = try APIClient(origin: active.identity.backendOrigin)
            let me = try await client.me(secret: active.secret)
            guard isCurrent(active) else { throw APIError(code: "CONNECTION_CHANGED") }
            guard try me.identity(origin: client.origin) == active.identity else { throw WatchCoreError.identityChanged }
            guard me.capabilities.capture else { throw APIError(code: "SCOPE_DENIED", status: 403) }
            var refreshed = active
            refreshed.defaultWorkspace = me.defaultWorkspace; refreshed.allowedWorkspaces = me.allowedWorkspaces
            refreshed.askAvailable = me.capabilities.ask
            try DeviceVault.save(refreshed, account: "active"); self.active = refreshed
            for item in await outbox.allItems() where item.state != .acknowledged && item.identity == active.identity {
                guard foreground, isCurrent(active) else { break }
                if item.operation == "ask" && !me.capabilities.ask { continue }
                if let until = await outbox.pauseUntil(identity: active.identity, operation: item.operation) {
                    message = "服务暂时限流，\(until.formatted(date: .omitted, time: .shortened)) 后可重试。"
                    continue
                }
                guard me.allowedWorkspaces.contains(where: { $0.id == item.payload.workspaceID }) else {
                    try await outbox.recordFailure(id: item.id, code: "WORKSPACE_UNAVAILABLE", blocked: true)
                    continue
                }
                do {
                    let attempt = try await outbox.beginAttempt(id: item.id, identity: active.identity)
                    guard foreground, isCurrent(active) else { throw APIError(code: "CONNECTION_CHANGED") }
                    if item.operation == "ask" {
                        let receipt = try await client.ask(attempt, secret: active.secret)
                        try await outbox.acknowledgeAsk(id: item.id, identity: active.identity, receipt: receipt)
                        message = "问题已提交，稍后查看简报。"
                    } else {
                        let receipt = try await client.capture(attempt, secret: active.secret)
                        try await outbox.acknowledge(id: item.id, identity: active.identity, receipt: receipt)
                        message = "已保存到资料库。"
                    }
                } catch {
                    let api = error as? APIError
                    if api?.status == 429 {
                        try await outbox.recordRateLimit(identity: active.identity, operation: item.operation,
                            until: api?.retryAfterUntil ?? RetryAfter.deadline(nil))
                    }
                    let blocked = api.map { (400..<500).contains($0.status) && $0.status != 429 } ?? false
                    try await outbox.recordFailure(id: item.id, code: code(error), blocked: blocked)
                    message = "提交结果待确认，原文仍在手表。"
                    if api?.status == 401 || api?.retryable == true { break }
                }
            }
            guard foreground, isCurrent(active) else { await refreshItems(); return }
            let result = try await client.feed(secret: active.secret)
            guard isCurrent(active) else { throw APIError(code: "CONNECTION_CHANGED") }
            guard result.schemaVersion == "1" else { throw WatchCoreError.unsupportedSchema }
            feed = result.items; nextFeedCursor = result.nextCursor; feedDate = Date(); try saveFeed(identity: active.identity)
        } catch { message = "尚未同步：\(code(error))。未确认内容继续保留。" }
        await refreshItems()
    }

    func loadMoreFeed() async {
        guard foreground, !busy, let active, let cursor = nextFeedCursor else { return }
        busy = true; defer { busy = false }
        do {
            let client = try APIClient(origin: active.identity.backendOrigin)
            let me = try await client.me(secret: active.secret)
            guard isCurrent(active), try me.identity(origin: client.origin) == active.identity else { throw WatchCoreError.identityChanged }
            let page = try await client.feed(secret: active.secret, cursor: cursor)
            guard isCurrent(active), page.schemaVersion == "1" else { throw WatchCoreError.identityChanged }
            var seen = Set(feed.map(\.id))
            feed.append(contentsOf: page.items.filter { seen.insert($0.id).inserted })
            nextFeedCursor = page.nextCursor; feedDate = Date(); try saveFeed(identity: active.identity)
        } catch { message = "未能继续读取：\(code(error))" }
    }

    func refreshJob(_ jobID: String) async {
        guard foreground, let active else { return }
        do {
            let client = try APIClient(origin: active.identity.backendOrigin)
            let me = try await client.me(secret: active.secret)
            guard foreground, isCurrent(active), try me.identity(origin: client.origin) == active.identity else { throw WatchCoreError.identityChanged }
            let status = try await client.jobStatus(id: jobID, secret: active.secret)
            guard foreground, isCurrent(active) else { return }
            var brief: BriefResult?
            if status.briefReady, case .ready(let value) = try await client.jobBrief(id: jobID, secret: active.secret) { brief = value }
            guard isCurrent(active) else { return }
            jobStatuses[jobID] = status
            if let brief { briefs[jobID] = brief }
            jobCacheDate = Date(); try saveJobs(identity: active.identity)
        } catch { message = "任务状态未更新：\(code(error))，可稍后手动刷新。" }
    }

    func pollJob(_ jobID: String) async {
        let deadline = Date().addingTimeInterval(60)
        await refreshJob(jobID)
        for seconds in ForegroundPolling.delays {
            guard foreground, !Task.isCancelled, Date() < deadline, jobStatuses[jobID]?.terminal != true else { return }
            do { try await Task.sleep(nanoseconds: seconds * 1_000_000_000) } catch { return }
            guard foreground, !Task.isCancelled, Date() < deadline else { return }
            await refreshJob(jobID)
        }
    }

    func cancel(_ item: OutboxItem) async {
        do { try await outbox?.cancelNeverAttempted(id: item.id); await refreshItems() }
        catch { message = "该项目已经尝试提交，请同步核对。" }
    }
    func disconnect() {
        do {
            try DeviceVault.remove(account: "pending"); pending = nil
            try DeviceVault.remove(account: "active"); active = nil; feed = []; feedDate = nil
            nextFeedCursor = nil; jobStatuses = [:]; briefs = [:]; jobCacheDate = nil
            message = "已解除本机连接，待发送原文仍保留。服务端撤销请在网页操作。"
        } catch { message = "无法更改连接，请稍后重试。" }
    }
    func cancelPendingPairing() {
        do {
            try DeviceVault.remove(account: "pending"); pending = nil
            message = "已放弃本次配对，原连接和待发送原文仍保留。"
        } catch { message = "配对请求未能清理，请稍后重试。" }
    }
    func clearCache() async {
        do {
            try await outbox?.clearAcknowledged()
            feed = []; feedDate = nil; nextFeedCursor = nil; jobStatuses = [:]; briefs = [:]; jobCacheDate = nil
            if let active {
                let url = cacheURL(identity: active.identity)
                if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
                let jobs = jobsURL(identity: active.identity)
                if FileManager.default.fileExists(atPath: jobs.path) { try FileManager.default.removeItem(at: jobs) }
            }
            await refreshItems(); message = "已清理已同步缓存；未确认原文已保留。"
        } catch { message = "缓存未能清理；原文仍保留。" }
    }

    private struct FeedCache: Codable { let identity: BackendIdentity; let date: Date; let items: [FeedItem]; let nextCursor: String? }
    private struct JobsCache: Codable {
        let identity: BackendIdentity; let date: Date
        let statuses: [String: JobStatus]; let briefs: [String: BriefResult]
    }
    private func jobsURL(identity: BackendIdentity) -> URL {
        cacheURL(identity: identity).deletingLastPathComponent().appendingPathComponent("jobs-" + cacheURL(identity: identity).lastPathComponent)
    }
    private func loadJobs() {
        guard let active, let data = try? Data(contentsOf: jobsURL(identity: active.identity)),
              let cache = try? JSONDecoder().decode(JobsCache.self, from: data), cache.identity == active.identity else { return }
        jobStatuses = cache.statuses; briefs = cache.briefs; jobCacheDate = cache.date
    }
    private func saveJobs(identity: BackendIdentity) throws {
        let cache = JobsCache(identity: identity, date: jobCacheDate ?? Date(), statuses: jobStatuses, briefs: briefs)
        try JSONEncoder().encode(cache).write(to: jobsURL(identity: identity), options: [.atomic, .completeFileProtection])
    }
    private func isCurrent(_ connection: ActiveConnection) -> Bool {
        active?.identity == connection.identity && active?.secret == connection.secret && active?.deviceID == connection.deviceID
    }
    private func cacheURL(identity: BackendIdentity) -> URL {
        let partition = [identity.backendOrigin, identity.deploymentID, identity.ownerID].joined(separator: "\n")
        return support.appendingPathComponent("feed-v1-\(CredentialHash.sha256(partition)).json")
    }
    private func loadFeed() {
        guard let active, let data = try? Data(contentsOf: cacheURL(identity: active.identity)),
              let cache = try? JSONDecoder().decode(FeedCache.self, from: data),
              cache.identity == active.identity else { return }
        feed = cache.items; feedDate = cache.date; nextFeedCursor = cache.nextCursor
    }
    private func saveFeed(identity: BackendIdentity) throws {
        let cache = FeedCache(identity: identity, date: feedDate ?? Date(), items: feed, nextCursor: nextFeedCursor)
        try JSONEncoder().encode(cache).write(to: cacheURL(identity: identity), options: [.atomic, .completeFileProtection])
    }
    private func code(_ error: Error) -> String {
        if let api = error as? APIError { return api.code }
        if let core = error as? WatchCoreError {
            switch core {
            case .capacityReached: return "待发送已满（最多100条 / 1 MiB），请先同步"
            case .invalidText: return "文字不能为空"
            case .textTooLong: return "单条正文最多4000字，请核对后分条保存"
            case .identityChanged: return "后端或拥有者改变，旧内容已冻结"
            case .invalidOrigin: return "需要配置有效的 HTTPS 服务地址"
            default: return "LOCAL_STATE_UNAVAILABLE"
            }
        }
        return "LOCAL_STORAGE_UNAVAILABLE"
    }
}

import SwiftUI
import WatchCore

@main
@MainActor
struct ResearchWatchApp: App {
    @StateObject private var model = WatchModel()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            HomeView().environmentObject(model)
                .task { await model.setForeground(true) }
                .onChange(of: phase) { _, value in
                    Task { await model.setForeground(value == .active) }
                }
        }
    }
}

struct HomeView: View {
    @EnvironmentObject private var model: WatchModel
    var body: some View {
        NavigationStack {
            List {
                if model.active != nil {
                    Section {
                        Text(model.workspace?.name ?? "请先选择空间").font(.headline)
                        NavigationLink("记灵感", destination: CaptureView())
                            .disabled(model.workspace == nil)
                        NavigationLink("问资料", destination: CaptureView(operation: "ask"))
                            .disabled(model.workspace == nil || !model.askAvailable)
                        NavigationLink("看简报", destination: FeedView())
                        if !model.askAvailable { Text("资料问答暂未就绪").font(.footnote).foregroundStyle(.secondary) }
                    }
                } else {
                    Section { NavigationLink("连接研究资料库", destination: ConnectionView()) }
                }
                if model.pendingCount > 0 {
                    NavigationLink("待发送 · \(model.pendingCount)", destination: OutboxView())
                }
                NavigationLink("设置与连接", destination: SettingsView())
                if !model.message.isEmpty { Text(model.message).font(.footnote).foregroundStyle(.secondary) }
            }
            .navigationTitle("研究随记")
        }.tint(.green)
    }
}

struct CaptureView: View {
    var operation = "capture"
    @EnvironmentObject private var model: WatchModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var confirming = false
    @State private var saving = false
    @State private var reviewedText = ""
    @State private var reviewedWorkspace: Workspace?
    @State private var reviewedIdentity: BackendIdentity?
    @State private var saveError = ""
    private var isAsk: Bool { operation == "ask" }
    private var limit: Int { isAsk ? 1000 : 4000 }
    var body: some View {
        Form {
            Text("空间：\(model.workspace?.name ?? "未选择")").font(.footnote)
            TextField(isAsk ? "输入资料问题" : "输入灵感", text: $text, axis: .vertical)
                .accessibilityLabel(isAsk ? "问题，使用系统文字输入" : "灵感正文，使用系统文字输入")
            if text.unicodeScalars.count > limit { Text("单条最多\(limit)字，请缩短内容").foregroundStyle(.orange) }
            Button("核对并保存") {
                reviewedText = text; reviewedWorkspace = model.workspace; reviewedIdentity = model.active?.identity
                saveError = ""; confirming = true
            }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.unicodeScalars.count > limit)
        }.navigationTitle(isAsk ? "问资料" : "记灵感")
        .sheet(isPresented: $confirming) {
            ScrollView {
                Text(reviewedWorkspace?.name ?? "未选择").font(.headline)
                Text(reviewedText).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical)
                Text(isAsk ? "先保存在手表，再提交研究任务。请稍后查看有来源的简报。" : "先保存在手表，再尝试上传。此条原文不会调用模型。").font(.footnote)
                if !saveError.isEmpty { Text(saveError).font(.footnote).foregroundStyle(.orange) }
                Button("确认保存") {
                    guard !saving, let workspace = reviewedWorkspace, let identity = reviewedIdentity else { return }
                    // Set synchronously before creating the Task so two rapid taps cannot
                    // enter enqueue twice with two independently generated request UUIDs.
                    saving = true
                    let confirmedText = reviewedText
                    Task {
                        defer { saving = false }
                        if await model.saveCapture(confirmedText, operation: operation, workspace: workspace, confirmedIdentity: identity) {
                            confirming = false; dismiss(); await model.sync()
                        } else { saveError = model.message }
                    }
                }.buttonStyle(.borderedProminent).disabled(saving || model.deletingLocalContent)
                Button("返回修改") { confirming = false }.disabled(saving)
            }.padding()
        }
    }
}

struct OutboxView: View {
    @EnvironmentObject private var model: WatchModel
    var body: some View {
        List {
            Button("同步并核对") { Task { await model.sync() } }.disabled(model.busy)
            ForEach(model.items.filter { $0.state != .acknowledged }) { item in
                VStack(alignment: .leading, spacing: 6) {
                    Text(item.workspaceNameAtCreation).font(.headline)
                    Text(item.operation == "ask" ? "资料问题" : "灵感").font(.caption2)
                    Text(item.payload.text)
                    if item.identity != model.active?.identity {
                        Text("原连接的内容，已冻结").foregroundStyle(.orange)
                    } else {
                        Text(item.attemptCount == 0 ? "已保存在手表，待上传" : "提交结果待确认")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if let error = item.lastErrorCode { Text(error).font(.caption2) }
                    if item.attemptCount == 0 {
                        Button("取消此条", role: .destructive) { Task { await model.cancel(item) } }
                    }
                }
            }
        }.navigationTitle("待发送")
    }
}

struct FeedView: View {
    @EnvironmentObject private var model: WatchModel
    var body: some View {
        List {
            Button("刷新") { Task { await model.refreshFeed() } }.disabled(model.busy || model.deletingLocalContent)
            if let date = model.feedDate { Text("缓存更新 \(date.formatted(date: .abbreviated, time: .shortened))").font(.footnote) }
            if model.feed.isEmpty { Text("还没有已同步记录").foregroundStyle(.secondary) }
            ForEach(model.feed) { item in
                if item.type == "ask" {
                    NavigationLink(destination: JobDetailView(jobID: item.id)) {
                        VStack(alignment: .leading) { Text(item.title); Text(jobStateText(item.status)).font(.footnote).foregroundStyle(.secondary) }
                    }
                } else {
                    VStack(alignment: .leading) {
                        Text(item.title)
                        Text(item.status == "saved" ? "已保存到资料库" : item.status).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            if model.nextFeedCursor != nil { Button("更早的记录") { Task { await model.loadMoreFeed() } }.disabled(model.busy) }
        }.navigationTitle("看简报")
        .task(id: model.foreground) { await model.pollFeed() }
    }
}

private func jobStateText(_ status: String) -> String {
    switch status {
    case "queued": return "已接收，等待处理"
    case "running": return "正在处理"
    case "waiting_retry": return "稍后重试"
    case "completed": return "已完成"
    case "failed": return "处理失败"
    case "cancelled": return "已取消"
    case "needs_attention": return "上次调用结果待核对，请到网页查看"
    default: return "等待状态更新"
    }
}

struct JobDetailView: View {
    let jobID: String
    @EnvironmentObject private var model: WatchModel
    var body: some View {
        ScrollView {
            if let brief = model.briefs[jobID] {
                Text(brief.watchBrief.headline).font(.headline)
                if brief.answerStatus == "insufficient_evidence" { Text("资料不足").foregroundStyle(.orange) }
                ForEach(Array(brief.watchBrief.bullets.prefix(3).enumerated()), id: \.offset) { _, bullet in
                    Text(bullet.text).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                }
                Text("来源 \(brief.sourceCount) · 更新 \(brief.updatedAt)").font(.footnote).foregroundStyle(.secondary)
                Text("完整结果与证据请在资料库网页的同一任务中查看。").font(.footnote)
            } else if let status = model.jobStatuses[jobID] {
                Text(jobStateText(status.status))
                if let error = status.error { Text(error.message).font(.footnote) }
                if status.status == "completed" { Text("简报尚未就绪，请稍后刷新。").font(.footnote) }
            } else { Text("尚无缓存，请刷新真实任务状态。") }
            if let date = model.jobReadDates[jobID] { Text("缓存读取时间 \(date.formatted(date: .omitted, time: .shortened))").font(.caption2) }
            Button("刷新") { Task { await model.refreshJob(jobID) } }
            Text("前台短时更新后会停止，可稍后手动查看。").font(.footnote).foregroundStyle(.secondary)
        }.padding().navigationTitle("任务简报")
        .task(id: model.foreground) { await model.pollJob(jobID) }
    }
}

struct ConnectionView: View {
    @EnvironmentObject private var model: WatchModel
    var body: some View {
        List {
            if let pending = model.pending {
                Text(pending.userCode ?? "请求尚未确认").font(.title2.monospaced()).accessibilityLabel("配对码 \(pending.userCode ?? "等待请求")")
                if let expiry = pending.expiresAt { Text("有效期至 \(expiry)").font(.footnote) }
                if let url = pending.approvalURL { Text(url).font(.footnote) }
                Text("在另一块屏幕打开已登录的网页，核对设备名和时间后批准。")
                Button("核对批准状态") { Task { await model.checkPairing() } }.disabled(model.busy)
                Button("重试原请求") { Task { await model.startPairing() } }.disabled(model.busy)
                Button("放弃本次配对", role: .destructive) { model.cancelPendingPairing() }.disabled(model.busy)
            } else {
                Text("连接后可以保存灵感；离线内容会保留在手表。")
                Button("申请连接") { Task { await model.startPairing() } }.disabled(model.busy)
            }
            Text(model.message).font(.footnote)
        }.navigationTitle("连接")
        .task(id: model.pending?.pairingID) {
            // A bounded foreground task. Navigation/background cancels this view task.
            for _ in 0..<12 {
                guard !Task.isCancelled, model.pending != nil else { break }
                try? await Task.sleep(for: .seconds(5))
                guard !Task.isCancelled else { break }
                await model.checkPairing()
            }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var model: WatchModel
    @State private var disconnecting = false
    @State private var deletingContent = false
    var body: some View {
        Form {
            if let active = model.active {
                Picker("当前空间", selection: $model.selectedWorkspaceID) {
                    ForEach(active.allowedWorkspaces) { Text($0.name).tag($0.id) }
                }
                Button("同步") { Task { await model.sync() } }.disabled(model.busy)
            }
            NavigationLink("连接 / 重新配对", destination: ConnectionView())
            Section("服务检查") {
                Text("版本 \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")")
                Text(model.diagnostic).font(.footnote)
                Button("读取真实服务响应") { Task { await model.diagnose() } }
            }
            Button("清理已同步缓存") { Task { await model.clearCache() } }.disabled(model.deletingLocalContent)
            Button("解除本机连接", role: .destructive) { disconnecting = true }.disabled(model.active == nil)
            Text("未确认原文不会被清缓存或重新配对删除。打开应用或点同步时尝试上传。").font(.footnote)
            Button("删除全部本机内容…", role: .destructive) { deletingContent = true }.disabled(model.deletingLocalContent)
        }.navigationTitle("设置")
        .confirmationDialog("解除连接后，待发送原文仍保留。", isPresented: $disconnecting) {
            Button("解除本机连接", role: .destructive) { model.disconnect() }
        }
        .confirmationDialog("永久删除所有连接身份的本机原文与缓存，包括提交结果待确认的内容？已发送内容可能已被服务器接收；此操作不删除或取消服务器任务，连接凭据仍保留。", isPresented: $deletingContent, titleVisibility: .visible) {
            Button("确认删除全部本机内容", role: .destructive) { Task { await model.deleteLocalContentAfterConfirmation() } }
            Button("保留内容", role: .cancel) {}
        }
    }
}

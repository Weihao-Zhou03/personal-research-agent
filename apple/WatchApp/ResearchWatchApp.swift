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
                        NavigationLink("最近记录", destination: FeedView())
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
    @EnvironmentObject private var model: WatchModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var confirming = false
    @State private var saving = false
    var body: some View {
        Form {
            Text("空间：\(model.workspace?.name ?? "未选择")").font(.footnote)
            TextField("输入灵感", text: $text, axis: .vertical)
                .accessibilityLabel("灵感正文，使用系统文字输入")
            if text.unicodeScalars.count > 4000 { Text("单条最多4000字，请分条保存").foregroundStyle(.orange) }
            Button("核对并保存") { confirming = true }
                .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || text.unicodeScalars.count > 4000)
        }.navigationTitle("记灵感")
        .sheet(isPresented: $confirming) {
            ScrollView {
                Text(model.workspace?.name ?? "未选择").font(.headline)
                Text(text).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical)
                Text("先保存在手表，再尝试上传。此条原文不会调用模型。").font(.footnote)
                Button("确认保存") {
                    guard !saving else { return }
                    // Set synchronously before creating the Task so two rapid taps cannot
                    // enter enqueue twice with two independently generated request UUIDs.
                    saving = true
                    let confirmedText = text
                    Task {
                        defer { saving = false }
                        if await model.saveCapture(confirmedText) {
                            confirming = false; dismiss(); await model.sync()
                        }
                    }
                }.buttonStyle(.borderedProminent).disabled(saving)
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
            Button("刷新") { Task { await model.sync() } }.disabled(model.busy)
            if let date = model.feedDate { Text("缓存更新 \(date.formatted(date: .abbreviated, time: .shortened))").font(.footnote) }
            if model.feed.isEmpty { Text("还没有已同步记录").foregroundStyle(.secondary) }
            ForEach(model.feed) { item in
                VStack(alignment: .leading) {
                    Text(item.title)
                    Text(item.status == "saved" ? "已保存到资料库" : item.status).font(.footnote).foregroundStyle(.secondary)
                }
            }
        }.navigationTitle("最近记录")
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
            Button("清理已同步缓存") { Task { await model.clearCache() } }
            Button("解除本机连接", role: .destructive) { disconnecting = true }.disabled(model.active == nil)
            Text("未确认原文不会被清缓存或重新配对删除。打开应用或点同步时尝试上传。").font(.footnote)
        }.navigationTitle("设置")
        .confirmationDialog("解除连接后，待发送原文仍保留。", isPresented: $disconnecting) {
            Button("解除本机连接", role: .destructive) { model.disconnect() }
        }
    }
}

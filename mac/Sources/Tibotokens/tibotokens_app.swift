import AppKit
import Foundation
import SwiftUI
@preconcurrency import UserNotifications

private enum ResetPhase: String, Decodable {
    case none
    case possible
    case scheduled
    case announced

    var statusText: String {
        switch self {
        case .none: "No reset expected"
        case .possible: "Reset might be coming"
        case .scheduled: "Reset in approximately 45 minutes"
        case .announced: "Reset announced"
        }
    }

    var menuBarText: String? {
        switch self {
        case .none: nil
        case .possible: "Reset?"
        case .scheduled: "Reset ~45m"
        case .announced: "Reset"
        }
    }

    var isActive: Bool { self != .none }
}

private struct StatusResponse: Decodable {
    let status: ResetPhase
    let summary: String
    let tweetId: String?
    let tweetText: String?
    let checkedAt: String?
    let resetLikelihood: Int?
    let pollIntervalMinutes: Int?
}

private struct ManualCheckResponse: Decodable {
    let matches: Int
    let status: StatusResponse
}

private struct PollIntervalResponse: Decodable {
    let pollIntervalMinutes: Int
}

@MainActor
private final class StatusModel: ObservableObject {
    @Published private(set) var response: StatusResponse?
    @Published private(set) var manualCheckMessage: String?
    @Published private(set) var isManualCheckRunning = false
    @Published private(set) var pollIntervalMinutes = 15
    @Published private(set) var pollIntervalError: String?
    @Published private(set) var isPollIntervalUpdating = false

    private let statusURL: URL
    private let manualCheckToken: String
    private var pollTask: Task<Void, Never>?
    private var isRefreshing = false
    private var pendingNotificationTweetId: String?

    init() {
        guard let statusURL = Self.configuredStatusURL() else {
            fatalError("TibotokensStatusURL must be a valid HTTPS /status URL or local HTTP /status URL")
        }
        guard let manualCheckToken = Bundle.main.object(
            forInfoDictionaryKey: "TibotokensManualCheckToken"
        ) as? String, manualCheckToken.count >= 32 else {
            fatalError("TibotokensManualCheckToken must be at least 32 characters")
        }
        self.statusURL = statusURL
        self.manualCheckToken = manualCheckToken
    }

    var phase: ResetPhase { response?.status ?? .none }

    var resetLikelihood: Int {
        min(100, max(0, response?.resetLikelihood ?? 0))
    }

    var postText: String? {
        guard let text = response?.tweetText else { return nil }
        return text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    var postURL: URL? {
        guard let id = response?.tweetId,
              !id.isEmpty,
              id.count <= 19,
              id.allSatisfy(\.isNumber)
        else { return nil }
        return URL(string: "https://x.com/thsottiaux/status/\(id)")
    }

    func lastCheckedText(relativeTo now: Date) -> String {
        guard let rawDate = response?.checkedAt,
              let date = Self.parseDate(rawDate)
        else { return "Not checked yet" }
        let relative = Self.relativeDateFormatter.localizedString(for: date, relativeTo: now)
        return "Last checked \(relative)"
    }

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: 60_000_000_000)
            }
        }
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            var request = URLRequest(
                url: statusURL,
                cachePolicy: .reloadIgnoringLocalCacheData,
                timeoutInterval: 10
            )
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, urlResponse) = try await URLSession.shared.data(for: request)
            guard let httpResponse = urlResponse as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode)
            else { return }

            let decoded = try JSONDecoder().decode(StatusResponse.self, from: data)
            if let minutes = decoded.pollIntervalMinutes {
                pollIntervalMinutes = minutes
            }
            let previousPhase = response?.status ?? .none
            if decoded.status != previousPhase {
                pendingNotificationTweetId = decoded.status.isActive ? decoded.tweetId : nil
            } else if pendingNotificationTweetId != decoded.tweetId {
                pendingNotificationTweetId = nil
            }
            response = decoded
            await notifyIfNeeded(decoded)
        } catch {
            // Keep the last successful state and checked time during transient failures.
        }
    }

    func manualCheck(hours: Int) async {
        guard !isManualCheckRunning, hours == 24 || hours == 72 else { return }
        isManualCheckRunning = true
        manualCheckMessage = hours == 24 ? "Checking past 24 hours…" : "Checking past 3 days…"
        defer { isManualCheckRunning = false }

        do {
            var components = URLComponents(url: statusURL, resolvingAgainstBaseURL: false)
            components?.path = "/check"
            components?.queryItems = [URLQueryItem(name: "hours", value: String(hours))]
            guard let url = components?.url else { throw URLError(.badURL) }

            var request = URLRequest(
                url: url,
                cachePolicy: .reloadIgnoringLocalCacheData,
                timeoutInterval: 120
            )
            request.httpMethod = "POST"
            request.setValue("Bearer \(manualCheckToken)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, urlResponse) = try await URLSession.shared.data(for: request)
            guard let httpResponse = urlResponse as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode)
            else { throw URLError(.badServerResponse) }

            let result = try JSONDecoder().decode(ManualCheckResponse.self, from: data)
            response = result.status
            let window = hours == 24 ? "past 24 hours" : "past 3 days"
            if result.matches == 0 {
                manualCheckMessage = "No reset mentions in the \(window)"
            } else {
                let noun = result.matches == 1 ? "mention" : "mentions"
                manualCheckMessage = "Found \(result.matches) reset \(noun) in the \(window)"
            }
        } catch {
            manualCheckMessage = "Manual check failed"
        }
    }

    func setPollInterval(minutes: Int) async {
        guard !isPollIntervalUpdating, minutes == 5 || minutes == 15 || minutes == 30 else { return }
        isPollIntervalUpdating = true
        defer { isPollIntervalUpdating = false }

        do {
            var components = URLComponents(url: statusURL, resolvingAgainstBaseURL: false)
            components?.path = "/poll-interval"
            components?.queryItems = [URLQueryItem(name: "minutes", value: String(minutes))]
            guard let url = components?.url else { throw URLError(.badURL) }

            var request = URLRequest(url: url, timeoutInterval: 10)
            request.httpMethod = "POST"
            request.setValue("Bearer \(manualCheckToken)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let (data, urlResponse) = try await URLSession.shared.data(for: request)
            guard let response = urlResponse as? HTTPURLResponse,
                  (200..<300).contains(response.statusCode)
            else { throw URLError(.badServerResponse) }

            let result = try JSONDecoder().decode(PollIntervalResponse.self, from: data)
            pollIntervalMinutes = result.pollIntervalMinutes
            pollIntervalError = nil
        } catch {
            pollIntervalError = "Couldn’t change poll frequency"
        }
    }

    private func notifyIfNeeded(_ status: StatusResponse) async {
        guard status.status.isActive,
              let tweetId = status.tweetId,
              pendingNotificationTweetId == tweetId
        else { return }
        guard !tweetId.isEmpty,
              tweetId.count <= 19,
              tweetId.allSatisfy(\.isNumber)
        else {
            pendingNotificationTweetId = nil
            return
        }

        var notifiedIds = UserDefaults.standard.stringArray(forKey: "notifiedTweetIds") ?? []
        if notifiedIds.contains(tweetId) {
            pendingNotificationTweetId = nil
            return
        }

        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        let authorised: Bool
        switch settings.authorizationStatus {
        case .authorized, .provisional:
            authorised = true
        case .notDetermined:
            authorised = (try? await center.requestAuthorization(options: [.alert])) ?? false
        default:
            authorised = false
        }
        guard authorised else { return }

        let content = UNMutableNotificationContent()
        content.title = status.status.statusText
        content.body = status.summary
        let request = UNNotificationRequest(
            identifier: "reset-\(tweetId)",
            content: content,
            trigger: nil
        )
        do {
            try await center.add(request)
            notifiedIds.append(tweetId)
            UserDefaults.standard.set(notifiedIds, forKey: "notifiedTweetIds")
            pendingNotificationTweetId = nil
        } catch {
            // Retry on the next successful status fetch.
        }
    }

    private static func configuredStatusURL() -> URL? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "TibotokensStatusURL") as? String,
              let components = URLComponents(string: raw),
              let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(),
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              components.path == "/status"
        else {
            return nil
        }
        if scheme == "https", components.port == nil {
            return components.url
        }
        if scheme == "http", host == "127.0.0.1" || host == "localhost" {
            return components.url
        }
        return nil
    }

    private static func parseDate(_ value: String) -> Date? {
        if let date = isoFormatterWithFractions.date(from: value) {
            return date
        }
        return isoFormatter.date(from: value)
    }

    private static let isoFormatterWithFractions: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let relativeDateFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.dateTimeStyle = .numeric
        formatter.unitsStyle = .full
        return formatter
    }()
}

private struct MenuBarLabel: View {
    let phase: ResetPhase
    let resetLikelihood: Int

    private static let templateIcon: NSImage? = {
        guard let url = Bundle.main.url(forResource: "tibo_menu_icon", withExtension: "png"),
              let image = NSImage(contentsOf: url)
        else { return nil }
        image.isTemplate = true
        image.size = NSSize(width: 18, height: 18)
        return image
    }()

    var body: some View {
        if let image = Self.templateIcon {
            if let text = phase.menuBarText {
                Label {
                    Text(text)
                } icon: {
                    Image(nsImage: image)
                        .renderingMode(.template)
                        .foregroundStyle(resetLikelihood > 50 ? Color.green : Color.primary)
                }
                .accessibilityLabel(phase.statusText)
            } else {
                Image(nsImage: image)
                    .renderingMode(.template)
                    .foregroundStyle(resetLikelihood > 50 ? Color.green : Color.primary)
                    .accessibilityLabel(phase.statusText)
            }
        } else if let text = phase.menuBarText {
            Label(text, systemImage: "person.crop.circle")
                .foregroundStyle(resetLikelihood > 50 ? Color.green : Color.primary)
                .accessibilityLabel(phase.statusText)
        } else {
            Image(systemName: "person.crop.circle")
                .foregroundStyle(resetLikelihood > 50 ? Color.green : Color.primary)
                .accessibilityLabel(phase.statusText)
        }
    }
}

private struct MenuContent: View {
    @ObservedObject var model: StatusModel

    var body: some View {
        Text("Reset likelihood today — \(model.resetLikelihood)%")
            .monospacedDigit()
        Divider()
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text("Tibo’s reset posts — \(model.lastCheckedText(relativeTo: context.date))")
        }
        Divider()
        if let postText = model.postText {
            Text(postText)
                .frame(width: 320, alignment: .leading)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let postURL = model.postURL {
            Button("Open post") {
                NSWorkspace.shared.open(postURL)
            }
        }
        Divider()
        Menu("Manual Check") {
            Button("Past 24 Hours") {
                Task { await model.manualCheck(hours: 24) }
            }
            Button("Past 3 Days") {
                Task { await model.manualCheck(hours: 72) }
            }
        }
        .disabled(model.isManualCheckRunning)
        if let message = model.manualCheckMessage {
            Text(message)
        }
        Menu("Options") {
            Toggle("Poll every 5 minutes", isOn: intervalBinding(5))
            Toggle("Poll every 15 minutes", isOn: intervalBinding(15))
            Toggle("Poll every 30 minutes", isOn: intervalBinding(30))
        }
        .disabled(model.isPollIntervalUpdating)
        if let error = model.pollIntervalError {
            Text(error)
        }
        Divider()
        Button("Quit") {
            NSApplication.shared.terminate(nil)
        }
        .keyboardShortcut("q")
    }

    private func intervalBinding(_ minutes: Int) -> Binding<Bool> {
        Binding(
            get: { model.pollIntervalMinutes == minutes },
            set: { selected in
                guard selected else { return }
                Task { await model.setPollInterval(minutes: minutes) }
            }
        )
    }
}

@main
private struct TibotokensApp: App {
    @StateObject private var model = StatusModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
                .onAppear {
                    Task { await model.refresh() }
                }
        } label: {
            MenuBarLabel(phase: model.phase, resetLikelihood: model.resetLikelihood)
                .task { model.start() }
        }
        .menuBarExtraStyle(.menu)
    }
}

import AppKit
import ApplicationServices
import Darwin
import Foundation

// This process emits only newline-delimited JSON. It never reads keystrokes,
// screen pixels, document contents, or the Accessibility element tree.
private func emit(_ value: [String: Any]) {
    guard var data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    data.append(0x0A)
    data.withUnsafeBytes { buffer in
        guard let address = buffer.baseAddress else { return }
        var offset = 0
        while offset < buffer.count {
            let count = Darwin.write(STDOUT_FILENO, address.advanced(by: offset), buffer.count - offset)
            if count < 0 {
                if errno == EINTR { continue }
                // Exit quietly when the supervising application closes its pipe.
                Darwin.exit(0)
            }
            offset += count
        }
    }
}

private func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("summon-context: \(message)\n").utf8))
    Darwin.exit(64)
}

private func sanitized(_ value: String, limit: Int) -> String {
    let clean = value.components(separatedBy: .controlCharacters).joined(separator: " ")
    return String(clean.prefix(limit)).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func sourceURL(_ value: String) -> String? {
    guard value.utf8.count <= 16_384,
          var parts = URLComponents(string: value),
          let scheme = parts.scheme?.lowercased(), ["http", "https"].contains(scheme),
          let host = parts.host, !host.isEmpty else { return nil }
    parts.scheme = scheme
    parts.user = nil
    parts.password = nil
    parts.query = nil
    parts.fragment = nil
    guard let result = parts.url?.absoluteString, result.utf8.count <= 2_048 else { return nil }
    return result
}

private func metadata(at path: String) -> [String: Any] {
    guard path.hasPrefix("/"), !path.utf8.contains(0) else { return [:] }
    let attribute = "com.apple.metadata:kMDItemWhereFroms"
    let size = getxattr(path, attribute, nil, 0, 0, XATTR_NOFOLLOW)
    guard size > 0, size <= 131_072 else { return [:] }
    var bytes = [UInt8](repeating: 0, count: size)
    let count = bytes.withUnsafeMutableBytes {
        getxattr(path, attribute, $0.baseAddress, $0.count, 0, XATTR_NOFOLLOW)
    }
    guard count > 0, count <= size,
          let plist = try? PropertyListSerialization.propertyList(from: Data(bytes.prefix(count)), options: [], format: nil),
          let values = plist as? [String] else { return [:] }
    // Browsers commonly store the download URL first and its referring page
    // second. Prefer the page, without credentials, query tokens or fragments.
    for value in values.reversed() {
        if let url = sourceURL(value) { return ["sourceUrl": url] }
    }
    return [:]
}

private func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name, &result) == .success else { return nil }
    return result
}

private func localDocumentPath(_ value: CFTypeRef?) -> String? {
    let raw: String
    if let string = value as? String { raw = string }
    else if let url = value as? URL { raw = url.absoluteString }
    else { return nil }
    guard raw.utf8.count <= 8_192, !raw.utf8.contains(0) else { return nil }
    let url: URL
    if raw.hasPrefix("/") {
        url = URL(fileURLWithPath: raw)
    } else {
        guard let parsed = URL(string: raw), parsed.isFileURL,
              parsed.host == nil || parsed.host == "" || parsed.host == "localhost" else { return nil }
        url = parsed
    }
    let path = url.standardizedFileURL.path
    var directory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: path, isDirectory: &directory), !directory.boolValue else { return nil }
    return path
}

private enum ContextVisibility { case collect, hidden, ignored }

private func contextVisibility(bundleID: String?, exclusions: Set<String>) -> ContextVisibility {
    guard let bundleID else { return .hidden }
    if bundleID == "com.summon.companion" { return .ignored }
    return exclusions.contains(bundleID) ? .hidden : .collect
}

private func hiddenActivity(lastFingerprint: inout String?) -> [String: Any]? {
    let hiddenFingerprint = "activity-hidden"
    guard lastFingerprint != hiddenFingerprint else { return nil }
    lastFingerprint = hiddenFingerprint
    return ["type": "activity-hidden"]
}

private final class ActivityWatcher {
    private let includeAccessibility: Bool
    private let exclusions: Set<String>
    private let parentPID = getppid()
    private let dateFormatter = ISO8601DateFormatter()
    private var accessibility = false
    private var lastFingerprint: String?
    private var observer: NSObjectProtocol?
    private var contextTimer: Timer?
    private var healthTimer: Timer?
    private var signals: [DispatchSourceSignal] = []

    init(includeAccessibility: Bool, exclusions: Set<String>) {
        self.includeAccessibility = includeAccessibility
        self.exclusions = exclusions.union(["com.summon.companion"])
        dateFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    }

    func run() {
        // AXIsProcessTrusted checks state only; only request-accessibility can prompt.
        accessibility = AXIsProcessTrusted()
        emit(["type": "permissions", "accessibility": accessibility])
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil, queue: .main
        ) { [weak self] _ in self?.capture() }
        if includeAccessibility {
            contextTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
                self?.capture()
            }
            contextTimer?.tolerance = 0.6
        }
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self else { return }
            if getppid() != self.parentPID { self.stop() }
            let trusted = AXIsProcessTrusted()
            if trusted != self.accessibility {
                self.accessibility = trusted
                self.lastFingerprint = nil
                emit(["type": "permissions", "accessibility": trusted])
                self.capture()
            }
        }
        healthTimer?.tolerance = 1
        for number in [SIGTERM, SIGINT, SIGHUP] {
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .main)
            source.setEventHandler { [weak self] in self?.stop() }
            source.resume()
            signals.append(source)
        }
        capture()
        RunLoop.main.run()
    }

    private func capture() {
        let current = NSWorkspace.shared.frontmostApplication
        switch contextVisibility(bundleID: current.map { $0.bundleIdentifier ?? "" }, exclusions: exclusions) {
        case .hidden:
            if let event = hiddenActivity(lastFingerprint: &lastFingerprint) { emit(event) }
            return
        case .ignored:
            // Emit again on return to the previous app, even with the same title.
            lastFingerprint = nil
            return
        case .collect: break
        }
        guard let app = current, app.processIdentifier != getpid() else { return }
        let bundleID = app.bundleIdentifier ?? ""
        var event: [String: Any] = [
            "type": "activity", "app": sanitized(app.localizedName ?? "Unknown app", limit: 120),
            "bundleId": sanitized(bundleID, limit: 250)
        ]
        if includeAccessibility && accessibility {
            let application = AXUIElementCreateApplication(app.processIdentifier)
            // A non-responsive app must not stall the helper indefinitely.
            AXUIElementSetMessagingTimeout(application, 0.3)
            if let value = attribute(application, kAXFocusedWindowAttribute as CFString),
               CFGetTypeID(value) == AXUIElementGetTypeID() {
                let window = unsafeBitCast(value, to: AXUIElement.self)
                AXUIElementSetMessagingTimeout(window, 0.3)
                if let title = attribute(window, kAXTitleAttribute as CFString) as? String {
                    let clean = sanitized(title, limit: 300)
                    if !clean.isEmpty { event["title"] = clean }
                }
                if let path = localDocumentPath(attribute(window, kAXDocumentAttribute as CFString)) {
                    event["documentPath"] = path
                }
            }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]),
              let fingerprint = String(data: data, encoding: .utf8), fingerprint != lastFingerprint else { return }
        lastFingerprint = fingerprint
        event["at"] = dateFormatter.string(from: Date())
        emit(event)
    }

    private func stop() -> Never {
        if let observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        contextTimer?.invalidate()
        healthTimer?.invalidate()
        signals.forEach { $0.cancel() }
        Darwin.exit(0)
    }
}

#if SUMMON_CONTEXT_TEST
// Compile-only test mode uses synthetic identities. It never connects to
// NSWorkspace, reads another app, or starts an event listener.
let testExclusions: Set<String> = ["com.example.private", "com.summon.companion"]
assert(contextVisibility(bundleID: "com.example.private", exclusions: testExclusions) == .hidden)
assert(contextVisibility(bundleID: nil, exclusions: testExclusions) == .hidden)
assert(contextVisibility(bundleID: "com.summon.companion", exclusions: testExclusions) == .ignored)
assert(contextVisibility(bundleID: "com.example.editor", exclusions: testExclusions) == .collect)
var testFingerprint: String? = "prior-active-app"
assert(hiddenActivity(lastFingerprint: &testFingerprint)?["type"] as? String == "activity-hidden")
assert(hiddenActivity(lastFingerprint: &testFingerprint) == nil)
testFingerprint = "next-active-app"
assert(hiddenActivity(lastFingerprint: &testFingerprint)?.count == 1)
emit(["visibilityChecks": true])
#else
signal(SIGPIPE, SIG_IGN)
let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else { fail("expected watch, permissions, request-accessibility or metadata <absolute-path>") }
switch command {
case "permissions":
    guard arguments.count == 1 else { fail("permissions takes no arguments") }
    emit(["accessibility": AXIsProcessTrusted()])
case "request-accessibility":
    guard arguments.count == 1 else { fail("request-accessibility takes no arguments") }
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    emit(["accessibility": AXIsProcessTrustedWithOptions(options)])
case "metadata":
    guard arguments.count == 2 else { fail("metadata requires one absolute file path") }
    emit(metadata(at: arguments[1]))
case "watch":
    var includeAccessibility = false
    var exclusions = Set<String>()
    var index = 1
    while index < arguments.count {
        switch arguments[index] {
        case "--accessibility": includeAccessibility = true
        case "--exclude":
            index += 1
            guard index < arguments.count else { fail("--exclude requires comma-separated bundle IDs") }
            exclusions.formUnion(arguments[index].split(separator: ",").map {
                $0.trimmingCharacters(in: .whitespacesAndNewlines)
            }.filter { !$0.isEmpty })
        default: fail("unknown watch option")
        }
        index += 1
    }
    let watcher = ActivityWatcher(includeAccessibility: includeAccessibility, exclusions: exclusions)
    withExtendedLifetime(watcher) { watcher.run() }
default:
    fail("unknown command")
}
#endif

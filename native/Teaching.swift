import AppKit
import ApplicationServices
import Foundation
import Darwin

// A private JSON-lines worker, launched only while the user is teaching or
// reusing a procedure. It never logs typed keystrokes. Optional local visual
// reading captures only the selected front window in memory outside recording.
// Only the explicit permission methods prompt. Capture and execution
// are confined to explicit app choices; Enter/Tab/Escape are semantic actions.
private enum TeachingError: Error { case message(String) }
private func problem(_ text: String) -> TeachingError { .message(text) }
private func clean(_ value: String, _ limit: Int = 240) -> String {
    String(value.components(separatedBy: .controlCharacters).joined(separator: " ").prefix(limit)).trimmingCharacters(in: .whitespacesAndNewlines)
}
private func emit(_ value: [String: Any]) {
    guard var bytes = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    bytes.append(10)
    bytes.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { return }
        var offset = 0
        while offset < raw.count {
            let count = Darwin.write(STDOUT_FILENO, base.advanced(by: offset), raw.count - offset)
            if count < 0 { if errno == EINTR { continue }; Darwin.exit(0) }
            offset += count
        }
    }
}
private func attr(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
private func str(_ element: AXUIElement, _ name: String) -> String { attr(element, name) as? String ?? "" }
private func element(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}
private func children(_ value: AXUIElement) -> [AXUIElement] { attr(value, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
private struct PrivacyFields {
    let hidden: Bool; let role: String; let subrole: String; let labels: String; let identifier: String
}
private func privacyFields(_ read: (String) -> (AXError, CFTypeRef?)) -> PrivacyFields? {
    func accepted(_ result: AXError) -> Bool { result == .success || result == .attributeUnsupported || result == .noValue }
    let (hiddenResult, hidden) = read("AXHidden")
    guard accepted(hiddenResult), hidden == nil || hidden is NSNumber else { return nil }
    if hidden as? Bool == true { return PrivacyFields(hidden: true, role: "", subrole: "", labels: "", identifier: "") }
    var values = [String: String]()
    for key in [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel", kAXIdentifierAttribute] {
        let (result, value) = read(key)
        guard accepted(result), value == nil || value is String else { return nil }
        values[key] = (value as? String) ?? ""
    }
    let role = values[kAXRoleAttribute] ?? ""
    guard !role.isEmpty else { return nil }
    var labels = [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel"].map { values[$0] ?? "" }
    if role == kAXStaticTextRole {
        let (result, value) = read(kAXValueAttribute)
        guard accepted(result), value == nil || value is String else { return nil }
        labels.append((value as? String) ?? "")
    }
    return PrivacyFields(hidden: false, role: role, subrole: values[kAXSubroleAttribute] ?? "", labels: labels.joined(separator: " "), identifier: values[kAXIdentifierAttribute] ?? "")
}
private func frameOf(_ item: AXUIElement) -> CGRect? {
    guard let position = attr(item, kAXPositionAttribute), CFGetTypeID(position) == AXValueGetTypeID(),
          let size = attr(item, kAXSizeAttribute), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, dimensions = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
          AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &dimensions),
          dimensions.width > 0, dimensions.height > 0 else { return nil }
    return CGRect(origin: point, size: dimensions)
}
private let blockedApps: Set<String> = ["com.apple.systempreferences", "com.apple.keychainaccess", "com.apple.Passwords", "com.agilebits.onepassword7", "com.1password.1password", "com.bitwarden.desktop", "com.lastpass.LastPass", "com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable", "com.mitchellh.ghostty", "com.github.wez.wezterm", "io.alacritty"]
private func commandTarget(_ bundle: String, _ name: String, _ identifier: String) -> Bool {
    let label = (name + " " + identifier).lowercased()
    if label.range(of: #"\b(terminal|shell|repl|debug.?console|command.?palette|execute.?command|run.?command|evaluate.?expression)\b"#, options: .regularExpression) != nil { return true }
    let editor = ["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders", "com.todesktop.230313mzl4w4u92", "com.jetbrains.intellij", "com.jetbrains.pycharm", "com.jetbrains.WebStorm"].contains(bundle)
    return editor && label.range(of: #"\b(console|command|debugger)\b"#, options: .regularExpression) != nil
}
private func forbiddenNavigation(_ bundle: String, _ name: String, _ value: String) -> Bool {
    let compact = value.lowercased().filter { !$0.isWhitespace }
    if ["javascript:", "vbscript:", "data:"].contains(where: compact.hasPrefix) { return true }
    let browser = ["chrome", "chromium", "safari", "firefox", "brave", "edgemac", "opera", "company.thebrowser.browser"].contains { bundle.lowercased().contains($0) }
    let address = name.lowercased().range(of: #"\b(address|url|location|omnibox)\b"#, options: .regularExpression) != nil
    return (browser || address) && ["chrome:", "chrome-extension:", "edge:", "edge-extension:", "brave:", "opera:", "about:", "file:", "devtools:", "view-source:", "safari-extension:"].contains(where: compact.hasPrefix)
}
private func captureScope(_ bundle: String?, _ name: String?, _ allowed: Set<String>, _ excluded: Set<String>) -> [String: Any] {
    guard let bundle, allowed.contains(bundle), !excluded.contains(bundle), !blockedApps.contains(bundle) else {
        return ["activeInScope": false, "activeApp": NSNull()]
    }
    return ["activeInScope": true, "activeApp": ["bundleId": bundle, "name": clean(name ?? bundle, 120)]]
}
private func sensitive(_ role: String, _ subrole: String, _ name: String) -> Bool {
    if role == "AXSecureTextField" || subrole == "AXSecureTextField" { return true }
    let value = name.lowercased()
    return value.range(of: #"password|passwd|passcode|secure[\s_-]*(text|input|field)|secret|access[\s_-]*token|api[\s_-]*key|credit[\s_-]*card|card[\s_-]*number|social[\s_-]*security|one[\s_-]*time|recovery[\s_-]*code|verification[\s_-]*code|\b(pin|token|cvv|cvc|ssn|otp)\b"#, options: .regularExpression) != nil
}
private func dangerous(_ name: String) -> Bool {
    name.lowercased().range(of: #"\b(send|publish|submit|delete|erase|remove|trash|purchase|buy|checkout|pay|transfer|install|uninstall|allow|grant|authorize|authenticate|login|log.?in|sign.?in|password|security|permission)\b"#, options: .regularExpression) != nil
}
private func nameOf(_ item: AXUIElement, role: String) -> String {
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel"] {
        let candidate = clean(str(item, key))
        if !candidate.isEmpty { return candidate }
    }
    if role == kAXStaticTextRole { return clean(str(item, kAXValueAttribute)) }
    return ""
}
private final class Epoch {
    private let lock = NSLock(); private var number: UInt64 = 0
    func read() -> UInt64 { lock.lock(); defer { lock.unlock() }; return number }
    func advance() { lock.lock(); number += 1; lock.unlock() }
}
private struct Control {
    let id: String; let ref: AXUIElement; let role: String; let name: String
    let identifier: String; let value: String?; let editable: Bool; let actions: [String]
    var target: [String: Any] {
        var out: [String: Any] = ["role": role, "name": name]
        if !identifier.isEmpty { out["identifier"] = identifier }; return out
    }
    var json: [String: Any] {
        var out = target; out["id"] = id; out["editable"] = editable; out["actions"] = actions
        if let value { out["value"] = value }; return out
    }
}
private struct Observation {
    let bundle: String; let surface: [String: Any]; let revision: String; let text: String; let controls: [Control]
    var json: [String: Any] { ["surface": surface, "revision": revision, "text": text, "controls": controls.map(\.json)] }
}
private struct PendingFill { let control: Control; let before: Observation; var after: Observation; var value: String }
private struct PendingAction { let kind: String; let before: Observation; let control: Control; let value: String? }
private final class TapContext {
    weak var owner: Teaching?
    let generation: UInt64
    let serial: UInt64
    init(_ owner: Teaching, _ generation: UInt64, _ serial: UInt64) { self.owner = owner; self.generation = generation; self.serial = serial }
}

private final class Teaching {
    let epoch = Epoch()
    private let parentPID = getppid()
    private var allowed = Set<String>()
    private var excluded = Set<String>(["com.summon.companion"])
    private var cached = [String: Observation]()
    private var visualReading = false
    private var visualStatus = "off"
    private let ocr = TeachingOCRCache()
    private var recording = false, failure: String?, events = [[String: Any]]()
    private var deadline = Date.distantPast, captureEpoch: UInt64 = 0
    private var latest: Observation?, pendingFill: PendingFill?, lastSelected: String?
    private var pendingAction: PendingAction?
    private var lastFocused: AXUIElement?
    private var tap: CFMachPort?, tapSource: CFRunLoopSource?, tapLoop: CFRunLoop?, pollTimer: Timer?
    private var tapContext: TapContext?
    private var clickGeneration: UInt64 = 0
    private var actionSequence: UInt64 = 0
    private var observationCount = 0
    private var activation: NSObjectProtocol?
    private var signals = [DispatchSourceSignal]()

    func start() {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.prohibited)
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.15)
        // The pipe reader invalidates queued actions immediately on cancel,
        // before the main queue can process any more Accessibility requests.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var buffer = Data(); var bytes = [UInt8](repeating: 0, count: 8192)
            while true {
                let count = Darwin.read(STDIN_FILENO, &bytes, bytes.count)
                if count == 0 { Darwin.exit(0) }
                if count < 0 { if errno == EINTR { continue }; Darwin.exit(0) }
                buffer.append(contentsOf: bytes.prefix(count))
                if buffer.count > 1_000_000 { Darwin.exit(64) }
                while let newline = buffer.firstIndex(of: 10) {
                    let line = buffer.subdata(in: 0..<newline); buffer.removeSubrange(0...newline)
                    guard let request = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                          let id = request["id"] as? Int, let method = request["method"] as? String,
                          let self else { Darwin.exit(64) }
                    if method == "cancel" { self.epoch.advance() }
                    let generation = self.epoch.read()
                    DispatchQueue.main.async { self.respond(id, method, request["params"] as? [String: Any] ?? [:], generation) }
                }
            }
        }
        for sig in [SIGTERM, SIGINT, SIGHUP] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler { [weak self] in self?.disarm(); Darwin.exit(0) }; source.resume(); signals.append(source)
        }
        Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self else { return }
            if getppid() != self.parentPID { self.disarm(); Darwin.exit(0) }
        }.tolerance = 0.2
        RunLoop.main.run()
    }
    private func check(_ generation: UInt64) throws {
        guard generation == epoch.read() else { throw problem("Desktop teaching cancelled.") }
    }
    private func app(_ bundle: String) throws -> NSRunningApplication {
        guard allowed.contains(bundle), !excluded.contains(bundle), !blockedApps.contains(bundle) else { throw problem("This app was not selected for the demonstration.") }
        // A bundle may briefly have an older, windowless process after an app
        // update or relaunch. Prefer the active instance, then the most recent
        // visible regular instance rather than blindly choosing the first PID.
        let candidates = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { !$0.isTerminated && $0.activationPolicy == .regular }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let ordered = candidates.sorted {
            if ($0.processIdentifier == front) != ($1.processIdentifier == front) { return $0.processIdentifier == front }
            if $0.isHidden != $1.isHidden { return !$0.isHidden }
            return ($0.launchDate ?? .distantPast) > ($1.launchDate ?? .distantPast)
        }
        guard let running = ordered.first else { throw problem("The selected app is not running.") }
        return running
    }
    private func visualReadingBlock(_ window: AXUIElement, _ bundle: String, _ generation: UInt64) throws -> String? {
        // Incomplete/slow trees cannot establish the absence of exposed secure
        // controls. Skip the entire image, including apparently unrelated areas.
        let started = Date(); var queue = [window], seen = [AXUIElement]()
        while !queue.isEmpty && seen.count < 600 {
            try check(generation)
            if Date().timeIntervalSince(started) > 1 { return "skipped-incomplete" }
            let item = queue.removeFirst()
            if seen.contains(where: { CFEqual($0, item) }) { continue }; seen.append(item)
            AXUIElementSetMessagingTimeout(item, 0.05)
            guard let fields = privacyFields({ key in
                var value: CFTypeRef?
                let result = AXUIElementCopyAttributeValue(item, key as CFString, &value)
                return (result, value)
            }) else { return "skipped-incomplete" }
            if fields.hidden { continue }
            guard !sensitive(fields.role, fields.subrole, fields.labels + " " + fields.identifier), !commandTarget(bundle, fields.labels, fields.identifier) else { return "skipped-sensitive" }
            var descendants: CFTypeRef?
            let result = AXUIElementCopyAttributeValue(item, kAXChildrenAttribute as CFString, &descendants)
            guard result == .success || result == .attributeUnsupported || result == .noValue else { return "skipped-incomplete" }
            let next = descendants as? [AXUIElement] ?? []
            guard next.count <= 600 else { return "skipped-incomplete" }; queue.append(contentsOf: next)
        }
        return queue.isEmpty ? nil : "skipped-incomplete"
    }
    private func snapshot(_ bundle: String, _ generation: UInt64, settleWindow: Bool = false) throws -> Observation {
        let started = Date()
        try check(generation)
        guard AXIsProcessTrusted() else { throw problem("Enable Accessibility for Summon in System Settings, then try again.") }
        let running = try app(bundle), root = AXUIElementCreateApplication(running.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.3)
        var foundWindow: AXUIElement?
        repeat {
            try check(generation)
            foundWindow = element(attr(root, kAXFocusedWindowAttribute)) ?? element(attr(root, kAXMainWindowAttribute)) ?? (attr(root, kAXWindowsAttribute) as? [AXUIElement])?.first
            if foundWindow != nil || !settleWindow || Date().timeIntervalSince(started) >= 1.2 { break }
            // Read-only settling: never repeat activation or a control action.
            usleep(60_000)
        } while Date().timeIntervalSince(started) < 1.2
        guard let window = foundWindow else {
            throw problem("The selected app has no accessible window. Open a window and try again.")
        }
        AXUIElementSetMessagingTimeout(window, 0.3)
        let title = clean(str(window, kAXTitleAttribute), 300), revision = UUID().uuidString
        var queue = [window], seen = [AXUIElement](), controls = [Control](), texts = [String](), textCount = 0
        var sensitiveContent = sensitive(kAXWindowRole, "", title)
        if let menu = element(attr(root, kAXMenuBarAttribute)) { queue.append(menu) }
        while !queue.isEmpty && seen.count < 400 && controls.count < 100 {
            try check(generation)
            if Date().timeIntervalSince(started) > 3 { throw problem("The selected app is responding too slowly to inspect safely.") }
            let item = queue.removeFirst()
            if seen.contains(where: { CFEqual($0, item) }) { continue }; seen.append(item)
            AXUIElementSetMessagingTimeout(item, 0.08)
            if (attr(item, "AXHidden") as? Bool) == true { continue }
            let role = str(item, kAXRoleAttribute), name = nameOf(item, role: role), subrole = str(item, kAXSubroleAttribute)
            let identifier = clean(str(item, kAXIdentifierAttribute))
            if sensitive(role, subrole, name + " " + identifier) || commandTarget(bundle, name, identifier) { sensitiveContent = true; continue }
            let enabled = (attr(item, kAXEnabledAttribute) as? Bool) != false
            var settable: DarwinBoolean = false
            let editableRole = [kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole].contains(role)
            let editable = enabled && editableRole && AXUIElementIsAttributeSettable(item, kAXValueAttribute as CFString, &settable) == .success && settable.boolValue
            var actionNames: CFArray?
            _ = AXUIElementCopyActionNames(item, &actionNames)
            let nativeActions = actionNames as? [String] ?? []
            var actions = [String]()
            if enabled && !dangerous(name) {
                if editable { actions.append("fill") }
                if nativeActions.contains(kAXPressAction) { actions.append("click") }
                if editable || nativeActions.contains(kAXConfirmAction) { actions.append("press") }
            }
            let rawValue = str(item, kAXValueAttribute)
            let value = editable ? String(rawValue.prefix(1200)) : nil
            // Capture useful visible text, not AXHelp or document URLs/paths.
            for candidate in [name, editable ? (value ?? "") : (role == kAXStaticTextRole ? clean(rawValue, 500) : "")] where !candidate.isEmpty {
                if textCount < 6000 && !texts.contains(candidate) { let kept = String(candidate.prefix(6000 - textCount)); texts.append(kept); textCount += kept.count }
            }
            if editable || !nativeActions.isEmpty || [kAXButtonRole, kAXCheckBoxRole, kAXRadioButtonRole, kAXPopUpButtonRole, kAXMenuItemRole, "AXLink"].contains(role) {
                controls.append(Control(id: "c\(controls.count + 1)", ref: item, role: role, name: name, identifier: identifier, value: value, editable: editable, actions: actions))
            }
            queue.append(contentsOf: children(item).prefix(200))
        }
        var visualLines = [TeachingOCRLine]()
        if visualReading && !recording {
            do {
                try TeachingOCRCapture.requirePermission()
                guard NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier else {
                    throw problem("Bring the selected app to the front before using visual reading.")
                }
                var blocked: String? = sensitiveContent ? "skipped-sensitive" : nil
                if blocked == nil { blocked = try visualReadingBlock(window, bundle, generation) }
                if blocked == nil {
                    guard let frame = frameOf(window),
                          let identity = teachingOCRWindowIdentity(teachingOCRWindows(), process: running.processIdentifier, frame: frame, title: title) else {
                        throw problem("The selected front window could not be matched safely for visual reading.")
                    }
                    let selectedPID = running.processIdentifier
                    let visualIsCurrent = {
                        teachingOCRScopeCurrent(process: selectedPID, foreground: NSWorkspace.shared.frontmostApplication?.processIdentifier,
                                                generation: generation, currentGeneration: self.epoch.read())
                    }
                    let image = try TeachingOCRCapture.image(identity: identity, isCurrent: visualIsCurrent)
                    // A secure field or another document may have appeared while
                    // ScreenCaptureKit was preparing the image. Discard it before
                    // OCR if the current AX scope no longer passes the same check.
                    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == running.processIdentifier,
                          element(attr(root, kAXFocusedWindowAttribute)).map({ CFEqual($0, window) }) == true,
                          frameOf(window).map({ teachingOCRSameFrame($0, frame) }) == true,
                          clean(str(window, kAXTitleAttribute), 300) == title else {
                        throw problem("The selected front window changed during visual reading. Inspect it again.")
                    }
                    let afterBlock = try visualReadingBlock(window, bundle, generation)
                    if afterBlock == nil {
                        visualLines = try ocr.read(image, identity: identity, isCurrent: visualIsCurrent)
                        visualStatus = "ready"
                        if visualLines.contains(where: { sensitive("", "", $0.text) || commandTarget(bundle, $0.text, "") }) {
                            visualLines = []; ocr.reset(); visualStatus = "skipped-sensitive"
                        }
                        // OCR may clarify an AX action's label, but it cannot add
                        // a control or grant any action the AX server did not expose.
                        let candidateFrames = controls.compactMap { control -> CGRect? in
                            guard !control.actions.isEmpty else { return nil }
                            return frameOf(control.ref)?.offsetBy(dx: -frame.minX, dy: -frame.minY)
                        }
                        controls = controls.map { control in
                            guard control.name.isEmpty, !control.actions.isEmpty,
                                  let screenFrame = frameOf(control.ref),
                                  let label = teachingOCRLabel(visualLines, frame: screenFrame.offsetBy(dx: -frame.minX, dy: -frame.minY), candidateFrames: candidateFrames) else { return control }
                            let blocked = sensitive(control.role, "", label + " " + control.identifier) || commandTarget(bundle, label, control.identifier)
                            let actions = blocked || dangerous(label) ? [] : control.actions
                            return Control(id: control.id, ref: control.ref, role: control.role, name: label, identifier: control.identifier, value: blocked ? nil : control.value, editable: blocked ? false : control.editable, actions: actions)
                        }
                    } else { ocr.reset(); visualStatus = afterBlock! }
                } else { ocr.reset(); visualStatus = blocked! }
            } catch {
                ocr.reset(); visualStatus = "error"
                if let error = error as? TeachingOCRError { throw problem(error.message) }
                throw error
            }
        }
        let result = Observation(bundle: bundle, surface: ["kind": "desktop", "bundleId": bundle, "app": clean(running.localizedName ?? bundle, 120), "title": title], revision: revision, text: visualLines.isEmpty ? texts.joined(separator: "\n") : teachingOCRMerge(texts, visualLines), controls: controls)
        cached[bundle] = result; return result
    }
    private func append(_ kind: String, _ before: Observation, _ after: Observation, _ target: Control? = nil, _ value: String? = nil) {
        guard recording, failure == nil else { return }
        guard events.count < 40 else { failRecording("The demonstration exceeded 40 actions. Teach a shorter procedure."); return }
        var event: [String: Any] = ["kind": kind, "surface": after.surface, "before": before.json, "after": after.json]
        if let target { event["target"] = target.target }; if let value { event["value"] = value }; events.append(event)
        if (try? JSONSerialization.data(withJSONObject: events).count) ?? Int.max > 850_000 {
            failRecording("The demonstration contains too much page content. Teach a shorter procedure.")
        }
    }
    private func flushFill() {
        guard let pending = pendingFill else { return }; pendingFill = nil
        append("fill", pending.before, pending.after, pending.control, pending.value)
    }
    private func observeFills(_ observation: Observation) {
        guard let previous = latest, previous.bundle == observation.bundle else { return }
        guard let running = try? app(observation.bundle) else { return }
        let root = AXUIElementCreateApplication(running.processIdentifier)
        AXUIElementSetMessagingTimeout(root, 0.08)
        let focused = element(attr(root, kAXFocusedUIElementAttribute))
        defer { lastFocused = focused }
        for control in observation.controls where control.editable && ((focused.map { CFEqual($0, control.ref) } ?? false) || (lastFocused.map { CFEqual($0, control.ref) } ?? false)) {
            guard let beforeControl = previous.controls.first(where: { CFEqual($0.ref, control.ref) }), let value = control.value, value != beforeControl.value else { continue }
            if str(control.ref, kAXValueAttribute).count > 1200 { failRecording("A demonstrated field exceeded 1,200 characters. Teach a shorter value."); return }
            if forbiddenNavigation(observation.bundle, control.name, value) { failRecording("Executable or browser-internal URLs cannot be learned as desktop actions."); return }
            if let pending = pendingFill, CFEqual(pending.control.ref, control.ref) { pendingFill?.after = observation; pendingFill?.value = value }
            else { flushFill(); pendingFill = PendingFill(control: control, before: previous, after: observation, value: value) }
        }
    }
    private func flushFocused() {
        // Catch the final characters before a following click, without reading
        // keyboard events or depending on the polling interval.
        guard let before = latest, let focused = lastFocused,
              let control = before.controls.first(where: { $0.editable && CFEqual($0.ref, focused) }) else { flushFill(); return }
        let value = str(focused, kAXValueAttribute)
        guard value.count <= 1200 else { failRecording("A demonstrated field exceeded 1,200 characters. Teach a shorter value."); return }
        guard !forbiddenNavigation(before.bundle, control.name, value) else { failRecording("Executable or browser-internal URLs cannot be learned as desktop actions."); return }
        if value != control.value {
            let updated = Control(id: control.id, ref: control.ref, role: control.role, name: control.name, identifier: control.identifier, value: value, editable: control.editable, actions: control.actions)
            let after = Observation(bundle: before.bundle, surface: before.surface, revision: UUID().uuidString, text: before.text, controls: before.controls.map { $0.id == control.id ? updated : $0 })
            if let pending = pendingFill, CFEqual(pending.control.ref, focused) { pendingFill?.after = after; pendingFill?.value = value }
            else { flushFill(); pendingFill = PendingFill(control: updated, before: before, after: after, value: value) }
            latest = after
        }
        flushFill()
    }
    private func flushAction() {
        guard let pending = pendingAction else { return }; pendingAction = nil
        guard let frontmost = NSWorkspace.shared.frontmostApplication?.bundleIdentifier, allowed.contains(frontmost), !excluded.contains(frontmost) else {
            failRecording("The app changed before the last action could be observed. Please teach the final action again."); return
        }
        do {
            // Observe the app of the recorded action, even if a following
            // app activation arrived before its deferred observation.
            let after = try snapshot(pending.before.bundle, captureEpoch)
            append(pending.kind, pending.before, after, pending.control, pending.value)
            latest = after
        } catch { failRecording("Could not capture the result of the demonstrated action. Please teach it again.") }
    }
    private func poll() {
        guard recording else { return }
        guard captureEpoch == epoch.read() else { disarm(); return }
        if Date() >= deadline { failRecording("The demonstration exceeded five minutes. Teach a shorter procedure."); return }
        guard let bundle = NSWorkspace.shared.frontmostApplication?.bundleIdentifier, allowed.contains(bundle), !excluded.contains(bundle) else {
            // No Accessibility reads while another app (including Summon) is in front.
            flushFill(); return
        }
        if pendingAction != nil { flushAction(); if !recording { return } }
        if lastSelected != bundle { flushFocused(); if !recording { return } }
        do {
            let observation = try snapshot(bundle, captureEpoch)
            observationCount += 1
            if lastSelected != bundle {
                flushFill(); append("activate", latest ?? observation, observation); lastSelected = bundle
                let root = AXUIElementCreateApplication((try app(bundle)).processIdentifier)
                AXUIElementSetMessagingTimeout(root, 0.08); lastFocused = element(attr(root, kAXFocusedUIElementAttribute))
            } else { observeFills(observation) }
            latest = observation
        } catch { failRecording((error as? TeachingError).map(message) ?? "Could not inspect the selected app.") }
    }
    private func message(_ error: TeachingError) -> String { switch error { case .message(let value): return value } }
    private func failRecording(_ error: String) { failure = error; disarm() }
    private func disarm() {
        recording = false; clickGeneration += 1; pendingFill = nil; pendingAction = nil; lastFocused = nil
        pollTimer?.invalidate(); pollTimer = nil
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }; activation = nil
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }; tap = nil
        if let tapSource, let tapLoop { CFRunLoopRemoveSource(tapLoop, tapSource, .commonModes) }
        if let tapLoop { CFRunLoopStop(tapLoop) }; tapSource = nil; tapLoop = nil
        // An in-flight passive callback on its own run loop may still retain
        // the context address for a moment after the port is invalidated.
        let previous = tapContext; tapContext = nil
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { _ = previous }
    }
    private func mouse(_ location: CGPoint) {
        guard recording, captureEpoch == epoch.read(), let bundle = NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
              allowed.contains(bundle), !excluded.contains(bundle) else { return }
        flushAction(); guard recording else { return }
        // Use the most recent pre-click tree. No coordinate is persisted or replayed.
        guard let before = latest, before.bundle == bundle else { poll(); return }
        let system = AXUIElementCreateSystemWide(); AXUIElementSetMessagingTimeout(system, 0.08)
        var hit: AXUIElement?
        guard AXUIElementCopyElementAtPosition(system, Float(location.x), Float(location.y), &hit) == .success,
              var item = hit else { return }
        var target: Control?
        for _ in 0..<7 {
            if let matched = before.controls.first(where: { CFEqual($0.ref, item) }) { target = matched; break }
            guard let parent = element(attr(item, kAXParentAttribute)) else { break }; item = parent
        }
        guard let target else { return }
        if dangerous(target.name) { failRecording("This demonstration included a sensitive or consequential control. That action cannot be learned."); return }
        // Focusing a text field is represented by the subsequent fill action.
        if target.editable { flushFocused(); lastFocused = target.ref; return }
        guard target.actions.contains("click") else { return }
        flushFocused()
        guard recording else { return }
        pendingAction = PendingAction(kind: "click", before: latest ?? before, control: target, value: nil)
        actionSequence += 1
        let click = clickGeneration, generation = captureEpoch, sequence = actionSequence
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
            guard let self, self.recording, self.captureEpoch == generation, self.clickGeneration == click, self.actionSequence == sequence else { return }
            self.flushAction()
        }
    }
    private func key(_ value: String) {
        guard recording, captureEpoch == epoch.read(), let bundle = NSWorkspace.shared.frontmostApplication?.bundleIdentifier,
              allowed.contains(bundle), !excluded.contains(bundle) else { return }
        flushAction(); flushFocused(); guard recording, let before = latest, before.bundle == bundle else { return }
        guard let focused = lastFocused, let target = before.controls.first(where: { CFEqual($0.ref, focused) }), target.actions.contains("press") else {
            failRecording("That keyboard action has no supported focused control. Use the visible control and teach it again."); return
        }
        if dangerous(target.name) || (value == "Enter" && target.role == kAXTextAreaRole) {
            failRecording("That keyboard action may submit private content. Use a supported visible control instead."); return
        }
        pendingAction = PendingAction(kind: "press", before: before, control: target, value: value)
        actionSequence += 1; let generation = captureEpoch, sequence = actionSequence
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) { [weak self] in
            guard let self, self.recording, self.captureEpoch == generation, self.actionSequence == sequence else { return }; self.flushAction()
        }
    }
    private func configure(_ params: [String: Any]) throws -> [String: Any] {
        guard let choices = params["allowedApps"] as? [String], !choices.isEmpty, choices.count <= 12,
              choices.allSatisfy({ $0.count <= 250 && $0.range(of: #"^[A-Za-z0-9][A-Za-z0-9.-]+$"#, options: .regularExpression) != nil && !blockedApps.contains($0) && $0 != "com.summon.companion" }) else { throw problem("Choose between one and twelve supported apps.") }
        if let value = params["visualReading"], !(value is Bool) { throw problem("Visual reading must be enabled or disabled explicitly.") }
        disarm(); allowed = Set(choices); visualReading = params["visualReading"] as? Bool ?? false; visualStatus = visualReading ? "ready" : "off"; ocr.reset()
        excluded = Set((params["excludedApps"] as? [String] ?? [])).union(["com.summon.companion"])
        cached.removeAll(); return ["allowedApps": allowed.sorted(), "visualReading": visualReading]
    }
    private func begin(_ params: [String: Any], _ generation: UInt64) throws -> [String: Any] {
        _ = try configure(params)
        guard AXIsProcessTrusted() else { throw problem("Enable Accessibility for Summon in System Settings, then try again.") }
        guard CGPreflightListenEventAccess() else { throw problem("Enable Input Monitoring for Summon in System Settings, then try again.") }
        for bundle in allowed { _ = try app(bundle) }
        events = []; failure = nil; latest = nil; pendingFill = nil; lastSelected = nil; observationCount = 0
        captureEpoch = generation; deadline = Date().addingTimeInterval(300)
        let mask = CGEventMask((1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.keyDown.rawValue))
        let registration = TapContext(self, generation, clickGeneration); tapContext = registration
        let context = Unmanaged.passUnretained(registration).toOpaque()
        guard let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: { _, type, event, opaque in
            guard let opaque else { return Unmanaged.passUnretained(event) }
            let registration = Unmanaged<TapContext>.fromOpaque(opaque).takeUnretainedValue()
            guard let owner = registration.owner, owner.epoch.read() == registration.generation else { return Unmanaged.passUnretained(event) }
            let generation = registration.generation, serial = registration.serial
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                DispatchQueue.main.async { if owner.captureEpoch == generation && owner.clickGeneration == serial { owner.failRecording("macOS stopped the demonstration monitor. Please start a new demonstration.") } }
            } else if type == .leftMouseDown {
                let point = event.location; DispatchQueue.main.async { if owner.captureEpoch == generation && owner.clickGeneration == serial { owner.mouse(point) } }
            } else if type == .keyDown && event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty {
                // Read only a small whitelist of control keys. Never call
                // keyboardGetUnicodeString or retain other key codes.
                let key: String?
                switch event.getIntegerValueField(.keyboardEventKeycode) { case 36, 76: key = "Enter"; case 48: key = "Tab"; case 53: key = "Escape"; default: key = nil }
                if let key { DispatchQueue.main.async { if owner.captureEpoch == generation && owner.clickGeneration == serial { owner.key(key) } } }
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: context) else { throw problem("macOS could not start demonstration capture. Check Input Monitoring permission.") }
        tap = created; tapSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
        recording = true
        let source = tapSource!
        let ready = DispatchSemaphore(value: 0)
        // The passive event callback runs away from AX inspection; an app with
        // a slow accessibility server cannot make the event tap time out.
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self, self.epoch.read() == generation, self.clickGeneration == registration.serial, CFMachPortIsValid(created) else { ready.signal(); return }
            let loop = CFRunLoopGetCurrent(); self.tapLoop = loop
            CFRunLoopAddSource(loop, source, .commonModes); CGEvent.tapEnable(tap: created, enable: true)
            ready.signal()
            CFRunLoopRun()
        }
        guard ready.wait(timeout: .now() + 1) == .success, tapLoop != nil, epoch.read() == generation else {
            disarm(); throw problem("The demonstration monitor was cancelled or could not start.")
        }
        pollTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: true) { [weak self] _ in self?.poll() }
        activation = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in self?.poll() }
        poll(); return ["recording": recording, "allowedApps": allowed.sorted()]
    }
    private func execute(_ params: [String: Any], _ generation: UInt64) throws -> [String: Any] {
        guard !recording else { throw problem("Finish the demonstration before reusing it.") }
        guard let bundle = params["bundleId"] as? String, let revision = params["revision"] as? String,
              let id = params["controlId"] as? String, let kind = params["kind"] as? String,
              let previous = cached[bundle], previous.revision == revision,
              let chosen = previous.controls.first(where: { $0.id == id }) else { throw problem("The app changed. Inspect it again before acting.") }
        _ = try app(bundle)
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundle else { throw problem("The selected app is no longer in front. Execution stopped.") }
        let before = try snapshot(bundle, generation)
        guard before.surface["title"] as? String == previous.surface["title"] as? String,
              before.text == previous.text,
              before.controls.count == previous.controls.count,
              zip(before.controls, previous.controls).allSatisfy({ fresh, old in fresh.role == old.role && fresh.name == old.name && fresh.identifier == old.identifier && fresh.value == old.value && fresh.actions == old.actions }),
              let current = before.controls.first(where: { CFEqual($0.ref, chosen.ref) }),
              current.role == chosen.role, current.name == chosen.name, current.identifier == chosen.identifier,
              !dangerous(current.name), current.actions.contains(kind) else { throw problem("The demonstrated control changed or cannot be safely used. Inspect the app again.") }
        try check(generation)
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundle else { throw problem("The selected app is no longer in front. Execution stopped.") }
        // Discard text from the previous scene before any native action, even if
        // the action later fails or changes to a same-sized, same-titled window.
        ocr.reset()
        // Reads use short budgets, but an app must be allowed to dispatch a
        // control action and send its acknowledgement. A short read timeout
        // here can report cannotComplete after a successful button press.
        AXUIElementSetMessagingTimeout(current.ref, 2.0)
        let result: AXError
        if kind == "fill" {
            guard let value = params["value"] as? String, value.count <= 1200, !value.contains("\u{0000}") else { throw problem("The field value is invalid or too long.") }
            guard !forbiddenNavigation(bundle, current.name, value) else { throw problem("Executable or browser-internal URLs cannot be entered by desktop teaching.") }
            let root = AXUIElementCreateApplication((try app(bundle)).processIdentifier)
            if !(element(attr(root, kAXFocusedUIElementAttribute)).map { CFEqual($0, current.ref) } ?? false) {
                guard AXUIElementSetAttributeValue(current.ref, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success,
                      element(attr(root, kAXFocusedUIElementAttribute)).map({ CFEqual($0, current.ref) }) == true else {
                    throw problem("The app could not focus the requested field. Select it and try again.")
                }
                try check(generation)
            }
            result = AXUIElementSetAttributeValue(current.ref, kAXValueAttribute as CFString, value as CFString)
        } else if kind == "click" { result = AXUIElementPerformAction(current.ref, kAXPressAction as CFString) }
        else if kind == "press" {
            guard let value = params["value"] as? String, ["Enter", "Tab", "Escape"].contains(value),
                  !(value == "Enter" && current.role == kAXTextAreaRole) else { throw problem("That keyboard action is not supported safely.") }
            guard !forbiddenNavigation(bundle, current.name, current.value ?? "") else { throw problem("Executable or browser-internal URLs cannot be opened by desktop teaching.") }
            let root = AXUIElementCreateApplication((try app(bundle)).processIdentifier)
            guard let focused = element(attr(root, kAXFocusedUIElementAttribute)), CFEqual(focused, current.ref) else { throw problem("Keyboard focus changed. Inspect the app again before continuing.") }
            var nativeActions: CFArray?; _ = AXUIElementCopyActionNames(current.ref, &nativeActions)
            if value == "Enter" && (nativeActions as? [String] ?? []).contains(kAXConfirmAction) {
                result = AXUIElementPerformAction(current.ref, kAXConfirmAction as CFString)
            } else {
                let code: CGKeyCode = value == "Enter" ? 36 : value == "Tab" ? 48 : 53
                guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
                      let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { throw problem("Could not prepare the supported keyboard action.") }
                try check(generation)
                guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundle else { throw problem("The selected app is no longer in front. Execution stopped.") }
                down.flags = []; up.flags = []; down.postToPid((try app(bundle)).processIdentifier); up.postToPid((try app(bundle)).processIdentifier)
                result = .success
            }
        }
        else { throw problem("This kind of desktop action is not supported.") }
        guard result == .success else { throw problem("The app did not confirm the Accessibility action (\(result.rawValue)). It may have acted; inspect the app before continuing. The action was not retried.") }
        try check(generation)
        // Let native controls update their accessibility state before observation.
        usleep(120_000)
        let after = try snapshot(bundle, generation)
        return ["before": before.json, "after": after.json]
    }
    private func activateAndRespond(_ id: Int, _ bundle: String, _ generation: UInt64) throws {
        let running = try app(bundle); try check(generation)
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != running.processIdentifier {
            guard running.activate(options: [.activateAllWindows]) else { throw problem("The selected app could not be activated.") }
        }
        let settleUntil = Date().addingTimeInterval(1.5)
        func inspectWhenActive() {
            do {
                try check(generation)
                guard !recording else { throw problem("The task was interrupted by a demonstration.") }
                if NSWorkspace.shared.frontmostApplication?.processIdentifier != running.processIdentifier {
                    guard Date() < settleUntil else { throw problem("The selected app did not come to the foreground. Bring its window forward and try again.") }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { inspectWhenActive() }
                    return
                }
                let observation = try snapshot(bundle, generation, settleWindow: true)
                emit(["id": id, "result": observation.json])
            } catch { emit(["id": id, "error": (error as? TeachingError).map(message) ?? "The selected app could not be inspected."]) }
        }
        // AppKit keeps changing NSRunningApplication properties stable until
        // the next main-run-loop turn. Sleeping synchronously after activate
        // prevents the foreground state from updating, even if a window moved.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { inspectWhenActive() }
    }
    private func respond(_ id: Int, _ method: String, _ params: [String: Any], _ generation: UInt64) {
        do {
            try check(generation)
            let result: Any
            switch method {
            case "permissions": result = ["accessibility": AXIsProcessTrusted(), "inputMonitoring": CGPreflightListenEventAccess(), "screenRecording": CGPreflightScreenCaptureAccess()]
            case "status":
                // Report only whether the frontmost app is already in the
                // user's selected scope; never identify an unselected app.
                let active = NSWorkspace.shared.frontmostApplication
                var status = captureScope(active?.bundleIdentifier, active?.localizedName, allowed, excluded)
                status["recording"] = recording; status["visualReading"] = visualReading; status["failure"] = failure as Any? ?? NSNull()
                let visualState = visualReading && recording ? "paused-recording" : visualStatus
                status["visualStatus"] = visualState
                status["visualMessage"] = [
                    "off": "Visual reading is off.",
                    "ready": "Visual reading is enabled for the selected front window.",
                    "paused-recording": "Visual reading pauses while recording a demonstration.",
                    "skipped-sensitive": "Visual reading was skipped because this window may contain sensitive or command content. Accessibility is still available.",
                    "skipped-incomplete": "Visual reading was skipped because the window could not be fully checked for sensitive controls. Accessibility is still available.",
                    "error": "The selected window could not be read visually. Inspect it again or turn visual reading off."
                ][visualState] ?? "Visual reading is unavailable."
                status["eventCount"] = events.count; status["observationCount"] = observationCount
                result = status
            case "request-permissions":
                // Called only by the explicit permission button in Summon.
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                let accessibility = AXIsProcessTrustedWithOptions(options)
                let monitoring = CGPreflightListenEventAccess() || CGRequestListenEventAccess()
                result = ["accessibility": accessibility, "inputMonitoring": monitoring, "screenRecording": CGPreflightScreenCaptureAccess()]
            case "request-screen-recording":
                // This separate explicit user gesture is the only screen prompt.
                let granted = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
                result = ["accessibility": AXIsProcessTrusted(), "inputMonitoring": CGPreflightListenEventAccess(), "screenRecording": granted]
            case "apps": result = NSWorkspace.shared.runningApplications.filter {
                $0.activationPolicy == .regular && $0.bundleIdentifier != nil && $0.bundleIdentifier != "com.summon.companion" && !blockedApps.contains($0.bundleIdentifier!)
            }.map { ["bundleId": $0.bundleIdentifier!, "name": clean($0.localizedName ?? $0.bundleIdentifier!, 120)] }.sorted { $0["name"]! < $1["name"]! }
            case "configure": result = try configure(params)
            case "begin": result = try begin(params, generation)
            case "finish":
                if recording { poll(); flushFill(); flushAction() }; disarm()
                if let failure { throw problem(failure) }
                let captured = events; events = []; result = ["events": captured]
            case "cancel": disarm(); events = []; failure = nil; latest = nil; cached.removeAll(); visualReading = false; visualStatus = "off"; ocr.reset(); result = ["cancelled": true]
            case "snapshot":
                guard let bundle = params["bundleId"] as? String else { throw problem("Choose an app to inspect.") }
                result = try snapshot(bundle, generation).json
            case "activate":
                guard !recording, let bundle = params["bundleId"] as? String else { throw problem("Choose an app to activate after finishing the demonstration.") }
                try activateAndRespond(id, bundle, generation); return
            case "execute": result = try execute(params, generation)
            default: throw problem("Unsupported desktop teaching request.")
            }
            emit(["id": id, "result": result])
        } catch {
            let text = (error as? TeachingError).map(message) ?? "Desktop teaching failed."
            emit(["id": id, "error": text])
        }
    }
}

@main
private enum TeachingMain {
static func main() {
#if SUMMON_TEACHING_TEST
// Synthetic tests never touch the accessibility server or another application.
assert(sensitive("AXTextField", "AXSecureTextField", ""))
assert(sensitive("AXTextField", "", "API key"))
assert(!sensitive("AXTextField", "", "Brawler"))
assert(dangerous("Send message")); assert(dangerous("Install extension")); assert(!dangerous("Select Jessie"))
assert(commandTarget("com.microsoft.VSCode", "Terminal", "")); assert(!commandTarget("com.apple.TextEdit", "Document text", ""))
assert(forbiddenNavigation("com.google.Chrome", "Address", "chrome://extensions"))
assert(forbiddenNavigation("com.apple.TextEdit", "Text", "java\nscript:alert(1)"))
assert(forbiddenNavigation("org.mozilla.firefox", "Location", "file:///private/tmp/test.html"))
assert(!forbiddenNavigation("com.google.Chrome", "Address", "https://example.com/task"))
assert(captureScope("test.selected", "Selected", ["test.selected"], [])["activeInScope"] as? Bool == true)
let hiddenScope = captureScope("test.private", "Secret App Name", ["test.selected"], [])
assert(hiddenScope["activeInScope"] as? Bool == false && hiddenScope["activeApp"] is NSNull)
assert(captureScope("test.selected", "Selected", ["test.selected"], ["test.selected"])["activeApp"] is NSNull)
let epoch = Epoch(); let original = epoch.read(); epoch.advance(); assert(original != epoch.read())
assert(clean("a\nb", 3) == "a b")
func mockPrivacy(_ failed: String? = nil, code: AXError = .cannotComplete, extra: [String: String] = [:]) -> PrivacyFields? {
    privacyFields { key in
        if key == failed { return (code, nil) }
        let values = [kAXRoleAttribute: kAXTextFieldRole, kAXTitleAttribute: "Account"].merging(extra, uniquingKeysWith: { _, latest in latest })
        return values[key].map { (.success, $0 as CFString) } ?? (.attributeUnsupported, nil)
    }
}
assert(mockPrivacy() != nil)
for key in ["AXHidden", kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXLabel", kAXIdentifierAttribute] {
    assert(mockPrivacy(key) == nil)
    assert(mockPrivacy(key, code: .apiDisabled) == nil)
}
let secureAlternative = mockPrivacy(extra: [kAXDescriptionAttribute: "Password", kAXSubroleAttribute: "AXSecureTextField"])!
assert(sensitive(secureAlternative.role, secureAlternative.subrole, secureAlternative.labels))
let secretLabel = mockPrivacy(extra: [kAXDescriptionAttribute: "API key"])!
assert(sensitive(secretLabel.role, secretLabel.subrole, secretLabel.labels))
do { try teachingOCRChecks() } catch { fatalError("Synthetic visual reading checks failed: \(error)") }
emit(["tests": "passed"])
#else
let teaching = Teaching()
teaching.start()
#endif
}
}

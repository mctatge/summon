import AppKit
import Foundation

// An isolated, harmless two-app fixture for Accessibility integration tests.
// All edits stay in memory. It never opens documents or makes network requests.
final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    let field = NSTextField(string: "")
    let status = NSTextField(labelWithString: "Nothing selected")
    let choose = NSButton()
    var variant = false
    let second = Bundle.main.bundleIdentifier?.hasSuffix("receiver") == true
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 300, y: 300, width: 580, height: 370), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = second ? "Summon Teaching Receiver" : "Summon Teaching Catalog"
        let content = NSView(frame: window.contentView!.bounds); window.contentView = content
        let heading = NSTextField(labelWithString: second ? "Receive an item" : "Find an item")
        heading.font = .systemFont(ofSize: 24, weight: .semibold); heading.frame = NSRect(x: 28, y: 306, width: 520, height: 34); content.addSubview(heading)
        let label = NSTextField(labelWithString: second ? "Item to receive" : "Item name")
        label.frame = NSRect(x: 28, y: 260, width: 220, height: 24); content.addSubview(label)
        field.frame = NSRect(x: 28, y: 222, width: 360, height: 30)
        field.setAccessibilityLabel(second ? "Item to receive" : "Item name")
        field.setAccessibilityIdentifier("item-input"); content.addSubview(field)
        choose.title = second ? "Apply item" : "Find item"; choose.bezelStyle = .rounded
        choose.frame = NSRect(x: 404, y: 221, width: 146, height: 32)
        choose.setAccessibilityIdentifier("choose-item"); choose.target = self; choose.action = #selector(apply); content.addSubview(choose)
        status.frame = NSRect(x: 28, y: 166, width: 520, height: 36); status.setAccessibilityIdentifier("result"); content.addSubview(status)
        let change = NSButton(title: "Change layout", target: self, action: #selector(changeLayout)); change.bezelStyle = .rounded
        change.frame = NSRect(x: 28, y: 112, width: 180, height: 32); content.addSubview(change)
        let foreground = NSButton(title: "Bring this test app forward", target: self, action: #selector(bringForward)); foreground.bezelStyle = .rounded
        foreground.frame = NSRect(x: 220, y: 112, width: 330, height: 32); content.addSubview(foreground)
        let secret = NSSecureTextField(string: "fixture-secret-must-not-be-captured")
        secret.frame = NSRect(x: 28, y: 55, width: 320, height: 28); secret.setAccessibilityLabel("Password"); content.addSubview(secret)
        let unsafe = NSButton(title: "Delete account", target: self, action: #selector(blocked)); unsafe.bezelStyle = .rounded
        unsafe.frame = NSRect(x: 370, y: 54, width: 180, height: 30); content.addSubview(unsafe)
        NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil)
    }
    @objc func apply() { status.stringValue = "\(second ? "Received" : "Selected"): \(field.stringValue)" }
    @objc func bringForward() { NSApp.activate(ignoringOtherApps: true); window.makeKeyAndOrderFront(nil) }
    @objc func blocked() { status.stringValue = "Unsafe fixture button was pressed" }
    @objc func changeLayout() {
        variant.toggle(); choose.title = variant ? "Choose matching item" : (second ? "Apply item" : "Find item")
        field.frame.origin.y = variant ? 195 : 222; choose.frame.origin.y = variant ? 194 : 221
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
let app = NSApplication.shared
let delegate = Fixture()
app.setActivationPolicy(.regular); app.delegate = delegate; app.run()

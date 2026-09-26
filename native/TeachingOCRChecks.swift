import AppKit
import CoreGraphics

// All images and window metadata below are synthetic. Never call the capture
// API, permission API, NSWorkspace or Accessibility in this test suite.
func teachingOCRChecks() throws {
    teachingOCRReplyChecks()
    assert(teachingOCRScopeCurrent(process: 10, foreground: 10, generation: 1, currentGeneration: 1))
    assert(!teachingOCRScopeCurrent(process: 10, foreground: 99, generation: 1, currentGeneration: 1))
    assert(!teachingOCRScopeCurrent(process: 10, foreground: nil, generation: 1, currentGeneration: 1))
    assert(!teachingOCRScopeCurrent(process: 10, foreground: 10, generation: 1, currentGeneration: 2))
    let frame = CGRect(x: 40, y: 80, width: 800, height: 640)
    let selected = TeachingOCRWindow(process: 10, window: 20, frame: frame, layer: 0, shareable: true)
    let other = TeachingOCRWindow(process: 99, window: 30, frame: frame, layer: 0, shareable: true)
    let identity = TeachingOCRIdentity(process: 10, window: 20, frame: frame, title: "Example")
    assert(teachingOCRWindowIdentity([selected, other], process: 10, frame: frame, title: "Example") == identity)
    assert(teachingOCRWindowIdentity([other, selected], process: 10, frame: frame, title: "Example") == nil)
    assert(teachingOCRWindowIdentity([selected, selected], process: 10, frame: frame, title: "Example") == nil)
    assert(teachingOCRWindowIdentity([selected], process: 10, frame: frame.offsetBy(dx: 12, dy: 0), title: "Example") == nil)
    let privateWindow = TeachingOCRWindow(process: 10, window: 20, frame: frame, layer: 0, shareable: false)
    assert(teachingOCRWindowIdentity([privateWindow], process: 10, frame: frame, title: "Example") == nil)

    let line = TeachingOCRLine(text: "Continue", bounds: CGRect(x: 20, y: 24, width: 90, height: 18))
    let button = CGRect(x: 10, y: 15, width: 115, height: 40)
    assert(teachingOCRLabel([line], frame: button) == "Continue")
    assert(teachingOCRLabel([line, line], frame: button) == nil)
    assert(teachingOCRLabel([line], frame: button, candidateFrames: [button, button]) == nil)
    // A named actionable child is still a competitor for an unnamed parent.
    assert(teachingOCRLabel([line], frame: button, candidateFrames: [button, line.bounds.insetBy(dx: -3, dy: -3)]) == nil)
    assert(teachingOCRLabel([line], frame: CGRect(x: 100, y: 20, width: 80, height: 30)) == nil)
    assert(teachingOCRLabel([line], frame: CGRect(x: 0, y: 0, width: 900, height: 800)) == nil)
    assert(teachingOCRMerge(["Continue", "Document"], [line]) == "Continue\nDocument")
    assert(teachingOCRMerge(["CONTINUE"], [line]) == "CONTINUE")
    assert(teachingOCRMerge(["abc", "def"], [line], limit: 5) == "abc\nd")

    func fixture(mark: Bool = false, text: Bool = false) -> CGImage {
        let width = 800, height = 640
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(gray: 1, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        if mark {
            context.setFillColor(CGColor(gray: 0, alpha: 1)); context.fill(CGRect(x: 40, y: 490, width: 20, height: 20))
        }
        if text {
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
            ("Summon local reading" as NSString).draw(at: CGPoint(x: 40, y: 490), withAttributes: [.font: NSFont.systemFont(ofSize: 36), .foregroundColor: NSColor.black])
            NSGraphicsContext.restoreGraphicsState()
        }
        return context.makeImage()!
    }
    let cache = TeachingOCRCache(), white = fixture()
    var calls = 0
    let recognize: (CGImage) -> [TeachingOCRLine] = { _ in
        calls += 1
        return [TeachingOCRLine(text: "Band", bounds: CGRect(x: 10, y: 70, width: 60, height: 20))]
    }
    let first = try cache.read(white, identity: identity, recognize: recognize)
    assert(calls == 2 && first.count == 2)
    let reused = try cache.read(white, identity: identity, recognize: recognize)
    assert(calls == 2 && reused == first)
    _ = try cache.read(fixture(mark: true), identity: identity, recognize: recognize)
    assert(calls == 3, "Only one changed band should invoke OCR")
    let moved = TeachingOCRIdentity(process: 10, window: 20, frame: frame.offsetBy(dx: 4, dy: 0), title: "Example")
    _ = try cache.read(white, identity: moved, recognize: recognize); assert(calls == 5)
    let switched = TeachingOCRIdentity(process: 11, window: 21, frame: frame, title: "Example")
    _ = try cache.read(white, identity: switched, recognize: recognize); assert(calls == 7)
    cache.reset(); _ = try cache.read(white, identity: switched, recognize: recognize); assert(calls == 9)
    do {
        _ = try cache.read(white, identity: switched, isCurrent: { false }, recognize: recognize)
        assertionFailure("Cancellation must discard OCR")
    } catch is TeachingOCRError {}
    _ = try cache.read(white, identity: switched, recognize: recognize); assert(calls == 11)
    var elapsed: TimeInterval = 0
    var recognitionNumber = 0
    cache.reset()
    do {
        _ = try cache.read(white, identity: switched, now: { elapsed }, recognize: { image in
            recognitionNumber += 1
            if recognitionNumber == 2 { elapsed = 4 } // The final band returns late.
            return recognize(image)
        })
        assertionFailure("A late recognition result must not be published")
    } catch is TeachingOCRError {}
    let afterLate = calls
    _ = try cache.read(white, identity: switched, recognize: recognize)
    assert(calls == afterLate + 2, "A late recognition result must not be cached")

    // Exercise Apple Vision against a generated image, including the top-left
    // coordinate conversion, without granting or using Screen Recording.
    let recognized = try TeachingOCRCache.recognize(fixture(text: true))
    assert(recognized.contains(where: { $0.text.lowercased().contains("summon local reading") }))
    assert(recognized.allSatisfy({ $0.bounds.minY > 60 && $0.bounds.maxY < 180 }))
}

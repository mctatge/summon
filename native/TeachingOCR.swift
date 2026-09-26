import AppKit
import CoreGraphics
import CryptoKit
import ScreenCaptureKit
import Vision

// Optional, in-memory perception only. No screenshots, OCR results or tile hashes
// are written to disk, and this file has no network or input-event capability.
struct TeachingOCRError: Error { let message: String }
struct TeachingOCRLine: Equatable {
    let text: String
    // Window-local coordinates, with a top-left origin, in points.
    let bounds: CGRect
}
struct TeachingOCRIdentity: Equatable {
    let process: pid_t
    let window: CGWindowID
    let frame: CGRect
    let title: String
}
struct TeachingOCRWindow {
    let process: pid_t
    let window: CGWindowID
    let frame: CGRect
    let layer: Int
    let shareable: Bool
}

func teachingOCRScopeCurrent(process: pid_t, foreground: pid_t?, generation: UInt64, currentGeneration: UInt64) -> Bool {
    generation == currentGeneration && foreground == process
}

func teachingOCRSameFrame(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
    abs(lhs.minX - rhs.minX) < 1 && abs(lhs.minY - rhs.minY) < 1 &&
        abs(lhs.width - rhs.width) < 1 && abs(lhs.height - rhs.height) < 1
}

// The first ordinary on-screen window is the only candidate. Matching just a
// title, or taking the first window belonging to an app, could capture another
// document behind its focused window. Ambiguous geometry fails closed.
func teachingOCRWindowIdentity(_ windows: [TeachingOCRWindow], process: pid_t, frame: CGRect, title: String) -> TeachingOCRIdentity? {
    let ordinary = windows.filter { $0.layer == 0 && $0.frame.width > 1 && $0.frame.height > 1 }
    guard let first = ordinary.first, first.process == process, first.shareable,
          teachingOCRSameFrame(first.frame, frame),
          ordinary.filter({ $0.process == process && teachingOCRSameFrame($0.frame, frame) }).count == 1 else { return nil }
    return TeachingOCRIdentity(process: process, window: first.window, frame: first.frame, title: title)
}

func teachingOCRWindows() -> [TeachingOCRWindow] {
    guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    return info.compactMap { item in
        guard let process = item[kCGWindowOwnerPID as String] as? Int32,
              let window = item[kCGWindowNumber as String] as? UInt32,
              let layer = item[kCGWindowLayer as String] as? Int,
              let bounds = item[kCGWindowBounds as String] as? [String: Any],
              let frame = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { return nil }
        let sharing = item[kCGWindowSharingState as String] as? Int ?? 0
        return TeachingOCRWindow(process: process, window: window, frame: frame, layer: layer, shareable: sharing != 0)
    }
}

// ScreenCaptureKit completion handlers can arrive after a timeout. A locked
// one-shot box discards late results and never starts a follow-on capture.
private final class TeachingOCRReply<T>: @unchecked Sendable {
    let ready = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var value: T?
    private var accepting = true
    func isAccepting() -> Bool { lock.lock(); defer { lock.unlock() }; return accepting }
    func resolve(_ result: T) {
        lock.lock(); defer { lock.unlock() }
        guard accepting else { return }; value = result; accepting = false; ready.signal()
    }
    func take(timeout: TimeInterval) -> T? {
        _ = ready.wait(timeout: .now() + timeout)
        lock.lock(); defer { lock.unlock() }; accepting = false
        let result = value; value = nil; return result
    }
}

private func teachingOCRDigest(_ image: CGImage) -> Data? {
    // A cropped CGImage can retain its parent's entire data provider. Draw into
    // a tightly packed buffer so changes outside this band do not change its hash.
    let width = image.width, height = image.height, rowBytes = width * 4
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: rowBytes,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let bytes = context.data else { return nil }
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return Data(SHA256.hash(data: Data(bytes: bytes, count: rowBytes * height)))
}

enum TeachingOCRCapture {
    static func requirePermission() throws {
        guard #available(macOS 14.0, *) else { throw TeachingOCRError(message: "Visual reading requires macOS 14 or later.") }
        guard CGPreflightScreenCaptureAccess() else {
            throw TeachingOCRError(message: "Enable Screen Recording for Summon using the visual reading permission button, then try again.")
        }
    }

    static func image(identity: TeachingOCRIdentity, isCurrent: @escaping () -> Bool) throws -> CGImage {
        try requirePermission()
        guard #available(macOS 14.0, *) else { throw TeachingOCRError(message: "Visual reading requires macOS 14 or later.") }
        let contentReply = TeachingOCRReply<SCShareableContent>()
        DispatchQueue.global(qos: .userInitiated).async {
            guard contentReply.isAccepting(), CGPreflightScreenCaptureAccess(), isCurrent() else { contentReply.ready.signal(); return }
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: true) { content, _ in
                if let content { contentReply.resolve(content) } else { contentReply.ready.signal() }
            }
        }
        guard let content = contentReply.take(timeout: 2), isCurrent(),
              teachingOCRWindowIdentity(teachingOCRWindows(), process: identity.process, frame: identity.frame, title: identity.title) == identity,
              let window = content.windows.first(where: {
                  $0.windowID == identity.window && $0.owningApplication?.processID == identity.process &&
                      $0.isOnScreen && $0.windowLayer == 0 && teachingOCRSameFrame($0.frame, identity.frame)
              }) else { throw TeachingOCRError(message: "The selected front window changed or could not be read visually. Inspect it again.") }
        // A single independent window excludes every other app, desktop and
        // background window. No display capture or coordinate action fallback.
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let configuration = SCStreamConfiguration()
        let scale = min(2, 2048 / max(identity.frame.width, identity.frame.height))
        configuration.width = max(1, Int((identity.frame.width * scale).rounded()))
        configuration.height = max(1, Int((identity.frame.height * scale).rounded()))
        configuration.showsCursor = false
        configuration.capturesAudio = false
        configuration.ignoreShadowsSingleWindow = true
        configuration.shouldBeOpaque = true
        configuration.ignoreGlobalClipSingleWindow = false
        if #available(macOS 14.2, *) { configuration.includeChildWindows = false }
        if #available(macOS 15.0, *) { configuration.captureMicrophone = false }
        let imageReply = TeachingOCRReply<CGImage>()
        guard isCurrent() else { throw TeachingOCRError(message: "Visual reading cancelled.") }
        DispatchQueue.global(qos: .userInitiated).async {
            guard imageReply.isAccepting(), CGPreflightScreenCaptureAccess(), isCurrent(),
                  teachingOCRWindowIdentity(teachingOCRWindows(), process: identity.process, frame: identity.frame, title: identity.title) == identity else {
                imageReply.ready.signal(); return
            }
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { image, _ in
                if let image { imageReply.resolve(image) } else { imageReply.ready.signal() }
            }
        }
        guard let image = imageReply.take(timeout: 2), isCurrent(),
              teachingOCRWindowIdentity(teachingOCRWindows(), process: identity.process, frame: identity.frame, title: identity.title) == identity else {
            throw TeachingOCRError(message: "The selected front window changed or its image was unavailable. Inspect it again.")
        }
        return image
    }
}

#if SUMMON_TEACHING_TEST
func teachingOCRReplyChecks() {
    let late = TeachingOCRReply<Int>()
    assert(late.take(timeout: 0) == nil && !late.isAccepting())
    late.resolve(1)
    assert(late.take(timeout: 0) == nil)
    let ready = TeachingOCRReply<Int>()
    ready.resolve(2)
    assert(ready.take(timeout: 0) == 2 && !ready.isAccepting())
}
#endif

final class TeachingOCRCache {
    private struct Band { let digest: Data; let lines: [TeachingOCRLine] }
    private var identity: TeachingOCRIdentity?
    private var size = CGSize.zero
    private var bands = [Int: Band]()
    func reset() { identity = nil; size = .zero; bands.removeAll() }

    // Horizontal bands retain whole text lines. The overlap supplies OCR with
    // neighboring pixels at boundaries; only lines centered in a band's core
    // are retained. Every screenshot is fresh, but unchanged bands skip Vision.
    func read(_ image: CGImage, identity next: TeachingOCRIdentity,
              isCurrent: () -> Bool = { true },
              now: () -> TimeInterval = { Date.timeIntervalSinceReferenceDate },
              recognize: (CGImage) throws -> [TeachingOCRLine] = TeachingOCRCache.recognize) throws -> [TeachingOCRLine] {
        let imageSize = CGSize(width: image.width, height: image.height)
        if identity != next || size != imageSize { reset() }
        identity = next; size = imageSize
        let started = now(), coreHeight = 320, overlap = 40
        func checkBudget() throws {
            guard isCurrent() else { throw TeachingOCRError(message: "Visual reading cancelled.") }
            guard now() - started < 3 else { throw TeachingOCRError(message: "Visual reading took too long. Try a smaller window or turn visual reading off.") }
        }
        var nextBands = [Int: Band](), output = [TeachingOCRLine]()
        do {
            for y in stride(from: 0, to: image.height, by: coreHeight) {
                try checkBudget()
                let top = max(0, y - overlap), bottom = min(image.height, y + coreHeight + overlap)
                guard let crop = image.cropping(to: CGRect(x: 0, y: top, width: image.width, height: bottom - top)),
                      let digest = teachingOCRDigest(crop) else { throw TeachingOCRError(message: "The selected window image could not be read.") }
                let lines: [TeachingOCRLine]
                if let previous = bands[y], previous.digest == digest { lines = previous.lines }
                else {
                    lines = try recognize(crop).compactMap { line in
                        let global = line.bounds.offsetBy(dx: 0, dy: CGFloat(top))
                        guard global.midY >= CGFloat(y), global.midY < CGFloat(min(image.height, y + coreHeight)) else { return nil }
                        return TeachingOCRLine(text: line.text, bounds: global)
                    }
                }
                // Vision is synchronous; a single request may return late.
                // Never publish or cache a result that missed the read budget.
                try checkBudget()
                nextBands[y] = Band(digest: digest, lines: lines)
                output.append(contentsOf: lines)
            }
            try checkBudget()
            bands = nextBands
            let sx = next.frame.width / CGFloat(image.width), sy = next.frame.height / CGFloat(image.height)
            return output.sorted { abs($0.bounds.minY - $1.bounds.minY) > 4 ? $0.bounds.minY < $1.bounds.minY : $0.bounds.minX < $1.bounds.minX }
                .prefix(160).map { line in
                    TeachingOCRLine(text: line.text, bounds: CGRect(x: line.bounds.minX * sx, y: line.bounds.minY * sy, width: line.bounds.width * sx, height: line.bounds.height * sy))
                }
        } catch { reset(); throw error }
    }

    static func recognize(_ image: CGImage) throws -> [TeachingOCRLine] {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        if #available(macOS 13.0, *) { request.automaticallyDetectsLanguage = true }
        do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) }
        catch { throw TeachingOCRError(message: "Local text recognition could not read the selected window. Try again or turn visual reading off.") }
        return (request.results ?? []).prefix(160).compactMap { observation in
            guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.5 else { return nil }
            let text = String(candidate.string.components(separatedBy: .controlCharacters).joined(separator: " ").prefix(500)).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            let box = observation.boundingBox
            return TeachingOCRLine(text: text, bounds: CGRect(x: box.minX * CGFloat(image.width), y: (1 - box.maxY) * CGFloat(image.height), width: box.width * CGFloat(image.width), height: box.height * CGFloat(image.height)))
        }
    }
}

// Never infer action support from pixels. Only an already-actionable, unnamed
// AX control can receive a short OCR label, with exactly one spatial candidate.
func teachingOCRLabel(_ lines: [TeachingOCRLine], frame: CGRect, candidateFrames: [CGRect] = []) -> String? {
    guard frame.width > 0, frame.height > 0, frame.width <= 700, frame.height <= 140 else { return nil }
    let matched = lines.filter {
        let intersection = frame.intersection($0.bounds)
        return !$0.bounds.isEmpty && !intersection.isNull &&
            intersection.width * intersection.height >= $0.bounds.width * $0.bounds.height * 0.9 &&
            frame.insetBy(dx: -1, dy: -1).contains(CGPoint(x: $0.bounds.midX, y: $0.bounds.midY))
    }
    guard matched.count == 1, let line = matched.first, line.text.count <= 120 else { return nil }
    if !candidateFrames.isEmpty {
        let candidates = candidateFrames.filter { candidate in
            let intersection = candidate.intersection(line.bounds)
            return !intersection.isNull && intersection.width * intersection.height >= line.bounds.width * line.bounds.height * 0.9
        }
        guard candidates.count == 1 else { return nil }
    }
    return line.text
}

func teachingOCRMerge(_ accessible: [String], _ lines: [TeachingOCRLine], limit: Int = 6000) -> String {
    func key(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
    var kept = [String](), seen = Set<String>(), count = 0
    for text in accessible + lines.map(\.text) {
        let normalized = key(text)
        guard !normalized.isEmpty, !seen.contains(normalized), count < limit else { continue }
        let separator = kept.isEmpty ? 0 : 1
        guard count + separator < limit else { break }
        let bounded = String(text.prefix(limit - count - separator))
        kept.append(bounded); seen.insert(normalized); count += bounded.count + separator
    }
    return kept.joined(separator: "\n")
}

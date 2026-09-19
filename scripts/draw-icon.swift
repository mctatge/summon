import AppKit
let size = 1024
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
NSColor(calibratedRed: 0.10, green: 0.29, blue: 0.27, alpha: 1).setFill()
NSBezierPath(roundedRect: NSRect(x: 18, y: 18, width: 988, height: 988), xRadius: 224, yRadius: 224).fill()
let mark = NSBezierPath()
mark.move(to: NSPoint(x: 512,y: 820))
for p in [NSPoint(x: 606,y: 606), NSPoint(x: 820,y: 512), NSPoint(x: 606,y: 418), NSPoint(x: 512,y: 204), NSPoint(x: 418,y: 418), NSPoint(x: 204,y: 512), NSPoint(x: 418,y: 606)] { mark.line(to:p) }
mark.close()
NSColor(calibratedRed: 0.93, green: 0.95, blue: 0.86, alpha: 1).setFill()
mark.fill()
NSColor(calibratedRed: 0.10, green: 0.29, blue: 0.27, alpha: 1).setFill()
NSBezierPath(ovalIn: NSRect(x: 453,y: 453,width: 118,height: 118)).fill()
image.unlockFocus()
guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data:tiff), let png = bitmap.representation(using:.png,properties:[:]) else { exit(1) }
try png.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))

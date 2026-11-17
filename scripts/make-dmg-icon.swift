import AppKit
import Foundation

// 安装介质使用系统磁盘底座与品牌徽标，应用图标保持独立。
guard CommandLine.arguments.count == 3 else {
    fatalError("用法：make-dmg-icon.swift 应用图标 输出目录")
}
let output = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let iconset = output.appendingPathComponent("installer.iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
guard let brand = NSImage(contentsOfFile: CommandLine.arguments[1]), brand.isValid else {
    fatalError("无法读取品牌图标")
}
let disk = NSWorkspace.shared.icon(forFile: "/")
func render(_ pixels: Int) throws -> Data {
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
        let context = NSGraphicsContext(bitmapImageRep: bitmap) else { fatalError("无法创建图标画布") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = context
    context.imageInterpolation = .high
    let scale = CGFloat(pixels) / 1024
    context.cgContext.scaleBy(x: scale, y: scale)
    disk.draw(in: NSRect(x: 48, y: 24, width: 928, height: 650))
    brand.draw(in: NSRect(x: 222, y: 350, width: 580, height: 580))
    NSGraphicsContext.restoreGraphicsState()
    guard let data = bitmap.representation(using: .png, properties: [:]) else { fatalError("无法编码图标") }
    return data
}
for size in [16, 32, 128, 256, 512] {
    try render(size).write(to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try render(size * 2).write(to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
try render(1024).write(to: output.appendingPathComponent("installer-icon.png"))
print("已生成安装镜像专属图标：\(output.path)")

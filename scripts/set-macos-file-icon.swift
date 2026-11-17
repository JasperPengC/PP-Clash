import AppKit
import Foundation

let iconPath = CommandLine.arguments[1]
let targetPath = CommandLine.arguments[2]
guard let icon = NSImage(contentsOfFile: iconPath), icon.isValid else {
    fatalError("无法读取文件图标：\(iconPath)")
}
guard NSWorkspace.shared.setIcon(icon, forFile: targetPath, options: []) else {
    fatalError("无法设置文件图标：\(targetPath)")
}
print("已设置猫头文件图标：\(targetPath)")

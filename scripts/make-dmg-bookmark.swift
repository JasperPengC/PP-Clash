import Foundation

// 由系统生成 Finder 的文件引用，保留真实卷标识与现代 bookmark 属性。
let image = URL(fileURLWithPath: CommandLine.arguments[1])
let output = CommandLine.arguments[2]
let bookmark = try image.bookmarkData(options: .suitableForBookmarkFile,
    includingResourceValuesForKeys: nil, relativeTo: nil)
try bookmark.write(to: URL(fileURLWithPath: output + ".bookmark"))

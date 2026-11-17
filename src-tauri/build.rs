fn main() {
    // Windows 的 ICO 编译进 PE 资源；图标变化也必须触发增量重编译。
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}

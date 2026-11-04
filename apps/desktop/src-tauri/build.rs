//! Tauri build script.
//!
//! Registers every app IPC command in the app manifest. Commands listed here get an
//! auto-generated `allow-<name>` / `deny-<name>` permission, and ONLY commands granted in a
//! capability file (`capabilities/*.json`) are callable from the webview. Add new commands to
//! `APP_COMMANDS` and grant them explicitly (docs/security/desktop-threat-model.md, T-IPC-1).

/// Every `#[tauri::command]` exposed to the webview. Keep in sync with `generate_handler!`.
const APP_COMMANDS: &[&str] = &["core_hello"];

#[allow(clippy::expect_used)] // a build script should fail the build loudly
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}

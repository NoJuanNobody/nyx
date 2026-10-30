//! Nyx desktop shell. Thin wrapper: all logic lives in `nyx-core`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tauri::command]
fn core_hello() -> String {
    nyx_core::hello()
}

fn main() {
    let result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![core_hello])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        eprintln!("error while running Nyx desktop: {err}");
        std::process::exit(1);
    }
}

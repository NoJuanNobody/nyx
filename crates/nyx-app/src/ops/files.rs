//! Local file access for agents, restricted to the workspace root by `WorkspaceJail`.
//! TS parity: `nyx_read_file`, `nyx_list_files` (the TS server read any path; here every path
//! must resolve inside the workspace root, symlink escapes included).

use serde_json::{json, Value};

use crate::args::Args;
use crate::error::{AppError, AppResult};
use crate::registry::{obj, Parity, ToolSpec};
use crate::Cx;

const MAX_FILE_SIZE: u64 = 100 * 1024;

fn jail<'a>(cx: &'a Cx<'_>) -> AppResult<&'a nyx_core::security::paths::WorkspaceJail> {
    cx.app
        .jail
        .as_ref()
        .ok_or_else(|| AppError::not_configured("no workspace root available"))
}

fn read_file(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let p = a.str("path")?;
    let j = jail(cx)?.clone().with_max_read_bytes(MAX_FILE_SIZE);
    let resolved = j.resolve(p)?;
    if resolved.is_dir() {
        return Err(AppError::invalid(format!(
            "Path is a directory, not a file: {}. Use nyx_list_files instead.",
            j.display_relative(&resolved)
        )));
    }
    let content = j.read_to_string(p)?;
    let ext = resolved
        .extension()
        .map_or_else(|| "txt".to_owned(), |e| e.to_string_lossy().into_owned());
    Ok(json!({"path": j.display_relative(&resolved), "extension": ext, "content": content}))
}

fn list_files(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let j = jail(cx)?;
    let resolved = j.resolve(a.opt_str("path").unwrap_or("."))?;
    let rd = std::fs::read_dir(&resolved).map_err(|e| AppError::from(nyx_core::Error::from(e)))?;
    let mut entries: Vec<(String, bool)> = rd
        .filter_map(Result::ok)
        .map(|e| {
            (
                e.file_name().to_string_lossy().into_owned(),
                e.path().is_dir(),
            )
        })
        .collect();
    entries.sort();
    Ok(Value::Array(
        entries
            .into_iter()
            .map(|(n, d)| json!({"name": n, "type": if d { "directory" } else { "file" }}))
            .collect(),
    ))
}

/// Register file tools.
pub fn register(v: &mut Vec<ToolSpec>) {
    v.push(
        ToolSpec::new(
            "nyx_read_file",
            "files",
            "Read a local file from the user's filesystem. Returns file contents. Useful for comparing code against specs, checking compliance, or importing content into Nyx documents. Max 100 KB. Restricted to the workspace root.",
            obj(json!({"path": {"type": "string", "description": "Absolute or relative file path to read"}}), &["path"]),
            read_file,
        )
        .parity(Parity::Exact),
    );
    v.push(
        ToolSpec::new(
            "nyx_list_files",
            "files",
            "List files and directories at a given path on the user's filesystem. Useful for exploring project structure before reading specific files. Restricted to the workspace root.",
            obj(json!({"path": {"type": "string", "description": "Directory path to list (defaults to current working directory)"}}), &[]),
            list_files,
        )
        .parity(Parity::Exact),
    );
}

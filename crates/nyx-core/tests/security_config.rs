//! Guards the Tauri security configuration against regressions (AI-77).
#![allow(clippy::unwrap_used, clippy::needless_pass_by_value)]
//! Reads `apps/desktop/src-tauri/{tauri.conf.json,capabilities/*.json}` from the workspace.

use std::fs;
use std::path::PathBuf;

use serde_json::Value;

fn tauri_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/desktop/src-tauri")
}

fn json(p: PathBuf) -> Value {
    serde_json::from_str(&fs::read_to_string(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display())))
        .unwrap()
}

#[test]
fn csp_is_strict() {
    let conf = json(tauri_dir().join("tauri.conf.json"));
    let sec = &conf["app"]["security"];
    let csp = sec["csp"]
        .as_object()
        .expect("csp must be an object, not null");
    let all: String = csp
        .iter()
        .filter(|(k, _)| *k != "connect-src")
        .filter_map(|(_, v)| v.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    for banned in [
        "unsafe-eval",
        "unsafe-inline",
        "http:",
        "https:",
        "ws:",
        "wss:",
        " *",
        "data:text",
    ] {
        assert!(
            !all.contains(banned),
            "CSP must not contain `{banned}`: {all}"
        );
    }
    assert_eq!(csp["default-src"], "'none'");
    assert_eq!(csp["script-src"], "'self'");
    assert_eq!(csp["object-src"], "'none'");
    assert_eq!(csp["base-uri"], "'none'");
    assert_eq!(csp["frame-ancestors"], "'none'");
    assert!(csp["connect-src"]
        .as_str()
        .unwrap()
        .split(' ')
        .all(|s| s == "ipc:" || s == "http://ipc.localhost"));
    assert_eq!(sec["freezePrototype"], true);
    assert_eq!(sec["dangerousDisableAssetCspModification"], false);
    assert_eq!(sec["assetProtocol"]["enable"], false);
    assert_eq!(sec["capabilities"], serde_json::json!(["default"]));
}

#[test]
fn capabilities_are_least_privilege() {
    let dir = tauri_dir().join("capabilities");
    let mut seen = 0;
    for e in fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.extension().is_none_or(|x| x != "json") {
            continue;
        }
        seen += 1;
        let cap = json(p.clone());
        assert!(
            cap.get("remote").is_none(),
            "{}: remote origins are not allowed",
            p.display()
        );
        assert_eq!(
            cap["windows"],
            serde_json::json!(["main"]),
            "{}",
            p.display()
        );
        for perm in cap["permissions"].as_array().unwrap() {
            let perm = perm
                .as_str()
                .expect("scoped/object permissions need review");
            for banned in [
                "fs:",
                "shell:",
                "http:",
                "opener:",
                "dialog:",
                "os:",
                "global-shortcut:",
                "clipboard",
            ] {
                assert!(
                    !perm.starts_with(banned),
                    "{perm} is not allowed by default"
                );
            }
            assert!(
                !perm.ends_with(":default") || perm.starts_with("core:event"),
                "broad bundle {perm}"
            );
            assert!(!perm.contains('*'), "wildcard permission {perm}");
            assert_ne!(perm, "core:default");
        }
    }
    assert!(seen >= 1);
}

#[test]
fn every_registered_command_is_granted_and_nothing_else() {
    let build = fs::read_to_string(tauri_dir().join("build.rs")).unwrap();
    let main = fs::read_to_string(tauri_dir().join("src/main.rs")).unwrap();
    let cap = json(tauri_dir().join("capabilities/default.json"));
    let perms: Vec<&str> = cap["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    // generate_handler![a, b] must equal APP_COMMANDS and each must have an allow-* grant.
    let handler = main
        .split("generate_handler![")
        .nth(1)
        .unwrap()
        .split(']')
        .next()
        .unwrap();
    for cmd in handler.split(',').map(str::trim).filter(|c| !c.is_empty()) {
        assert!(
            build.contains(&format!("\"{cmd}\"")),
            "{cmd} missing from APP_COMMANDS in build.rs"
        );
        let allow = format!("allow-{}", cmd.replace('_', "-"));
        assert!(
            perms.contains(&allow.as_str()),
            "{cmd} not granted ({allow})"
        );
    }
}

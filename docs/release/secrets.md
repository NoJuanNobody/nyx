# GitHub secret names

Names only. Values are never committed. Set at repo level (or an `release` environment
with required reviewers, recommended).

| Secret | Required | Purpose |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | yes | Updater private key contents |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | yes | Password for that key |
| `APPLE_CERTIFICATE` | macOS | base64 `.p12` Developer ID Application cert |
| `APPLE_CERTIFICATE_PASSWORD` | macOS | `.p12` password |
| `APPLE_SIGNING_IDENTITY` | macOS | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | macOS (option A) | Apple ID email for notarytool |
| `APPLE_PASSWORD` | macOS (option A) | App-specific password |
| `APPLE_TEAM_ID` | macOS (option A) | 10-char team id |
| `APPLE_API_ISSUER` | macOS (option B) | App Store Connect issuer id |
| `APPLE_API_KEY` | macOS (option B) | API key id |
| `APPLE_API_KEY_P8` | macOS (option B) | Contents of the `.p8` key |
| `WINDOWS_CERTIFICATE` | Windows (if pfx) | base64 `.pfx` |
| `WINDOWS_CERTIFICATE_PASSWORD` | Windows (if pfx) | pfx password |

`GITHUB_TOKEN` (automatic) needs `contents: write` to create the release.

# Signing and notarization setup

Nothing in this repo contains real keys. Every secret lives in GitHub Actions
secrets (names in `secrets.md` below). Never paste a value into an issue, PR or log.

## 1. Tauri updater keypair (required, all platforms)

The updater verifies every update bundle against a minisign-style signature.

```sh
# Run locally on a trusted machine, once.
pnpm dlx @tauri-apps/cli signer generate -w ~/.tauri/nyx-updater.key
```

- You are prompted for a password. Use a strong one and store it in a password manager.
- Output: private key file (`nyx-updater.key`) and `nyx-updater.key.pub`.
- Put the **contents of the `.pub` file** into `plugins.updater.pubkey` in
  `apps/desktop/src-tauri/tauri.conf.json` (currently a placeholder string; builds
  with the placeholder will produce updates no client can verify).
- Put the **private key contents** in secret `TAURI_SIGNING_PRIVATE_KEY` and the
  password in `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.
- Back the private key up offline. Losing it means existing installs can never be
  updated automatically (users must reinstall). Rotating the key has the same effect.

## 2. macOS: Developer ID + notarization

Prereqs: paid Apple Developer Program membership.

1. In developer.apple.com > Certificates, create a **Developer ID Application** certificate
   (CSR from Keychain Access).
2. Export it from Keychain Access as `.p12` with a password.
3. `base64 -i cert.p12 | pbcopy` and store as `APPLE_CERTIFICATE`; password as
   `APPLE_CERTIFICATE_PASSWORD`.
4. `APPLE_SIGNING_IDENTITY` is the cert common name, e.g.
   `Developer ID Application: Your Name (TEAMID)`
   (`security find-identity -v -p codesigning` lists it).
5. Notarization, choose one:
   - Apple ID: `APPLE_ID`, `APPLE_PASSWORD` (an **app-specific password** from
     appleid.apple.com, not the account password), `APPLE_TEAM_ID`.
   - App Store Connect API key (preferred for CI): `APPLE_API_ISSUER`, `APPLE_API_KEY`
     (key id), `APPLE_API_KEY_PATH` (workflow writes the `.p8` from secret
     `APPLE_API_KEY_P8` to a temp file).
6. Tauri signs and notarizes automatically when these env vars are present during
   `tauri build`. Hardened runtime is already on in `tauri.conf.json`.
7. Build both `aarch64-apple-darwin` and `x86_64-apple-darwin` (or `universal-apple-darwin`).

## 3. Windows code signing

Options, in order of preference:

- **Azure Trusted Signing / Artifact Signing** or an EV/OV cert on a cloud HSM
  (DigiCert KeyLocker, SSL.com eSigner). Since 2023 CA/B rules require private keys on
  hardware, so a plain exported `.pfx` is only possible for older certs.
- If a `.pfx` is available: base64 it into `WINDOWS_CERTIFICATE`, password into
  `WINDOWS_CERTIFICATE_PASSWORD`, import in the workflow, and set the thumbprint via
  `bundle.windows.certificateThumbprint` (or inject at build time; keep it null in git
  until a cert exists) or use a `signCommand`.
- For cloud signing, configure `bundle.windows.signCommand` in the workflow (override
  config with `--config`) to call the vendor tool. Secret names are vendor specific;
  record them in `secrets.md` when chosen.

Unsigned Windows builds work but trigger SmartScreen warnings. Ship unsigned only for
pre-release tags and say so in the release notes.

## 4. Linux

No signing required for `.deb`, `.rpm`, `.AppImage`. Updater signature (section 1)
still applies to the AppImage. Optionally publish SHA256 sums with the release.

## 5. Open items needing a human

- Buy/enroll Apple Developer account and a Windows signing option.
- Generate the updater key and replace the `pubkey` placeholder.
- Add secrets in repo Settings > Secrets and variables > Actions.

# Security Policy

## Supported versions

Nyx is pre-1.0. Only the latest release and the current `main` branch receive security fixes. Once tagged releases exist, this table will list the supported lines.

| Version | Supported |
|---|---|
| `main` (unreleased) | Yes |
| Latest tagged release | Yes |
| Older releases | No |

## Reporting a vulnerability

Please do **not** open a public issue, discussion or pull request for security problems.

Preferred: use GitHub private vulnerability reporting. Go to the repository's **Security** tab, choose **Advisories**, then **Report a vulnerability**. This creates a private advisory visible only to you and the maintainers.

Fallback, if you cannot use GitHub advisories: email **[TODO: security contact address, to be set before the public launch]**. Do not send exploit details to any personal address.

Please include:

- affected component (core crate, CLI, MCP server, desktop app, API, web) and version or commit
- steps to reproduce or a proof of concept
- impact as you understand it
- any suggested mitigation

Never include real credentials or personal data. If you find leaked secrets in the repository or its history, report them the same way so they can be rotated.

## What to expect

These are targets for a small volunteer-run project, not contractual guarantees.

| Step | Target |
|---|---|
| Acknowledgement of your report | within 3 business days |
| Initial assessment and severity | within 10 business days |
| Status updates | at least every 14 days while open |
| Fix or mitigation for high/critical issues | aim for 90 days or less from report |

We will coordinate disclosure with you, credit you in the advisory unless you prefer to stay anonymous, and publish a GitHub security advisory (with a CVE where applicable) once a fix is available. Please give us a reasonable chance to fix the issue before public disclosure.

## Scope

In scope: code in this repository, including the credit ledger (for example any path that could mint, transfer or overspend credits outside the owner-grant rules in [docs/credits/utility-tokens-spec.md](docs/credits/utility-tokens-spec.md)), MCP and CLI tool handling, local data storage, and the desktop shell.

Out of scope: vulnerabilities in third-party dependencies with no demonstrable impact on Nyx (report those upstream), social engineering, denial of service by volume, and issues requiring a compromised local machine.

## Safe harbor

We will not pursue legal action against researchers who act in good faith, avoid privacy violations and data destruction, and follow this policy.

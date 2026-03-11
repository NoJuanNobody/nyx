# Fix: Allow Claude Bot to Pass GitHub Checks

## Problem

When Claude Code Review runs on a pull request opened by a bot (e.g., `claude[bot]`), the workflow
may skip or fail to post a review, causing required checks to block the PR from merging.

This happens because `anthropics/claude-code-action` has a default guard that ignores bot-authored
PRs to prevent feedback loops. You can opt out of this guard by setting `allowed_bots`.

---

## Step-by-Step Fix

### 1. Open the workflow file

Navigate to `.github/workflows/claude-code-review.yml` in your repository and open it for editing.

You can do this directly on GitHub:

1. Go to your repository on GitHub.
2. Click **Code** → navigate to `.github/workflows/`.
3. Click `claude-code-review.yml`.
4. Click the **pencil icon** (Edit this file) in the top-right corner.

---

### 2. Locate the `Run Claude Code Review` step

Find the step that uses `anthropics/claude-code-action`. It looks like this:

```yaml
- name: Run Claude Code Review
  id: claude-review
  uses: anthropics/claude-code-action@v1
  with:
    claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    plugin_marketplaces: 'https://github.com/anthropics/claude-code.git'
    plugins: 'code-review@claude-code-plugins'
    prompt: '/code-review:code-review ${{ github.repository }}/pull/${{ github.event.pull_request.number }}'
```

---

### 3. Add the `allowed_bots` input

Add `allowed_bots: 'claude[bot]'` inside the `with:` block:

```yaml
- name: Run Claude Code Review
  id: claude-review
  uses: anthropics/claude-code-action@v1
  with:
    claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
    plugin_marketplaces: 'https://github.com/anthropics/claude-code.git'
    plugins: 'code-review@claude-code-plugins'
    prompt: '/code-review:code-review ${{ github.repository }}/pull/${{ github.event.pull_request.number }}'
    allowed_bots: 'claude[bot]'   # <-- Add this line
```

> **Tip:** To allow _all_ bots (not just Claude), use `allowed_bots: '*'` instead.

---

### 4. Commit the change

Scroll to the bottom of the GitHub editor. Under **Commit changes**:

1. Enter a short commit message, e.g.:
   ```
   fix: allow claude[bot] to pass code review checks
   ```
2. Choose **Commit directly to the `main` branch** (or your default branch).
3. Click **Commit changes**.

---

### 5. Verify

Open or re-trigger a pull request authored by `claude[bot]` and confirm that the
**Claude Code Review** check now runs and passes.

---

## Reference

- [`anthropics/claude-code-action` documentation](https://github.com/anthropics/claude-code-action/blob/main/docs/usage.md)
- [`allowed_bots` FAQ entry](https://github.com/anthropics/claude-code-action/blob/main/docs/faq.md)

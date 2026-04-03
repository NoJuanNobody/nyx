---
name: research-issue
description: Deep-dive into a GitHub issue, trace the root cause through the codebase, and post a structured comment with findings and an implementation plan.
allowed-tools: Bash(gh *), Bash(git *), Read, Glob, Grep, Agent
argument-hint: [issue-number]
---

# Research Issue

Deep-dive into a GitHub issue, trace the root cause through the codebase, and post a structured comment with findings and an implementation plan.

## Arguments

- Issue number or URL (required) — e.g. `266` or `https://github.com/NoJuanNobody/nyx/issues/266`

## Steps

1. **Read the issue:**
   ```bash
   gh issue view <number> --repo NoJuanNobody/nyx
   ```

2. **Research the codebase:**
   - Identify the feature area from the issue description
   - Trace the full flow: frontend component → API call → backend route → service → database
   - Read all relevant files thoroughly — don't guess, verify
   - Find the exact lines where the bug originates or where the feature gap exists
   - Check for related tests, types, and shared utilities

3. **Diagnose the root cause:**
   - Identify what's happening vs. what should happen
   - Pinpoint the exact file(s) and line(s) responsible
   - Understand why the current code behaves this way (not just what's wrong)

4. **Draft the implementation plan:**
   - List concrete changes per file with line references
   - Note any new files, tests, or migrations needed
   - Flag edge cases or risks
   - Estimate scope (e.g. "single-file fix, ~30 lines")

5. **Post the comment:**
   Use `gh issue comment` with a HEREDOC body in this format:

   ```markdown
   ## Root Cause Analysis

   <Clear explanation of the bug/gap, traced through the code with file:line references>

   ### What happens now
   <Numbered step-by-step of current behavior, referencing specific code paths>

   ---

   ## Implementation Plan

   ### <Area> — `<file path>`
   <What to change and why, with line references>

   ### Tests
   <What tests to add or update>

   ### Summary
   | Change | File | Lines |
   |--------|------|-------|
   | ... | ... | ... |

   <Scope estimate>
   ```

## Rules

- Always read the actual code before diagnosing — never speculate from file names alone
- Include file paths and line numbers in the analysis so the implementation is unambiguous
- Trace the full stack (frontend → API → service → DB) when relevant
- If the issue is unclear or missing context, note what assumptions you made
- Keep the plan surgical — only propose changes necessary to fix the issue
- If you find related issues or follow-up work, mention them at the end
- Do not implement the fix — only research and comment

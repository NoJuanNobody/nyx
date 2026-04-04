---
name: explain-implementation
description: Fetch a GitHub issue with its implementation plan, explain where it fits in the broader system architecture in plain language, and post the explanation as a comment.
allowed-tools: Bash(gh *), Bash(git *), Read, Glob, Grep, Agent
argument-hint: [issue-number]
---

# Explain Implementation

Read a GitHub issue and its implementation plan, then explain in plain language what it does, where it fits in the broader system, and why it matters — and post that explanation as a comment on the issue.

## Arguments

- Issue number or URL (required) — e.g. `285` or `https://github.com/NoJuanNobody/nyx/issues/285`

## Steps

1. **Read the issue and comments:**
   ```bash
   gh issue view <number> --repo NoJuanNobody/nyx
   gh issue view <number> --repo NoJuanNobody/nyx --comments
   ```

2. **Understand the implementation plan:**
   - Identify the implementation plan from the issue body or comments
   - If there is no implementation plan, tell the user and suggest running `/research-issue` first
   - Read the relevant files referenced in the plan to understand current state

3. **Identify the broader context:**
   - Read `Nyx_ProductBrief.md` and `CLAUDE.md` for product and architecture context
   - Determine which larger system, pipeline, or feature area this issue belongs to (e.g. RAG pipeline, auth flow, CI/CD, drift detection)
   - Map out the full pipeline or workflow and identify where this issue's work sits within it

4. **Draft the explanation:**
   Write a clear, non-technical explanation covering:
   - **Where this fits** — what larger system or pipeline does this belong to, and what step is it?
   - **Full pipeline/workflow** — numbered list of all the steps in that system, with this issue's step clearly marked
   - **Why it matters** — what does this unlock? What can't happen without it? What downstream features depend on it?
   - Keep language accessible to non-technical stakeholders

5. **Post the comment:**
   Use `gh issue comment` with a HEREDOC body in this format:

   ```markdown
   ## Where this fits in <system/pipeline name>

   <1-2 sentence summary of what this issue is and what step it represents>

   ### Full <pipeline/workflow name>

   1. **Step** — description
   2. **Step** — description ← **this issue**
   3. **Step** — description
   ...

   ### Why it matters

   <Plain-language explanation of current state, what this enables, and what downstream features depend on it>
   ```

## Rules

- Always read the issue comments to find the implementation plan — it may not be in the issue body
- If no implementation plan exists, stop and tell the user to run `/research-issue` first
- Read the actual code and product brief to ground the explanation — don't speculate
- Keep language accessible — a non-technical stakeholder should be able to understand the comment
- Focus on the "so what" — why this matters to the product, not just what SQL gets added
- Do not implement anything — only explain and comment

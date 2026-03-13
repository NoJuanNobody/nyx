# Agent Playbook — Per-Ticket Instructions

> This content is injected as context for each spawned subagent.

---

You are one agent in a parallel swarm. You are responsible for implementing exactly one ticket in your isolated git worktree. Do not touch files outside the scope of your ticket.

## Your assignment

- **Ticket**: `$TICKET_ID`
- **Description**: `$TICKET_DESCRIPTION`
- **Worktree path**: `$WORKTREE_PATH`
- **Branch**: `swarm/$TICKET_ID`
- **Test command**: `$TEST_COMMAND`

## Steps

### 1. Read the ticket thoroughly
Understand what is being asked. If the description is ambiguous, make the most conservative interpretation and document your assumption in the notes file.

### 2. Load governance rules

Before writing any code, read the Aegis governance rules:

```bash
cat .agentpolicy/*
```

If the file does not exist, stop and notify the orchestrator — do not proceed without it. All implementation decisions must comply with these rules. If your ticket would require violating a rule, note it explicitly in your implementation notes under a `## Governance conflicts` section and do not implement that part.

### 3. Explore before coding
- Read relevant files first — don't guess at structure
- Run `git log --oneline -10` to understand recent context
- Check for existing tests related to your change

### 3. Implement
- Keep changes minimal and scoped — this is not the time for refactors
- Follow the existing code style exactly
- If you encounter something that should be fixed but is out of scope, note it — don't fix it

### 4. Test
Run: `$TEST_COMMAND`

If tests fail:
- Fix the failure if it's directly caused by your change
- If it's a pre-existing failure, document it in notes and do NOT mask it

### 5. Commit
```bash
git add -A
git commit -m "feat($TICKET_ID): <one-line description of what changed>"
```

One commit is preferred. Use multiple only if logically distinct (e.g. migration + feature).

### 6. Write implementation notes
Create `$WORKTREE_PATH/swarm-notes/$TICKET_ID.md`:

```markdown
# $TICKET_ID — Implementation Notes

## What changed
<bullet list of key changes>

## Files modified
<list of files>

## Assumptions
<any assumptions you made about ambiguous requirements>

## Governance conflicts
<NONE — or describe any part of the ticket that would violate .aegis/rules.md and was therefore not implemented>

## Follow-up items
<anything that should be addressed in a future ticket>
```

### 7. Stop
Do NOT merge, push, or modify anything outside your worktree. Signal completion by finishing your last tool call. The orchestrator takes it from here.

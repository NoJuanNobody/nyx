# Merge Strategy

## Ordering

Always merge in this priority order:

1. Tickets with no dependents (leaf nodes in dependency graph) — merge first
2. Tickets that others depend on — merge after their dependencies are in
3. If no dependency info: sort by ticket ID (ascending) for determinism

## Merge command

Always use `--no-ff` to preserve swarm context in history:
```bash
git merge --no-ff swarm/<TICKET_ID> -m "merge(swarm): <TICKET_ID> — <title>"
```

## Conflict resolution rules

| Conflict type | Default action |
|---|---|
| Different files entirely | Auto-merge — no conflict |
| Same file, non-overlapping hunks | Auto-merge — git handles |
| Same file, overlapping hunks | **Pause — ask user** |
| package-lock.json / yarn.lock | Auto-regenerate: delete and run `npm install` |
| Generated files | Take the later branch's version |
| Schema migrations | **Pause — always ask user** |

## Pausing for user input

When pausing, present:
```
⚠️  Conflict in swarm/<TICKET_ID>

File: src/api/export.ts (lines 42–67)

<<<<<<< HEAD (main after previous merges)
  export function exportData(format: string) {
=======
  export function exportData(format: string, options: ExportOptions) {
>>>>>>> swarm/SD-103

Ticket SD-103 added an `options` parameter.
Ticket SD-101 (already merged) did not include this signature.

Options:
  A) Keep SD-103 signature (options param) — likely correct
  B) Keep HEAD signature — loses SD-103's change
  C) Let me resolve manually — I'll paste the resolution
```

Wait for user input. Apply their choice, stage the resolution, then continue the merge.

## After all merges

Run the full test suite once on the merged result:
```bash
$TEST_COMMAND
```

If it fails, do NOT open the PR. Surface the failure with the relevant diff and ask the user how to proceed.

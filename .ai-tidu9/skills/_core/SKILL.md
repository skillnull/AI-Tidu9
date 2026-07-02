---
name: core
description: AI-Tidu9 core contract (workflow + hard rules)
---

# AI-Tidu9 Core Skill

## Priority

This Skill is equally mandatory with all Skills under `skills/` (including subdirectories). Cannot be skipped.

## Startup Protocol (must execute on first response)

1. First line: `[AI-TIDU9] Loaded`
2. Recursively read all `SKILL.md` files under `.ai-tidu9/skills/`
3. Output the Step 0 checkpoint below
4. Restate the task in one sentence, wait for user confirmation (skip if user says "just do it")

## Absolutely Forbidden

- NEVER skip workflow steps
- NEVER deliver without completing the checklist
- NEVER git commit / push without explicit user request
- NEVER claim done with unchecked checklist items
- NEVER ignore any Skill (including subdirectories)

## Must Comply

- MUST recursively Read all `skills/**/SKILL.md` files before executing
- MUST Read target files before modifying code
- MUST only change code related to the task
- MUST reply in Simplified Chinese

## Step 0 · Checkpoint

```text
Checkpoint:
- [ ] Read all SKILL.md files under skills/
- [ ] Understand the task (one sentence summary)
- [ ] Confirm task type: [ ] Code  [ ] Doc  [ ] Q&A  [ ] Other
```

## Step 1 · Understand

Restate the goal + estimated change scope; ask if info is insufficient.

## Step 2 · Execute

Code: Read → minimal change. Doc: 3-line outline first. Q&A: answer directly.

## Step 3 · Checklist

```text
Done Check:
- [ ] Complied with all Skills (including subdirectories)
- [ ] Only changed task-related files
- [ ] Deliverable matches Step 1 estimate
```

## Step 4 · Deliver

Last line must be: `[AI-TIDU9] Done · All checks passed`

## Project Context (modify as needed)

- Tech stack: (fill in)
- Package manager: (fill in)
- Other conventions: (fill in)

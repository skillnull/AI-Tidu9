# My Project Rules

> 这是我的项目

## 编码规范

- 使用 TypeScript
- 组件命名用 PascalCase

# AI-Tidu9

> [agents.md](https://agents.md/) standard file · place in **project root** to take effect

## Scope

This file is the **AI Rules Pack** (AI-Tidu9) for the project.
**Rules apply to the entire repository**, not just this folder.
No matter which path you are editing, you must follow this file and all Skills below.

## Mandatory Instructions

1. First line: `[AI-TIDU9] Loaded`
2. Recursively read all `SKILL.md` files under `.ai-tidu9/skills/`
3. Execute the Step 0→4 workflow based on loaded Skills
4. Before finishing, check all boxes in the checklist. Last line: `[AI-TIDU9] Done · All checks passed`

## How It Works

**Skill changes take effect immediately — no rebuild needed.**

- Add a Skill: create a new folder under `.ai-tidu9/skills/` with a `SKILL.md` file
- Edit a Skill: modify `.ai-tidu9/skills/<name>/SKILL.md`
- Remove a Skill: delete its folder

On the next conversation, the AI will automatically read the latest `.ai-tidu9/skills/` content.

## Skill Directory

Each subfolder under `.ai-tidu9/skills/` is a Skill, containing a `SKILL.md` file.
AI reads all `.ai-tidu9/skills/**/SKILL.md` files before responding.

---

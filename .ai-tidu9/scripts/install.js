#!/usr/bin/env node
/**
 * Post-install script — runs automatically via npm postinstall.
 * Deploys .ai-tidu9/ into the consuming project.
 *
 * Generates:
 *   - AGENTS.md (project root)
 *   - .ai-tidu9/browser.md
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const packDir = path.join(__dirname, "..");

// Generate AGENTS.md
const agentsContent = `# AI-Tidu9

> [agents.md](https://agents.md/) standard file \u00b7 place in **project root** to take effect

## Scope

This file is the **AI Rules Pack** (AI-Tidu9) for the project.
**Rules apply to the entire repository**, not just this folder.
No matter which path you are editing, you must follow this file and all Skills below.

## Mandatory Instructions

1. First line: \`[AI-TIDU9] Loaded\`
2. Recursively read all \`SKILL.md\` files under \`.ai-tidu9/skills/\`
3. Execute the Step 0\u21924 workflow based on loaded Skills
4. Before finishing, check all boxes in the checklist. Last line: \`[AI-TIDU9] Done \u00b7 All checks passed\`

## How It Works

**Skill changes take effect immediately — no rebuild needed.**

- Add a Skill: create a new folder under \`.ai-tidu9/skills/\` with a \`SKILL.md\` file
- Edit a Skill: modify \`.ai-tidu9/skills/<name>/SKILL.md\`
- Remove a Skill: delete its folder

On the next conversation, the AI will automatically read the latest \`.ai-tidu9/skills/\` content.

## Skill Directory

Each subfolder under \`.ai-tidu9/skills/\` is a Skill, containing a \`SKILL.md\` file.
AI reads all \`.ai-tidu9/skills/**/SKILL.md\` files before responding.

---
`;

// Merge or create AGENTS.md
const agentsPath = path.join(root, "AGENTS.md");
if (fs.existsSync(agentsPath)) {
  const existing = fs.readFileSync(agentsPath, "utf8");
  const skillIdx = existing.indexOf("## Skill");
  if (skillIdx !== -1) {
    const beforeSkill = existing.substring(0, skillIdx);
    fs.writeFileSync(agentsPath, beforeSkill + agentsContent);
    console.log("[AI-TIDU9] Updated AGENTS.md");
  } else {
    fs.writeFileSync(agentsPath, agentsContent);
    console.log("[AI-TIDU9] Created AGENTS.md");
  }
} else {
  fs.writeFileSync(agentsPath, agentsContent);
  console.log("[AI-TIDU9] Created AGENTS.md");
}

// Generate browser.md (embeds core skill for browsers that can't read files)
const corePath = path.join(packDir, "skills", "_core", "SKILL.md");
const coreContent = fs.existsSync(corePath) ? fs.readFileSync(corePath, "utf8") : "";

const browserContent = `# AI-Tidu9 (Browser / Chinese LLMs)

Upload or paste into ChatGPT, Claude, Gemini, DeepSeek, Qwen, Kimi, Doubao, etc.

## Mandatory Instructions

1. \`[AI-TIDU9] Loaded\`
2. Recursively read all Skills below
3. Execute the Step 0\u21924 workflow
4. Last line: \`[AI-TIDU9] Done \u00b7 All checks passed\`

## Skills

${coreContent || "(No skills found)"}

---

Send: "Following AI-Tidu9 rules, my task is: ..."
`;

fs.writeFileSync(path.join(packDir, "browser.md"), browserContent);
console.log("[AI-TIDU9] Created .ai-tidu9/browser.md");

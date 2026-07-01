#!/usr/bin/env node
/**
 * Post-install script — runs automatically via npm postinstall.
 *
 * Purpose: deploy .ai-tidu9/ into the consuming project.
 * Generates AGENTS.md (project root) and browser.md (.ai-tidu9/).
 *
 * Skill content is NOT embedded in AGENTS.md.
 * AGENTS.md tells AI to read skills/*.md directly.
 * Modifying skills/ takes effect immediately — no rebuild needed.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "..");
const packDir = path.join(__dirname, "..");

// Walk skills to discover names
function walkSkillNames(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      const skillFile = path.join(full, "SKILL.md");
      if (fs.existsSync(skillFile)) {
        const content = fs.readFileSync(skillFile, "utf8");
        const name = (content.match(/^name:\s*(.+)$/m) || [])[1]?.trim();
        if (name) out.push(name);
      }
      out.push(...walkSkillNames(full));
    }
  }
  return out;
}

const skillsDir = path.join(packDir, "skills");
const skillNames = walkSkillNames(skillsDir);
const names = skillNames.join("、") || "（无）";

// Generate AGENTS.md — no version, no package info
const agentsContent = `# AI-Tidu9

> [agents.md](https://agents.md/) 标准文件 \u00b7 放在**项目根目录**即可生效

## 适用范围

本文件是项目内的 **AI 规则包**（AI-Tidu9）。
**规则对整个仓库生效**，不限于本文件所在目录。
无论当前编辑的文件在仓库哪个路径，都必须遵守本文件及下方全部 Skill。

## 强制指令

1. 第一行：\`[AI-TIDU9] 已加载\`
2. 第二行：\`已加载 Skill：${names}\`
3. 递归读取 \`skills/\` 下全部 \`SKILL.md\` 文件
4. 按读取到的 Skill 内容执行 Step 0\u21924 工作流
5. 结束前完成检查表全 [x]，最后一行：\`[AI-TIDU9] 任务完成 \u00b7 完成检查已全部通过\`

## 使用说明

**Skill 改动即时生效，无需 rebuild。**

- 新增 Skill：在 \`skills/\` 下创建新目录，放入 \`SKILL.md\`
- 修改 Skill：直接编辑 \`skills/xxx/SKILL.md\`
- 删除 Skill：删除对应目录

下次对话时 AI 会自动读取最新的 \`skills/\` 内容。

## Skill 目录

\`skills/\` 目录下每个子文件夹是一个 Skill，每个 Skill 包含一个 \`SKILL.md\` 文件。

当前已加载的 Skill：${names || "（请在 skills/ 目录下添加 SKILL.md）"}

---
*改 skills/ 后直接生效，无需 rebuild*
`;

// Check if AGENTS.md already exists — merge intelligently
const agentsPath = path.join(root, "AGENTS.md");
if (fs.existsSync(agentsPath)) {
  const existing = fs.readFileSync(agentsPath, "utf8");
  const skillIdx = existing.indexOf("## Skill");
  
  if (skillIdx !== -1) {
    const beforeSkill = existing.substring(0, skillIdx);
    const merged = beforeSkill + agentsContent;
    fs.writeFileSync(agentsPath, merged);
    console.log("[AI-TIDU9] Merged -> AGENTS.md (kept existing header)");
  } else {
    fs.writeFileSync(agentsPath, agentsContent);
    console.log("[AI-TIDU9] Created -> AGENTS.md");
  }
} else {
  fs.writeFileSync(agentsPath, agentsContent);
  console.log("[AI-TIDU9] Created -> AGENTS.md");
}

// Generate browser.md — embeds core skill for browser use
// (Browsers can't read skills/ directory, so core is embedded here)
const coreSkillPath = path.join(skillsDir, "_core", "SKILL.md");
let coreContent = "";
if (fs.existsSync(coreSkillPath)) {
  coreContent = fs.readFileSync(coreSkillPath, "utf8");
}

const browserContent = `# AI-Tidu9（浏览器 / 国内大模型）

上传或粘贴到 ChatGPT \u00b7 Claude \u00b7 Gemini \u00b7 DeepSeek \u00b7 千问 \u00b7 Kimi \u00b7 豆包等。

## 强制指令

1. \`[AI-TIDU9] 已加载\`
2. \`已加载 Skill：${names}\`
3. 按下方 Step 0\u21924 执行

## 全部 Skill

${coreContent ? "## core\n\n" + coreContent : "(请上传 .ai-tidu9/skills/_core/SKILL.md)"}

---

发送：「按 AI-Tidu9 规则，我的任务是：……」
`;

fs.writeFileSync(path.join(packDir, "browser.md"), browserContent);
console.log("[AI-TIDU9] Created -> browser.md");
console.log("[AI-TIDU9] Ready! Modify skills/ and it takes effect immediately.");

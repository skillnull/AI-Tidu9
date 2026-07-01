# AI-Tidu9

## 九门赛博提督

**专治 AI 跑偏！** The Cyber-JiumenTidu for LLMs: Keeping your AI from going rogue.

---

AI-Tidu9 是一个 **AI 规则包** —— 一套基于 [agents.md](https://agents.md/) 标准的 Prompt 契约，用于让 AI 编码助手（Cursor、Claude Code、Codex、ChatGPT 等）严格遵循项目规范工作，不再"放飞自我"。

### 核心特性

- 📦 **Skill 改动即时生效** — 改 `skills/` 下的文件，下次对话自动读取，无需 rebuild
- 🔒 **强制契约** — 内置 core skill，定义 Step 0→4 工作流 + 门禁检查
- 🌐 **全平台兼容** — IDE 内嵌（AGENTS.md）+ 浏览器上传（browser.md）
- 📦 **npm 一键安装** — `npm install @ai-tidu9/core` 自动生成所有文件

### 安装方式

#### npm 安装（推荐）

```bash
npm install @ai-tidu9/core
```

安装后自动生成：
- 项目根目录 `AGENTS.md`（指向 `skills/` 目录）
- `.ai-tidu9/` 目录（包含所有规则文件和 Skill 源）

#### 手动安装

```bash
# 1. 复制 .ai-tidu9 文件夹到项目根目录
cp -r .ai-tidu9 /path/to/your-project/

# 2. 进入项目，运行安装脚本
cd /path/to/your-project
node .ai-tidu9/scripts/install.js
```

### 目录结构

```
your-project/
├── AGENTS.md              ← 项目根目录（AI 助手自动加载）
├── package.json           ← 版本信息源（npm 包发布配置）
└── .ai-tidu9/             ← 规则包本体
    ├── browser.md         ← 浏览器 / 国内大模型上传用
    ├── manifest.json      ← 元信息（版本从 package.json 同步）
    ├── scripts/
    │   └── install.js     ← 安装/初始化脚本（postinstall 自动运行）
    └── skills/            ← Skill 目录（改这里即时生效！）
        └── _core/
            └── SKILL.md   ← core 契约
```

### 使用方式

#### 日常开发

改 Skill 文件，直接生效：

```bash
# 新增 Skill
mkdir -p .ai-tidu9/skills/my-rule
cat > .ai-tidu9/skills/my-rule/SKILL.md << 'EOF'
---
name: my-rule
description: 何时触发
---

# 我的规则
（指令正文）
EOF

# 下次对话自动生效，无需 rebuild
```

#### 浏览器 / 国内大模型

上传 `.ai-tidu9/browser.md` 文件，或复制其内容粘贴到对话框。

### 兼容性说明

| 工具 | 生效方式 | 可靠性 |
|------|---------|--------|
| ChatGPT / Claude / 国内大模型 | 上传 `browser.md` | ✅ 最高 |
| Cursor（项目根有 `AGENTS.md`） | 自动加载 | ✅ 100% |
| Codex / Claude Code（项目根有 `AGENTS.md`） | 自动加载 | ✅ 100% |
| Trae（项目根有 `AGENTS.md`） | 自动加载 | ✅ 100% |

> **关键**：把 `AGENTS.md` 放在**项目根目录**，AI 助手会在编辑任何文件时自动加载规则。

### 已有 AGENTS.md 怎么办？

如果项目中已有 `AGENTS.md`，运行 `install.js` 会自动合并：
- 保留原有头部内容（标题、描述、项目自定义规则等）
- 替换 Skill 相关部分

### 版本管理

版本号统一在 `package.json` 中管理，`install.js` 运行时自动同步到 `.ai-tidu9/manifest.json` 和 `AGENTS.md`。

---

*九门赛博提督 · 让 AI 守规矩*

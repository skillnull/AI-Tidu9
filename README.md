# AI-Tidu9

## 九门赛博提督

**专治 AI 跑偏！** The Cyber-JiumenTidu for LLMs: Keeping your AI from going rogue.

---

AI-Tidu9 是一个 **AI 规则包** —— 一套基于 [agents.md](https://agents.md/) 标准的 Prompt 契约，用于让 AI 编码助手（Cursor、Claude Code、Codex、ChatGPT 等）严格遵循项目规范工作。

### 核心特性

- 📦 **Skill 改动即时生效** — 改 `.ai-tidu9/skills/` 下的文件，下次对话自动读取
- 🔒 **强制契约** — 内置 core skill，定义 Step 0→4 工作流 + 门禁检查
- 🌐 **全平台兼容** — IDE 内嵌（AGENTS.md）+ 浏览器上传（browser.md）

### 安装

```bash
> npm i @skillnull/ai-tidu9

or 

> yarn add @skillnull/ai-tidu9

or 

> pnpm i @skillnull/ai-tidu9
```

安装后自动生成：
- 项目根目录 `AGENTS.md`
- `.ai-tidu9/` 目录（包含规则和 Skill 文件）

### 目录结构

```
your-project/
├── AGENTS.md              ← 项目根目录（AI 助手自动加载）
└── .ai-tidu9/             ← 规则包本体（安装后生成）
    ├── browser.md         ← 浏览器 / 国内大模型上传用
    ├── scripts/
    │   └── install.js     ← 安装脚本（npm postinstall 自动运行）
    └── skills/            ← Skill 目录（改这里即时生效）
        └── _core/
            └── SKILL.md   ← core 契约
```

### 添加新 Skill

```bash
mkdir -p .ai-tidu9/skills/my-rule
cat > .ai-tidu9/skills/my-rule/SKILL.md << 'EOF'
---
name: my-rule
description: 何时触发
---

# 我的规则
（指令正文）
EOF

# 下次对话自动生效，无需任何操作
```

### 兼容性

| 工具 | 生效方式 |
|------|---------|
| Cursor / Claude Code / Codex | 项目根 `AGENTS.md` 自动加载 |
| ChatGPT / Claude Web / 国内大模型 | 上传 `browser.md` |
| Trae | 项目根 `AGENTS.md` 自动加载 |

### 已有 AGENTS.md？

运行安装脚本后会自动合并：保留原有头部内容，替换 Skill 相关部分。

---

## 核心原理

AI-Tidu9 的工作原理基于 [agents.md](https://agents.md/) 标准：

```
AGENTS.md（项目根）
  │
  ├─ 告诉 AI：读取 .ai-tidu9/skills/**/SKILL.md
  │
  └─ AI 在每次对话前自动读取这些文件
         │
         ├─ core/SKILL.md  → 定义工作流（Step 0→4）
         ├─ my-rule/SKILL.md  → 项目特定规则
         └─ ... 更多 Skill
```

**关键设计决策：**

1. **Skill 内容不嵌入 AGENTS.md** — AGENTS.md 只告诉 AI "去哪里读 Skill"，不预先写入内容。因此新增/修改 Skill 不需要 rebuild，AI 下次对话自然读到最新内容。

2. **browser.md 内联 core skill** — 浏览器 AI 无法读取项目文件，所以 browser.md 内联了 core skill 的完整内容。新增的 skill 需要通过上传完整 browser.md 来覆盖。

3. **版本单一事实来源** — 版本号只在 `package.json` 中管理，安装时同步到 `AGENTS.md` 和 `browser.md`。

4. **智能合并** — 如果项目已有 `AGENTS.md`，安装脚本保留原有头部（标题、描述、项目自定义规则），只替换 `## Skill` 之后的内容。

### 为什么不需要 build 脚本？

传统方案：改 Skill → 运行 build.js → 生成 AGENTS.md → AI 读到新内容

AI-Tidu9 方案：改 Skill → 下次对话 AI 自动读取 → 新内容生效

区别在于 AGENTS.md 的角色不同：
- 传统方案：AGENTS.md = Skill 内容的静态快照
- AI-Tidu9：AGENTS.md = 指向 Skill 文件的导航指令

AI 助手（Cursor、Claude Code 等）在收到请求时会先读取 AGENTS.md，然后根据其中的指令去读取 `.ai-tidu9/skills/` 下的文件。这是一个动态过程，Skill 文件本身就是数据源，不需要编译。

---

*九门赛博提督 · 让 AI 守规矩*

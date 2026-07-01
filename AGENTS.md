# AI-Tidu9

> [agents.md](https://agents.md/) 标准文件 · 放在**项目根目录**即可生效

## 适用范围

本文件是项目内的 **AI 规则包**（AI-Tidu9）。
**规则对整个仓库生效**，不限于本文件所在目录。
无论当前编辑的文件在仓库哪个路径，都必须遵守本文件及下方全部 Skill。

## 强制指令

1. 第一行：`[AI-TIDU9] 已加载`
2. 第二行：`已加载 Skill：core`
3. 递归读取 `skills/` 下全部 `SKILL.md` 文件
4. 按读取到的 Skill 内容执行 Step 0→4 工作流
5. 结束前完成检查表全 [x]，最后一行：`[AI-TIDU9] 任务完成 · 完成检查已全部通过`

## 使用说明

**Skill 改动即时生效，无需 rebuild。**

- 新增 Skill：在 `skills/` 下创建新目录，放入 `SKILL.md`
- 修改 Skill：直接编辑 `skills/xxx/SKILL.md`
- 删除 Skill：删除对应目录

下次对话时 AI 会自动读取最新的 `skills/` 内容。

# AI-Tidu9

> [agents.md](https://agents.md/) 标准文件 · 放在**项目根目录**即可生效

## 适用范围

本文件是项目内的 **AI 规则包**（AI-Tidu9）。
**规则对整个仓库生效**，不限于本文件所在目录。
无论当前编辑的文件在仓库哪个路径，都必须遵守本文件及下方全部 Skill。

## 强制指令

1. 第一行：`[AI-TIDU9] 已加载`
2. 第二行：`已加载 Skill：core`
3. 递归读取 `skills/` 下全部 `SKILL.md` 文件
4. 按读取到的 Skill 内容执行 Step 0→4 工作流
5. 结束前完成检查表全 [x]，最后一行：`[AI-TIDU9] 任务完成 · 完成检查已全部通过`

## 使用说明

**Skill 改动即时生效，无需 rebuild。**

- 新增 Skill：在 `skills/` 下创建新目录，放入 `SKILL.md`
- 修改 Skill：直接编辑 `skills/xxx/SKILL.md`
- 删除 Skill：删除对应目录

下次对话时 AI 会自动读取最新的 `skills/` 内容。

## Skill 目录

`skills/` 目录下每个子文件夹是一个 Skill，每个 Skill 包含一个 `SKILL.md` 文件。

当前已加载的 Skill：core

---
*改 skills/ 后直接生效，无需 rebuild*

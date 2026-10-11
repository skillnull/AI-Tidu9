# AI-Tidu9 Project Rules

## Scope

These rules apply to the entire repository.

## Product

- Name: 九门赛博提督
- Explanation: 九门赛博提督·智能协作中枢
- Positioning: 九门赛博提督是面向全领域场景的智能协作中枢，以目标驱动内外部 Agent、模型、工具、知识与专家协同执行，交付可验证的业务结果。

## Engineering rules

- Use TypeScript for product code.
- Keep the architecture modular, cohesive, and replaceable at adapter boundaries.
- Keep personal mode lightweight; enterprise infrastructure must remain optional.
- Never read or reuse private credentials from Codex, Cursor, browsers, or other clients.
- Never bypass mandatory policy, quota, approval, or verification gates.
- Keep public repository content free of personal paths, accounts, company-confidential data, and secrets.
- Keep Chinese and English public documentation synchronized.
- Read a target file before editing it and limit changes to the active task.
- Run relevant checks before reporting completion.
- Do not commit, tag, publish, or push without explicit user confirmation.

## Response protocol

- First line: `[AI-TIDU9] Loaded`
- Use Simplified Chinese for user-facing communication unless requested otherwise.
- Last line after completed checks: `[AI-TIDU9] Done · All checks passed`

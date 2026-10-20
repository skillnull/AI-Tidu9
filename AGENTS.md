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
- Follow `docs/CONTRIBUTING.md` for branch, commit, pull-request, version, and release rules.
- Treat `main` as the sole future-facing integration trunk. A major version has exactly one active owner: either `main` or `support/<major>.x`, never both.
- Never merge protected release lines into each other. Synchronize applicable fixes through focused backport or forward-port pull requests.
- Release only from an immutable `v<version>` tag whose version matches the repository version.
- Read a target file before editing it and limit changes to the active task.
- Treat every resolved user-visible behavior as a regression baseline. Before reporting a related change complete, audit and synchronize every affected UI surface, API, configuration path, test, and bilingual document.
- Fix root causes instead of screenshot-local symptoms. Do not reintroduce resolved latency, routing, naming, process-visibility, client-discovery, mode-marker, or navigation regressions.
- For performance work, compare time to first visible progress and end-to-end latency before and after the change with the same host, model, and input. Do not mark a speed issue fixed merely because the request eventually succeeds.
- Run relevant checks before reporting completion.
- Do not commit, tag, publish, or push without explicit user confirmation.

## Response protocol

- Only when a system or developer instruction explicitly states that the active request is routed through AI-Tidu9, use `[AI-TIDU9] Loaded` as the first line.
- Never infer AI-Tidu9 routing from this repository, its files, or the current working directory. Official direct mode must not inject an AI-Tidu9 loading marker.
- Use Simplified Chinese for user-facing communication unless requested otherwise.
- When the active request is routed through AI-Tidu9, use `[AI-TIDU9] Done · All checks passed` after completed checks.

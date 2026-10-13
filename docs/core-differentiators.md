# 核心调度与门禁 / Core Routing and Secret Gate

## 中文

`v0.4.0-beta.1` 将九门赛博提督从单模型代理推进为可组合的智能协作入口。它不训练模型，也不复制宿主账号；它在本地运行时完成模型选择、能力补全、能力资产装配、敏感信息门禁和结果验收。

### 动态模型路由

公开 SDK 的 `createDynamicModelRouter(models, policy)` 接收一组模型适配器及其非敏感元数据：能力、输入/输出单价、延迟、可用率、隐私边界、剩余额度和启用状态。路由器会：

1. 从协议、工具、结构化输出、图像输入和调用方约束中推断所需能力；
2. 先过滤停用、额度耗尽及不满足隐私边界的模型；
3. 联合评估能力、成本、隐私、延迟和可用性；
4. 优先使用配置的主模型；主模型能力不足且能力补全已启用时，只从显式允许的专家池中选择有限数量的模型；
5. 将专家的有界结果作为证据交给主模型，而不是让专家接管整段会话；
6. 主模型返回 `429` 时，将其标记为当前进程内额度耗尽并选择下一候选模型。

能力补全默认不是隐式开启项。调用者必须设置 `capabilityCompletion.enabled`、允许进入池子的模型 ID 和单次最大专家数。免费模型和 Ollama 等本地模型使用零成本及 `local` 隐私元数据即可进入同一个评分体系。

### 按需能力装配

`createCapabilityRegistry` 用统一元数据描述 Agent、Skill、MCP、工具和知识。Agent 在理解目标后，按能力覆盖数、成本和隐私边界选择最小集合，再把选择结果交给规划器并写入轻量任务胶囊。必要能力无法满足时，任务在执行前失败关闭，不会假装具备该能力。

### Runtime Secret Gate

运行时和 Agent 内核默认启用 Secret Gate：

- 自动识别私钥、Bearer Token、JWT、常见供应商密钥、AWS Access Key 和敏感字段；
- 支持用户或组织增加显式正则规则，并选择阻断或本地替换；
- 每个任务使用独立、带容量和生命周期上限的内存作用域，不把真实值写入 SQLite；
- 外部模型和外部工具只能看到占位符，只有标记为 `executionLocation: "local"` 的受信工具可在同一任务作用域恢复；
- 所有标准运行时模型请求和 Agent 工具调用都经过同一门禁，任务完成或取消后立即销毁对应内存值。

自动检测是纵深防御，不等于能够识别世界上所有未知秘密。高敏场景应增加明确阻断规则，并在网络出口、供应商合同和客户端管理层继续实施控制。自定义代码如果绕过九门运行时直接调用网络，不属于九门能够拦截的出口。

### 可复现成本与能力补全案例

仓库测试 `routing/index.test.ts` 执行了一个真实的路由调用链：文本与结构化输出由低成本主模型处理，视觉能力由专家模型补全，专家结果注入主模型后再生成最终结果。

| 路由 | 配置单价（输入+输出，每百万 Token） | 调用数 | 能力 |
| --- | ---: | ---: | --- |
| 低成本主模型 | 0.30 | 1 | 文本、结构化输出 |
| 视觉专家 | 0.30 | 1 | 文本、视觉 |
| 组合结果 | 0.60 | 2 | 文本、结构化输出、视觉 |

测试同时验证了专家池为显式选择、最终主模型确实收到专家输出、隐私约束会排除外部模型、零成本本地模型可被选择、主模型 `429` 后可回退。这里的 0.60 是按配置价格得出的可复现路由估算，不是供应商账单；生产环境必须用供应商权威用量完成结算。

### 最小配置示例

```ts
const router = createDynamicModelRouter(
  [cheapMain, visionSpecialist, localFallback],
  {
    enabled: true,
    mainModelId: "cheap-main",
    weights: { capability: 5, cost: 3, privacy: 2, latency: 1, availability: 2 },
    capabilityCompletion: {
      enabled: true,
      poolModelIds: ["vision-specialist", "local-fallback"],
      maximumSpecialists: 2,
    },
  },
);

await startLocalRuntime({ provider: router });
```

配置只保存模型 ID 与非敏感路由元数据。供应商凭据继续由各自适配器在运行时持有，不进入路由决策、诊断信息或任务胶囊。

## English

`v0.4.0-beta.1` evolves AI-Tidu9 from a single-provider proxy into a composable collaboration entry point. It does not train models or copy host credentials. The local runtime selects models, completes missing capabilities, assembles capability assets, protects secrets, and verifies results.

`createDynamicModelRouter(models, policy)` evaluates declared capabilities, configured input/output price, latency, availability, privacy, quota, and enabled state. It filters ineligible models first, prefers the configured main model, invokes only explicitly allowed and bounded specialists when completion is enabled, supplies their bounded output to the main model as evidence, and falls back after a `429` quota response. Zero-cost and local models participate through the same metadata contract.

`createCapabilityRegistry` describes Agents, Skills, MCP servers, tools, and knowledge through one bounded contract. The Agent kernel selects a minimal privacy-compatible set after goal understanding and fails before execution when a required capability is unavailable.

The Runtime Secret Gate is enabled by default for the standard runtime and Agent kernel. It detects common credential forms, supports explicit block or redact rules, retains recoverable values only in isolated in-memory task scopes, sends placeholders to external models and tools, and restores values only for explicitly local trusted tools. Completed and cancelled task scopes are destroyed immediately.

Automatic detection is defense in depth, not a promise to recognize every unknown secret. High-sensitivity deployments should add explicit rules and retain network, supplier, and endpoint controls. Custom code that bypasses the AI-Tidu9 runtime and performs its own network call is outside this gate.

The reproducible routing test performs the documented cheap-main plus vision-specialist call chain. Its configured combined estimate is 0.60 per million input-plus-output tokens. This is routing evidence, not a provider invoice; production settlement must use provider-authoritative usage.

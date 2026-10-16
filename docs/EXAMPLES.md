# 使用实例

[README](../README.md) · [English](./EXAMPLES.EN.md)

这些实例对应当前公开 CLI、HTTP API 和 SDK。命令中的模型名、地址和 Provider ID 是示例值；凭据必须由本地环境或部署密钥系统注入，不要写入命令、代码、配置文件或仓库。

除 Python 专属片段外，命令和 TypeScript 实例要求 Node.js 22.14 或更高版本。

## 🧭 快速定位

| 目标 | 实例 | 适合谁 |
| --- | --- | --- |
| 零外部费用运行一个本地模型 | [本机 Ollama](#example-local-ollama) | 个人用户、开发者 |
| 把现有模型服务变成 AI-Tidu9 统一入口 | [OpenAI 兼容服务](#example-openai-compatible) | 个人、团队 |
| 让现有客户端像选模型一样调用 AI-Tidu9 | [通用客户端](#example-generic-client) | 客户端使用者 |
| 接入 Codex、Cursor 和 CLI | [宿主连接器](#example-host-connectors) | Agent 用户 |
| 启动企业单机试点 | [远程部署文档](./REMOTE-DEPLOYMENT.md) | 管理员、平台团队 |
| 开发自己的能力并受 AI-Tidu9 治理 | [Provider SDK](#example-provider-sdk) | Agent 工程师 |
| 在模型出站前保护敏感值 | [Secret Gate](#example-secret-gate) | 安全与平台工程师 |

<a id="example-local-ollama"></a>
## 🖥️ 本机 Ollama：零外部推理费用

### 🎯 目标

使用本机 Ollama 作为真实模型，AI-Tidu9 提供统一虚拟模型入口。模型数据保持在本机，路由成本可配置为零。

### ▶️ 启动

确保 Ollama 已运行且模型已经存在，然后执行：

```bash
TIDU_PROVIDER=ollama \
TIDU_PROVIDER_MODEL=qwen3:8b \
tidu start
```

### ✅ 验证

```bash
curl -fsS http://127.0.0.1:9639/health
curl -fsS http://127.0.0.1:9639/v1/models
```

默认配置返回的模型 ID 是 `ai-tidu9-config`。如果 `/v1/models` 返回其他 ID，请在请求中使用实际值：

```bash
curl -fsS http://127.0.0.1:9639/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "ai-tidu9-config",
    "messages": [{"role": "user", "content": "用三点说明能力补全的价值"}]
  }'
```

### 📌 预期结果

- `/health` 返回 `status: "ok"`；
- `/v1/models` 返回一个 `owned_by: "AI-Tidu9"` 的虚拟模型；
- 推理响应中的模型标识保持为 AI-Tidu9 虚拟模型 ID，而不是泄露上游模型身份。

### 🛡️ 能力边界

- Ollama 的模型能力、上下文长度和硬件占用仍由模型本身决定；
- AI-Tidu9 负责统一入口、路由与治理，不把本地模型包装成它并不具备的能力。

<a id="example-openai-compatible"></a>
## 🌐 OpenAI 兼容服务：保留统一入口

### 🎯 目标

复用现有 OpenAI 或兼容中转服务，同时把入口、模型显示名、策略和后续调度留在 AI-Tidu9。

### ▶️ 启动

先通过本地密钥管理工具注入 `TIDU_PROVIDER_API_KEY`。下面的检查只确认变量存在，不会输出它：

```bash
: "${TIDU_PROVIDER_API_KEY:?inject with your local secret manager}"

export TIDU_PROVIDER=openai-compatible
export TIDU_PROVIDER_MODEL=gpt-4.1-mini
export TIDU_PROVIDER_BASE_URL=https://api.openai.com/v1
tidu start
```

兼容中转服务必须使用 HTTPS。只有 `localhost`、`127.0.0.1` 和 `::1` 可以使用 HTTP。

### ✅ 验证

```bash
curl -fsS http://127.0.0.1:9639/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "ai-tidu9-config",
    "input": "返回一句简短的运行状态说明"
  }'
```

### 📌 预期结果

AI-Tidu9 验证请求、把虚拟模型 ID 替换为真实上游模型、转发调用，并在返回结果中恢复虚拟模型身份。凭据不会进入 SQLite、配置中心响应或任务胶囊。

<a id="example-generic-client"></a>
## 🔌 通用客户端：像选择模型一样接入

### 🎯 目标

让支持自定义 OpenAI Base URL 的客户端把 AI-Tidu9 当作一个模型服务使用。

### ⚙️ 客户端配置

| 字段 | 本机个人版 |
| --- | --- |
| Base URL | `http://127.0.0.1:9639/v1` |
| Model | 从 `GET /v1/models` 读取，默认 `ai-tidu9-config` |
| API Key | 客户端强制要求时填写非敏感占位值；本机 AI-Tidu9 不依赖它 |

配置后先执行模型列表请求，再发送一条最小对话。如果客户端只支持 Chat Completions，使用 `/v1/chat/completions`；支持 Responses 时也可以使用 `/v1/responses`。

> [!WARNING]
> 上表只适用于回环地址上的个人模式。企业或跨设备访问必须经过 HTTPS、身份认证和组织网关，不能继续使用本机占位认证。

<a id="example-host-connectors"></a>
## 🧩 宿主连接器：复用现有工作入口

### 🎯 目标

在 Codex、Cursor、CLI 和浏览器入口共享同一个 AI-Tidu9 运行时，同时保留宿主负责的会话、权限和本地工具能力。

### 📦 持久安装

```bash
npm install -g @skillnull/tidu
tidu start
```

另开一个终端：

```bash
tidu clients
tidu account
tidu setup install
tidu setup verify
```

### 📌 预期结果

- `tidu clients` 只报告检测结果，不读取配置正文、Token 或会话；
- `tidu account` 使用宿主官方状态能力返回脱敏登录状态；
- `tidu setup install` 只创建 AI-Tidu9 拥有的连接器注册项；
- `tidu setup verify` 只验证，不修改连接器。

### ♻️ 失败恢复

```bash
tidu setup repair
tidu clients rollback codex
```

<a id="example-provider-sdk"></a>
## 🛠️ Provider SDK：开发受治理的能力

### 🎯 目标

定义一个代码审查 Agent Provider，通过完整性校验和最小权限运行，再执行 SDK 冒烟测试。

```ts
import {
  CAPABILITY_PROVIDER_PROTOCOL_VERSION,
  type CapabilityProviderManifest,
  createCapabilityRuntime,
  createProviderIntegrity,
  defineCapabilityProvider,
  testCapabilityProvider,
} from "@skillnull/tidu/ecosystem";
import { startLocalRuntime } from "@skillnull/tidu";

const unsignedManifest: CapabilityProviderManifest = {
  id: "company.example-reviewer",
  name: "Example reviewer",
  version: "1.0.0",
  protocolVersion: CAPABILITY_PROVIDER_PROTOCOL_VERSION,
  kind: "agent",
  source: "enterprise",
  capabilities: ["code.review"],
  permissions: ["agent.delegate"],
  trust: "trusted",
};

const reviewer = defineCapabilityProvider({
  manifest: {
    ...unsignedManifest,
    integrity: createProviderIntegrity(unsignedManifest),
  },
  invoke: async ({ input }) => ({
    output: { accepted: true, input },
    evidence: ["review-complete"],
  }),
});

const report = await testCapabilityProvider(reviewer, {
  operation: "agent.delegate",
  input: { goal: "Review a bounded change" },
  timeoutMs: 2_000,
  maximumOutputBytes: 16_384,
});

const runtime = createCapabilityRuntime({
  grantedPermissions: ["agent.delegate"],
});
const result = await runtime.invoke(reviewer, {
  operation: "agent.delegate",
  input: { goal: "Review a bounded change" },
});

if (!report.passed) {
  throw new Error(report.problems.join("\n"));
}

const platform = await startLocalRuntime({
  capabilityProviders: [reviewer],
  capabilityRuntime: runtime,
});

console.log(result.evidence, platform.origin);
```

仓库中的完整实现位于 `packages/tidu/src/ecosystem/example-provider.ts`。不可信 Provider 必须经过外部隔离执行器并返回有效运行时证明，否则调用会失败关闭。

### 🐍 Python 调用同一个 Provider

```python
from ai_tidu9 import TiduClient

client = TiduClient("http://127.0.0.1:9639")
result = client.invoke_provider(
    "company.example-reviewer",
    "agent.delegate",
    {"goal": "Review a bounded change"},
    timeout_ms=2_000,
    maximum_output_bytes=16_384,
)

print(result.output)
print(result.evidence)
```

<a id="example-secret-gate"></a>
## 🔐 Secret Gate：保护模型出站数据

### 🎯 目标

在内容发送给外部模型前自动替换常见凭据，并对组织指定格式执行强制阻断。

```ts
import { createSecretGate } from "@skillnull/tidu";

const internalToken = process.env.INTERNAL_TOKEN;
if (!internalToken) {
  throw new Error("INTERNAL_TOKEN must be injected at runtime.");
}

const gate = createSecretGate({
  rules: [
    {
      id: "internal-account",
      pattern: "account-[0-9]{4}",
      action: "block",
    },
  ],
});

const scopeId = "task-example";
const protectedRequest = gate.protect(
  {
    command: `curl -H 'Authorization: Bearer ${internalToken}' https://service.example`,
  },
  { scopeId, destination: "model" },
);

console.log(protectedRequest.findings);

// Only a trusted local execution boundary may recover the original value.
const localRequest = gate.recover(protectedRequest.value, scopeId);
// Pass localRequest only to an existing trusted local runner with strict command policy.
void localRequest;
gate.closeScope(scopeId);
```

`protectedRequest.value` 中只有任务作用域占位符。真实值不会进入模型请求、SQLite 或诊断信息。`recover` 只接受同一作用域；任务完成或取消后应立即调用 `closeScope`。

> [!IMPORTANT]
> `localRequest` 只能交给应用已有的受信本地执行器。生产代码必须限制命令、参数、环境和网络目标，不能把模型生成的任意字符串直接交给 Shell。

## 🧭 下一步

- 安装、诊断、恢复和卸载：[CLI 命令参考](./CLI-REFERENCE.md)
- 动态模型路由与能力补全：[核心调度与门禁](./CORE-DIFFERENTIATORS.md)
- Provider 信任、签名与兼容策略：[开放能力生态](./ECOSYSTEM-SDK.md)
- Python 完整 API：[Python SDK](../sdk/python/README.md)

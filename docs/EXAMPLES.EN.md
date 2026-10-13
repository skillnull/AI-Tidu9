# Practical Examples

[README](./README.EN.md) · [简体中文](./EXAMPLES.md)

These examples match the public CLI, HTTP API, and SDK. Model names, addresses, and provider IDs are illustrative. Inject credentials through the local environment or deployment secret system; never put them in commands, source code, configuration files, or the repository.

Except for Python-specific snippets, the commands and TypeScript examples require Node.js 22.14 or newer.

## 🧭 Quick navigation

| Goal | Example | Best for |
| --- | --- | --- |
| Run a local model with no external inference cost | [Local Ollama](#example-local-ollama) | Individuals, developers |
| Put an existing model service behind one entry | [OpenAI-compatible service](#example-openai-compatible) | Individuals, teams |
| Use AI-Tidu9 like a model from an existing client | [Generic client](#example-generic-client) | Client users |
| Connect Codex, Cursor, and CLI hosts | [Host connectors](#example-host-connectors) | Agent users |
| Start a single-host enterprise pilot | [Docker + PostgreSQL](#example-enterprise-pilot) | Administrators, platform teams |
| Build a governed capability | [Provider SDK](#example-provider-sdk) | Agent engineers |
| Protect sensitive values before model egress | [Secret Gate](#example-secret-gate) | Security and platform engineers |

<a id="example-local-ollama"></a>
## 🖥️ Local Ollama: zero external inference cost

### 🎯 Goal

Use a local Ollama model behind the AI-Tidu9 virtual-model entry. Model data stays local, and routing cost can be configured as zero.

### ▶️ Start

Make sure Ollama is running and the model is available, then run:

```bash
TIDU_PROVIDER=ollama \
TIDU_PROVIDER_MODEL=qwen3:8b \
npx @skillnull/tidu start
```

### ✅ Verify

```bash
curl -fsS http://127.0.0.1:9639/health
curl -fsS http://127.0.0.1:9639/v1/models
```

The default virtual model ID is `managed-default`. If `/v1/models` returns another ID, use that value:

```bash
curl -fsS http://127.0.0.1:9639/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "managed-default",
    "messages": [{"role": "user", "content": "Explain capability completion in three points"}]
  }'
```

### 📌 Expected result

- `/health` returns `status: "ok"`;
- `/v1/models` returns a virtual model with `owned_by: "AI-Tidu9"`;
- The response preserves the virtual model identity instead of exposing the upstream model.

### 🛡️ Capability boundary

Ollama model capability, context size, and hardware demand still depend on the selected model. AI-Tidu9 provides entry, routing, and governance; it does not claim capabilities the local model lacks.

<a id="example-openai-compatible"></a>
## 🌐 OpenAI-compatible service: preserve one entry

### 🎯 Goal

Reuse an existing OpenAI or compatible relay service while keeping the entry, visible model name, policies, and routing under AI-Tidu9 control.

### ▶️ Start

Inject `TIDU_PROVIDER_API_KEY` with a local secret manager. This guard checks only that it exists:

```bash
: "${TIDU_PROVIDER_API_KEY:?inject with your local secret manager}"

export TIDU_PROVIDER=openai-compatible
export TIDU_PROVIDER_MODEL=gpt-4.1-mini
export TIDU_PROVIDER_BASE_URL=https://api.openai.com/v1
npx @skillnull/tidu start
```

Compatible remote services must use HTTPS. HTTP is accepted only for `localhost`, `127.0.0.1`, and `::1`.

### ✅ Verify

```bash
curl -fsS http://127.0.0.1:9639/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "managed-default",
    "input": "Return one short runtime status sentence"
  }'
```

### 📌 Expected result

AI-Tidu9 validates the request, replaces the virtual model ID with the upstream model, forwards the call, and restores the virtual identity in the response. Credentials do not enter SQLite, configuration responses, or task capsules.

<a id="example-generic-client"></a>
## 🔌 Generic client: connect like a model

### 🎯 Goal

Connect any client that supports a custom OpenAI Base URL.

### ⚙️ Client configuration

| Field | Local personal mode |
| --- | --- |
| Base URL | `http://127.0.0.1:9639/v1` |
| Model | Read from `GET /v1/models`; default: `managed-default` |
| API Key | Use a non-sensitive placeholder only if the client requires a value |

Fetch the model list before sending a minimal conversation. Use `/v1/chat/completions` for Chat Completions-only clients or `/v1/responses` when supported.

> [!WARNING]
> This placeholder-authentication setup applies only to personal mode on a loopback address. Enterprise or cross-device access requires HTTPS, identity authentication, and the organization gateway.

<a id="example-host-connectors"></a>
## 🧩 Host connectors: keep existing work surfaces

### 🎯 Goal

Share one AI-Tidu9 runtime across Codex, Cursor, CLI, and browser entries while each host retains its own conversations, permissions, and local-tool behavior.

### 📦 Persistent installation

```bash
npm install -g @skillnull/tidu
tidu start
```

In another terminal:

```bash
tidu clients
tidu account
tidu setup install
tidu setup verify
```

### 📌 Expected result

- `tidu clients` reports detection only; it does not read configuration bodies, tokens, or sessions;
- `tidu account` returns a redacted login state through official host status capabilities;
- `tidu setup install` creates only connector entries owned by AI-Tidu9;
- `tidu setup verify` validates without changing connectors.

### ♻️ Recovery

```bash
tidu setup repair
tidu clients rollback codex
```

<a id="example-enterprise-pilot"></a>
## 🏢 Enterprise pilot: start with one server

### 🎯 Goal

Run AI-Tidu9 and PostgreSQL on one server, bound to loopback, then expose controlled cross-device access through an existing HTTPS gateway.

### ▶️ Start

Inject `TIDU_POSTGRES_PASSWORD` through the deployment system, then run:

```bash
: "${TIDU_POSTGRES_PASSWORD:?inject with your deployment secret system}"
docker compose -f config/docker/compose.yml up --build
```

### ✅ Verify

Verify on the server:

```bash
curl -fsS http://127.0.0.1:9639/health
docker compose -f config/docker/compose.yml ps
```

### 📌 Expected result

The runtime and PostgreSQL should be healthy, the management port should bind only to `127.0.0.1`, and enterprise state should use PostgreSQL while personal mode can continue using SQLite.

### 🚦 Before production

Before expanding the pilot, configure HTTPS, identity authentication, organization scope, and access logs at the gateway. Test capacity, backup recovery, administrator-key rotation, upgrades, and rollback.

<a id="example-provider-sdk"></a>
## 🛠️ Provider SDK: build a governed capability

### 🎯 Goal

Define a code-review Agent Provider, validate integrity and least privilege, then run an SDK smoke test.

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

if (!report.passed) throw new Error(report.problems.join("\n"));

const platform = await startLocalRuntime({
  capabilityProviders: [reviewer],
  capabilityRuntime: runtime,
});

console.log(result.evidence, platform.origin);
```

The complete repository example is `packages/tidu/src/ecosystem/example-provider.ts`. An untrusted Provider must run through an external isolation executor and return valid runtime proof; otherwise invocation fails closed.

### 🐍 Python client

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
## 🔐 Secret Gate: protect model egress

### 🎯 Goal

Replace common credentials before content leaves for an external model, and block organization-specific formats.

```ts
import { createSecretGate } from "@skillnull/tidu";

const internalToken = process.env.INTERNAL_TOKEN;
if (!internalToken) throw new Error("INTERNAL_TOKEN must be injected at runtime.");

const gate = createSecretGate({
  rules: [{
    id: "internal-account",
    pattern: "account-[0-9]{4}",
    action: "block",
  }],
});

const scopeId = "task-example";
const protectedRequest = gate.protect(
  { command: `curl -H 'Authorization: Bearer ${internalToken}' https://service.example` },
  { scopeId, destination: "model" },
);

console.log(protectedRequest.findings);
const localRequest = gate.recover(protectedRequest.value, scopeId);
void localRequest;
gate.closeScope(scopeId);
```

`protectedRequest.value` contains task-scoped placeholders only. Real values do not enter model requests, SQLite, or diagnostics. `recover` accepts only the same scope, and `closeScope` should run immediately after completion or cancellation.

> [!IMPORTANT]
> Pass `localRequest` only to an existing trusted local executor. Production code must restrict commands, arguments, environment, and network targets; never send arbitrary model-generated strings directly to a shell.

## 🧭 Next steps

- Installation, diagnostics, recovery, and removal: [CLI Command Reference](./CLI-REFERENCE.EN.md)
- Dynamic routing and capability completion: [Core Routing and Secret Gate](./CORE-DIFFERENTIATORS.EN.md)
- Provider trust, integrity, and compatibility: [Open Capability Ecosystem](./ECOSYSTEM-SDK.EN.md)
- Complete Python API: [Python SDK](../sdk/python/README.EN.md)

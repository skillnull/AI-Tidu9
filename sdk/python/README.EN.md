# AI-Tidu9 Python SDK

[Project](https://github.com/skillnull/AI-Tidu9/blob/main/docs/README.EN.md) · [Examples](https://github.com/skillnull/AI-Tidu9/blob/main/docs/EXAMPLES.EN.md) · [Capability ecosystem](https://github.com/skillnull/AI-Tidu9/blob/main/docs/ECOSYSTEM-SDK.EN.md) · [简体中文](./README.md)

The Python SDK is a lightweight client for the AI-Tidu9 capability ecosystem. Policy, permission, isolation, routing, and audit remain in the AI-Tidu9 runtime; the Python process only sends requests and receives structured results.

## 📦 Requirements and installation

- Python 3.10 or newer;
- A reachable AI-Tidu9 runtime;
- No third-party runtime dependency.

Install the development build from this repository:

```bash
python3 -m pip install ./sdk/python
```

The SDK shares synchronized version metadata with `@skillnull/tidu`. It is not another control plane and never accesses AI-Tidu9 SQLite or PostgreSQL directly.

## 🚀 Minimal runnable example

```python
from ai_tidu9 import TiduClient

client = TiduClient("http://127.0.0.1:9639")

providers = client.list_providers()
result = client.invoke_provider(
    "company.reviewer",
    "review",
    {"text": "Review this bounded change."},
    timeout_ms=10_000,
    maximum_output_bytes=64_000,
)

print(result.output)
print(result.usage)
print(result.evidence)
```

`list_providers()` returns metadata visible to the current identity. `invoke_provider()` still crosses platform permission, trust, and isolation checks; discovering a provider never grants invocation permission automatically.

## 🧭 API at a glance

| API | Purpose | Result |
| --- | --- | --- |
| `TiduClient(endpoint, api_key=None, timeout=30)` | Create a synchronous client | `TiduClient` |
| `list_providers()` | List visible providers | `list[dict]` |
| `invoke_provider(...)` | Invoke a capability inside AI-Tidu9 boundaries | `CapabilityInvocationResult` |

`CapabilityInvocationResult` exposes `output`, optional provider-reported `usage`, and non-sensitive string `evidence`. Invocation bounds include `tenant_id`, `timeout_ms`, and `maximum_output_bytes`.

## 🛡️ Error handling and security boundaries

Invalid arguments raise `ValueError`. Network failure, timeout, invalid JSON, and platform rejection raise `TiduError`. The caller decides whether to retry, degrade, or terminate; never assume a failed response means the operation did not execute.

- Use loopback for personal local mode. Remote and enterprise access requires HTTPS and identity controls.
- `api_key` is sent only as a Bearer Token. Never hard-code, log, or commit it.
- The SDK never reads Codex, Cursor, browser, or other host credentials.
- A timeout does not prove server-side cancellation. Never blindly retry non-idempotent operations.

Run the SDK tests:

```bash
python3 -m unittest discover -s sdk/python/tests
```

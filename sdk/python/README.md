# AI-Tidu9 Python SDK

中文：零运行时依赖的九门赛博提督能力提供者客户端。它通过平台 API 调用能力，不在 Python 进程内复制控制平面。

English: A zero-runtime-dependency client for the AI-Tidu9 capability-provider API. It calls the platform API instead of duplicating the control plane inside Python.

```python
from ai_tidu9 import TiduClient

client = TiduClient("http://127.0.0.1:3988", api_key="local-token")
result = client.invoke_provider("company.reviewer", "review", {"text": "..."})
```


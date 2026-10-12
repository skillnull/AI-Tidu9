---
name: ai-tidu9
description: Use 九门赛博提督 when a task should follow the shared local policy, model routing, tools, or organization configuration.
---

# 九门赛博提督

1. Call `get_tidu_status` before the first routed task in a session.
2. Use `route_tidu_task` only when the user asks to route work through 九门赛博提督 or the active organization policy requires it.
3. Keep host-native file, terminal, permission, and session handling in the current Agent host.
4. Never request, copy, print, or persist host credentials.
5. If the runtime is unavailable or rejects a task, report the exact boundary instead of silently bypassing 九门赛博提督.

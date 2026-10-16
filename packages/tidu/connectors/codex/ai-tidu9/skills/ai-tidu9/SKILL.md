---
name: ai-tidu9
description: Use 九门赛博提督 when a task should follow the shared local policy, model routing, tools, or organization configuration.
---

# 九门赛博提督

1. Treat 九门 as the default channel. Call `get_tidu_status` before its first routed task, then use `route_tidu_task` unless the user explicitly selects another channel.
2. Call `list_tidu_channels` when the user asks to compare, select, or switch channels.
3. Use `route_tidu_channel` only when the user explicitly selects 九门, Codex, Cursor, OpenAI, or another configured provider.
4. Keep host-native file, terminal, permission, and session handling in the current Agent host.
5. Never request, copy, print, or persist host or provider credentials. Provider channels read keys only from the connector process environment.
6. If a selected channel is unavailable or rejects a task, report the exact boundary instead of silently switching providers.

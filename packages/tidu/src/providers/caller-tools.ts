import { randomUUID } from "node:crypto";
import type { CodexCallerToolCall } from "../connectors/codex-app-server.js";
import { TiduError } from "../core/index.js";
import type { ProviderExecutionRequest } from "./index.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface CallerToolCatalog {
  /** Caller-authorized server-side search mode, independent of local command tools. */
  webSearchMode: "disabled" | "cached" | "live";
  /** Official dynamic-tool definitions exposed to delegated inference. */
  definitions: readonly Record<string, unknown>[];
  /** Converts a model request back to the caller's original function or custom tool. */
  outputItem: (call: CodexCallerToolCall) => Record<string, unknown>;
  /** Translates caller-owned history back to the isolated delegated tool names. */
  historyItems: (items: readonly Record<string, unknown>[]) => readonly Record<string, unknown>[];
}

export const createCallerToolCatalog = (
  request: ProviderExecutionRequest,
): CallerToolCatalog | undefined => {
  if (
    request.protocol !== "responses" ||
    !Array.isArray(request.body.tools) ||
    request.body.tools.length === 0 ||
    ["planning", "verification"].includes(request.routing?.role ?? "")
  )
    return undefined;
  if (
    request.body.tool_choice !== undefined &&
    request.body.tool_choice !== "auto" &&
    request.body.tool_choice !== "none"
  )
    throw new TiduError(
      "CONFIGURATION_INVALID",
      "Codex caller tool delegation supports only auto or none tool_choice.",
    );
  const tools = new Map<
    string,
    { type: "custom" | "function" | "tool_search"; name: string; namespace?: string }
  >();
  const definitions: Record<string, unknown>[] = [];
  const declaredNames = new Set<string>();
  const aliasesByName = new Map<string, string>();
  let webSearchMode: CallerToolCatalog["webSearchMode"] = "disabled";
  const register = (value: unknown, namespace?: string): Record<string, unknown> => {
    if (
      !isRecord(value) ||
      (value.type !== "tool_search" && typeof value.name !== "string") ||
      (value.type !== "function" && value.type !== "custom" && value.type !== "tool_search")
    ) {
      throw new TiduError(
        "CONFIGURATION_INVALID",
        "The Codex caller tool definition cannot be delegated safely.",
      );
    }
    const name = value.type === "tool_search" ? "tool_search" : (value.name as string);
    const key = JSON.stringify([namespace ?? null, name]);
    if (declaredNames.has(key))
      throw new TiduError("CONFIGURATION_INVALID", "Duplicate caller tool name.");
    declaredNames.add(key);
    const alias = `tidu_caller_tool_${tools.size}`;
    aliasesByName.set(key, alias);
    tools.set(alias, {
      type: value.type,
      name,
      ...(namespace === undefined ? {} : { namespace }),
    });
    return {
      type: "function",
      name: alias,
      description: `Caller tool ${namespace === undefined ? "" : `${namespace}.`}${name}: ${typeof value.description === "string" ? value.description : name}`,
      inputSchema:
        value.type === "custom"
          ? {
              type: "object",
              properties: {
                input: {
                  type: "string",
                  description: "Exact free-form tool input, without JSON encoding or code fences.",
                },
              },
              required: ["input"],
              additionalProperties: false,
            }
          : isRecord(value.parameters)
            ? value.parameters
            : { type: "object", properties: {} },
      ...(typeof value.defer_loading === "boolean" ? { deferLoading: value.defer_loading } : {}),
    };
  };
  if (request.body.tool_choice !== "none") {
    for (const tool of request.body.tools) {
      if (isRecord(tool) && (tool.type === "web_search" || tool.type === "web_search_preview")) {
        webSearchMode = tool.external_web_access === false ? "cached" : "live";
        continue;
      }
      if (
        isRecord(tool) &&
        tool.type === "namespace" &&
        typeof tool.name === "string" &&
        Array.isArray(tool.tools)
      ) {
        const namespace = tool.name;
        definitions.push(...tool.tools.map((nested) => register(nested, namespace)));
      } else definitions.push(register(tool));
    }
  }
  return {
    webSearchMode,
    definitions,
    historyItems: (items) => {
      const aliasesByCall = new Map<string, string>();
      return items.map((item) => {
        const type = item.type;
        if (
          type === "function_call" ||
          type === "custom_tool_call" ||
          type === "tool_search_call"
        ) {
          const name = type === "tool_search_call" ? "tool_search" : item.name;
          const alias = aliasesByName.get(JSON.stringify([item.namespace ?? null, name]));
          if (alias === undefined || typeof item.call_id !== "string") return item;
          aliasesByCall.set(item.call_id, alias);
          const { namespace: _namespace, input: _input, ...fields } = item;
          return {
            ...fields,
            type: "function_call",
            name: alias,
            arguments:
              type === "custom_tool_call"
                ? JSON.stringify({ input: item.input })
                : type === "tool_search_call"
                  ? JSON.stringify(item.arguments)
                  : item.arguments,
          };
        }
        if (
          type === "function_call_output" ||
          type === "custom_tool_call_output" ||
          type === "tool_search_output"
        ) {
          const { namespace: _namespace, ...fields } = item;
          const alias =
            typeof item.call_id === "string" ? aliasesByCall.get(item.call_id) : undefined;
          return {
            ...fields,
            type: "function_call_output",
            ...(alias === undefined ? {} : { name: alias }),
            output: type === "tool_search_output" ? JSON.stringify(item.tools ?? []) : item.output,
          };
        }
        return item;
      });
    },
    outputItem: (call) => {
      const tool = call.namespace === null ? tools.get(call.tool) : undefined;
      if (tool === undefined)
        throw new TiduError(
          "CONFIGURATION_INVALID",
          "Codex requested a tool that the caller did not declare.",
        );
      const item = {
        id: `fc_${randomUUID()}`,
        type: tool.type === "custom" ? "custom_tool_call" : "function_call",
        call_id: call.callId,
        name: tool.name,
        ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
      };
      if (tool.type === "tool_search")
        return {
          ...item,
          type: "tool_search_call",
          execution: "client",
          arguments: call.arguments,
        };
      if (tool.type === "custom") {
        if (!isRecord(call.arguments) || typeof call.arguments.input !== "string") {
          throw new TiduError(
            "CONFIGURATION_INVALID",
            "Codex returned invalid free-form caller tool input.",
          );
        }
        return { ...item, input: call.arguments.input };
      }
      return { ...item, arguments: JSON.stringify(call.arguments) };
    },
  };
};

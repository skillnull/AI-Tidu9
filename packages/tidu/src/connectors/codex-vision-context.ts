import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import type { CodexAppServerLaunch } from "../accounts/codex-host.js";
import type { CodexAgentOptions } from "./codex-app-server.js";

const run = promisify(execFile);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const visionSkillReferenceText = (role: unknown, text: string): string => {
  if (role !== "developer" && role !== "system") return text;
  const withoutCatalog = text.replace(/<skills_instructions>[\s\S]*?<\/skills_instructions>/gu, "");
  if (
    !withoutCatalog.startsWith("<permissions instructions>") ||
    !withoutCatalog.endsWith("</permissions instructions>")
  )
    return withoutCatalog;
  // A filesystem grant can mention folders with the same name as a plugin.
  // Keep actual manifest paths, skill references, and the surrounding policy.
  return withoutCatalog.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s<>"'`]+/gu, (path) =>
    /(?:^|[\\/])skills?(?:[\\/]|$)|SKILL\.md|\$|:/iu.test(path.replace(/^[A-Za-z]:/u, ""))
      ? path
      : "",
  );
};

const contextPrefix = (items: readonly unknown[], preview = false) => {
  let permission: { message: number; part: number; text: string } | undefined;
  for (const [index, item] of items.entries()) {
    if (
      preview &&
      isRecord(item) &&
      item.type === "additional_tools" &&
      item.role === "developer" &&
      Array.isArray(item.tools)
    )
      continue;
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) break;
    if (
      Object.keys(item).some(
        (key) =>
          !["role", "type", "content"].includes(key) &&
          !(
            key === "id" &&
            typeof item.id === "string" &&
            /^msg_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(item.id)
          ) &&
          !(preview && key === "internal_chat_message_metadata_passthrough"),
      )
    )
      break;
    if (item.role === "developer") {
      for (const [partIndex, part] of item.content.entries()) {
        if (
          !isRecord(part) ||
          part.type !== "input_text" ||
          typeof part.text !== "string" ||
          !part.text.startsWith("<permissions instructions>") ||
          !part.text.endsWith("</permissions instructions>")
        )
          continue;
        if (permission || Object.keys(part).length !== 2) return undefined;
        permission = { message: index, part: partIndex, text: part.text };
      }
      continue;
    }
    if (item.role !== "user" || !permission || item.content.length !== 2) break;
    const [agents, environment] = item.content;
    if (
      !isRecord(agents) ||
      !isRecord(environment) ||
      agents.type !== "input_text" ||
      environment.type !== "input_text" ||
      Object.keys(agents).length !== 2 ||
      Object.keys(environment).length !== 2 ||
      typeof agents.text !== "string" ||
      !agents.text.startsWith("# AGENTS.md instructions for ") ||
      typeof environment.text !== "string" ||
      !environment.text.startsWith("<environment_context>") ||
      !environment.text.endsWith("</environment_context>")
    )
      break;
    return { permission, user: index, userParts: item.content };
  }
  return undefined;
};

/** Compare model-visible content, excluding native message IDs and preview-only diagnostic metadata. */
export const foldVisionContext = (
  history: readonly Record<string, unknown>[],
  projection: readonly unknown[],
  taskText: string,
  candidate = contextPrefix(history),
): readonly Record<string, unknown>[] | undefined => {
  const native = contextPrefix(projection, true);
  if (
    !candidate ||
    !native ||
    native.permission.text !== candidate.permission.text ||
    !isDeepStrictEqual(native.userParts, candidate.userParts)
  )
    return undefined;
  const contextIds = [history[candidate.user]?.id, history[candidate.permission.message]?.id];
  if (
    contextIds.some((id) => typeof id === "string" && taskText.includes(id)) ||
    history.some((item) => item.type !== "message")
  )
    return undefined;
  return history.flatMap((item, index) => {
    if (index === candidate.user) return [];
    if (index !== candidate.permission.message) return [item];
    const content = (item.content as unknown[]).filter(
      (_, partIndex) => partIndex !== candidate.permission.part,
    );
    return content.length ? [{ ...item, content }] : [];
  });
};

/** Match the first native preamble only. Later revisions and reminders remain in their original order. */
export const verifiedVisionHistory = async (
  options: CodexAgentOptions,
  launch: CodexAppServerLaunch,
  thread: Record<string, unknown>,
  config: Record<string, unknown>,
  history: readonly Record<string, unknown>[],
  taskText: string,
  signal?: AbortSignal,
): Promise<readonly Record<string, unknown>[] | undefined> => {
  const candidate = contextPrefix(history);
  if (
    !candidate ||
    signal?.aborted ||
    options.transportFactory ||
    typeof thread.model !== "string" ||
    thread.modelProvider !== (options.modelProvider ?? "openai") ||
    thread.cwd !== options.workingDirectory ||
    thread.approvalPolicy !== "on-request" ||
    thread.activePermissionProfile !== null ||
    !isDeepStrictEqual(thread.sandbox, { type: "readOnly", networkAccess: false }) ||
    !isDeepStrictEqual(thread.runtimeWorkspaceRoots, [options.workingDirectory]) ||
    !Array.isArray(thread.instructionSources) ||
    thread.instructionSources.length === 0
  )
    return undefined;

  const contextConfig = {
    ...config,
    model: thread.model,
    approval_policy: "on-request",
    sandbox_mode: "read-only",
  };
  const overrides = Object.entries(contextConfig).flatMap(([key, value]) => [
    "-c",
    `${key}=${JSON.stringify(value)}`,
  ]);
  try {
    // The native diagnostic renders the host context alone. Never send the
    // caller's history, images, or task to the preview process.
    const pending = run(
      launch.command,
      [
        ...launch.arguments.slice(0, launch.arguments.indexOf("app-server")),
        ...overrides,
        "debug",
        "prompt-input",
      ],
      {
        cwd: options.workingDirectory,
        env: launch.environment,
        timeout: 10_000,
        maxBuffer: 2_097_152,
        signal,
      },
    );
    pending.child.stdin?.end();
    const { stdout } = await pending;
    const projection: unknown = JSON.parse(stdout);
    return Array.isArray(projection)
      ? foldVisionContext(history, projection, taskText, candidate)
      : undefined;
  } catch {
    return undefined;
  }
};

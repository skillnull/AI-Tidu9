import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { ModelProvider, ProviderExecutionRequest, ProviderExecutionResult } from "./index.js";

const executeFile = promisify(execFile);
const GIT_READ_TIMEOUT_MILLISECONDS = 10_000;
const GIT_WRITE_TIMEOUT_MILLISECONDS = 120_000;
const PROJECT_CHECK_TIMEOUT_MILLISECONDS = 30 * 60_000;
const GIT_OUTPUT_LIMIT = 16_000;
const COMMIT_ONLY_REQUESTS = new Set([
  "commit",
  "commit changes",
  "commit current changes",
  "commit the changes",
  "git commit",
  "提交",
  "提交代码",
  "提交当前代码",
  "提交当前修改",
  "提交当前更改",
  "提交修改",
  "提交更改",
]);
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "add",
  "am",
  "apply",
  "archive",
  "bisect",
  "blame",
  "branch",
  "checkout",
  "cherry",
  "cherry-pick",
  "clean",
  "commit",
  "describe",
  "diff",
  "fetch",
  "format-patch",
  "grep",
  "log",
  "merge",
  "merge-base",
  "mv",
  "pull",
  "push",
  "rebase",
  "reflog",
  "remote",
  "reset",
  "restore",
  "revert",
  "rev-list",
  "rev-parse",
  "rm",
  "shortlog",
  "show",
  "show-branch",
  "stash",
  "status",
  "submodule",
  "switch",
  "tag",
  "worktree",
]);
const GIT_ALIASES = new Map<string, readonly string[]>([
  ["git status", ["status", "--short", "--branch"]],
  ["git diff", ["diff"]],
  ["git log", ["log", "-10", "--oneline", "--decorate"]],
  ["git branch", ["branch", "--show-current"]],
  ["git fetch", ["fetch", "--prune"]],
  ["git pull", ["pull", "--ff-only"]],
  ["git push", ["push"]],
  ["查看git状态", ["status", "--short", "--branch"]],
  ["查看工作区状态", ["status", "--short", "--branch"]],
  ["查看git差异", ["diff"]],
  ["查看代码差异", ["diff"]],
  ["查看提交记录", ["log", "-10", "--oneline", "--decorate"]],
  ["查看git日志", ["log", "-10", "--oneline", "--decorate"]],
  ["当前分支", ["branch", "--show-current"]],
  ["获取远端更新", ["fetch", "--prune"]],
  ["拉取代码", ["pull", "--ff-only"]],
  ["推送代码", ["push"]],
]);

type GitLanguage = "en" | "zh";

interface LocalGitRequest {
  /** Git arguments passed directly to the executable without a shell. */
  argumentsList?: readonly string[];
  /** Optional commit header for the deterministic add-and-commit flow. */
  commitMessage?: string;
  /** Kind of local Git operation selected by the exact request. */
  kind: "command" | "commit" | "unsupported";
  /** Language used for the concise terminal result. */
  language: GitLanguage;
  /** Whether the repository quality script must pass before this Git command runs. */
  validateBeforeRun?: boolean;
}

interface GitCommandResult {
  /** Standard error emitted by Git and its hooks. */
  stderr: string;
  /** Standard output emitted by Git and its hooks. */
  stdout: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readTextContent = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      const text = readTextContent(item);
      if (text === undefined) return undefined;
      parts.push(text);
    }
    return parts.join("\n");
  }
  if (!isRecord(value)) return "";
  if (
    typeof value.type === "string" &&
    ["image", "image_url", "input_image", "localImage"].includes(value.type)
  ) {
    return undefined;
  }
  if (typeof value.text === "string") return value.text;
  return readTextContent(value.content);
};

const activeUserText = (request: ProviderExecutionRequest): string | undefined => {
  const conversation =
    request.protocol === "chat-completions" ? request.body.messages : request.body.input;
  if (typeof conversation === "string") return conversation.trim();
  if (!Array.isArray(conversation)) return undefined;
  const lastItem = conversation.at(-1);
  if (isRecord(lastItem) && typeof lastItem.role === "string") {
    return lastItem.role === "user" ? readTextContent(lastItem.content)?.trim() : undefined;
  }
  return readTextContent(conversation)?.trim();
};

const normalizedOperation = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[。！!？?，,；;：:]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

const splitCommandLine = (value: string): readonly string[] | undefined => {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (token !== "") tokens.push(token);
      token = "";
      continue;
    }
    token += character;
  }
  if (escaped || quote !== undefined) return undefined;
  if (token !== "") tokens.push(token);
  return tokens;
};

const hasUnsafeRepositoryOverride = (argumentsList: readonly string[]): boolean =>
  argumentsList.some(
    (argument, argumentIndex) =>
      argument === "-C" ||
      argument.startsWith("--git-dir") ||
      argument.startsWith("--work-tree") ||
      (argument === "-c" && argumentIndex < 2),
  );

const looksLikeGitOperation = (value: string): boolean =>
  /^(?:请)?(?:执行|运行|查看|检查|提交|暂存|推送|拉取|获取|切换|创建|删除|合并|变基|撤销|回退|恢复|清理)/iu.test(
    value,
  ) && /(?:git|代码|分支|工作区|推送|拉取|暂存|变基|合并)/iu.test(value);

const parseLocalGitRequest = (request: ProviderExecutionRequest): LocalGitRequest | undefined => {
  const text = activeUserText(request);
  if (text === undefined || text === "") return undefined;
  const [commandLine = "", ...messageLines] = text.split(/\r?\n/u);
  const normalizedCommand = normalizedOperation(commandLine).replace(/^请/u, "");
  if (COMMIT_ONLY_REQUESTS.has(normalizedCommand)) {
    const commitMessage = messageLines.join(" ").trim();
    return {
      kind: "commit",
      language: /^[a-z]/u.test(normalizedCommand) ? "en" : "zh",
      ...(commitMessage === "" ? {} : { commitMessage }),
    };
  }
  const aliasArguments = GIT_ALIASES.get(normalizedCommand);
  if (aliasArguments !== undefined) {
    return {
      kind: "command",
      language: /^[a-z]/u.test(normalizedCommand) ? "en" : "zh",
      argumentsList: aliasArguments,
    };
  }
  if (/^git(?:\s|$)/iu.test(commandLine.trim())) {
    const tokens = splitCommandLine(commandLine.trim());
    const argumentsList = tokens?.slice(1);
    const subcommand = argumentsList?.[0];
    if (
      argumentsList === undefined ||
      subcommand === undefined ||
      !ALLOWED_GIT_SUBCOMMANDS.has(subcommand) ||
      hasUnsafeRepositoryOverride(argumentsList)
    ) {
      return { kind: "unsupported", language: "en" };
    }
    return {
      kind: "command",
      language: "en",
      argumentsList,
      ...(subcommand === "commit" ? { validateBeforeRun: true } : {}),
    };
  }
  if (looksLikeGitOperation(text)) {
    return { kind: "unsupported", language: /[\u3400-\u9fff]/u.test(text) ? "zh" : "en" };
  }
  return undefined;
};

const runGit = async (
  argumentsList: readonly string[],
  workingDirectory: string,
  timeout = GIT_READ_TIMEOUT_MILLISECONDS,
): Promise<GitCommandResult> => {
  const { stdout, stderr } = await executeFile("git", argumentsList, {
    cwd: workingDirectory,
    encoding: "utf8",
    maxBuffer: 512 * 1_024,
    timeout,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
};

const runProjectCheck = async (workingDirectory: string): Promise<void> => {
  const repositoryRoot = (await runGit(["rev-parse", "--show-toplevel"], workingDirectory)).stdout;
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  } catch (error) {
    const errorCode = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
    if (errorCode === "ENOENT") return;
    throw error;
  }
  const scripts = isRecord(packageJson) && isRecord(packageJson.scripts) ? packageJson.scripts : {};
  if (typeof scripts.check !== "string" || scripts.check.trim() === "") return;
  await executeFile("npm", ["run", "check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 4 * 1_024 * 1_024,
    timeout: PROJECT_CHECK_TIMEOUT_MILLISECONDS,
  });
};

const sanitizeGitOutput = (value: string): string =>
  value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/giu, "$1***@").slice(0, GIT_OUTPUT_LIMIT);

const gitErrorOutput = (error: unknown): string => {
  if (!isRecord(error)) return error instanceof Error ? error.message : "Git command failed.";
  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  const message = error instanceof Error ? error.message : "Git command failed.";
  return sanitizeGitOutput(stderr || message);
};

const executeCommit = async (
  operation: LocalGitRequest,
  workingDirectory: string,
): Promise<string> => {
  const status = await runGit(
    ["status", "--porcelain=v1", "--untracked-files=normal"],
    workingDirectory,
  );
  if (status.stdout === "") {
    return operation.language === "en" ? "No changes to commit." : "没有更新要提交。";
  }
  await runProjectCheck(workingDirectory);
  await runGit(["add", "--all"], workingDirectory);
  const staged = await runGit(["diff", "--cached", "--name-only"], workingDirectory);
  if (staged.stdout === "") {
    return operation.language === "en" ? "No changes to commit." : "没有更新要提交。";
  }
  const commitMessage = operation.commitMessage ?? "chore: update";
  await runGit(["commit", "-m", commitMessage], workingDirectory, GIT_WRITE_TIMEOUT_MILLISECONDS);
  const commitId = await runGit(["rev-parse", "--short", "HEAD"], workingDirectory);
  return operation.language === "en"
    ? `Validation and hooks passed. Committed ${commitId.stdout} (${commitMessage}).`
    : `验证与脚本执行通过，已提交 ${commitId.stdout}（${commitMessage}）。`;
};

const executeLocalGitOperation = async (
  operation: LocalGitRequest,
  workingDirectory: string,
): Promise<string> => {
  if (operation.kind === "unsupported") {
    return operation.language === "en"
      ? "Unsupported Git operation. Provide a complete git command."
      : "未识别 Git 操作，请直接输入完整的 git 命令。";
  }
  try {
    if (operation.kind === "commit") return await executeCommit(operation, workingDirectory);
    const argumentsList = operation.argumentsList ?? [];
    if (operation.validateBeforeRun === true) await runProjectCheck(workingDirectory);
    const result = await runGit(argumentsList, workingDirectory, GIT_WRITE_TIMEOUT_MILLISECONDS);
    const output = sanitizeGitOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
    if (output !== "") return output;
    return operation.language === "en" ? "Git command completed." : "Git 命令执行完成。";
  } catch (error) {
    const failure = gitErrorOutput(error);
    return operation.language === "en"
      ? `Git command failed: ${failure}`
      : `Git 命令执行失败：${failure}`;
  }
};

const responseModel = (request: ProviderExecutionRequest): string =>
  typeof request.body.model === "string" ? request.body.model : request.virtualModelId;

const createLocalResponseBody = (request: ProviderExecutionRequest, text: string): unknown => {
  const responseId = `tidu_git_${randomUUID()}`;
  if (request.protocol === "chat-completions") {
    return {
      id: responseId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1_000),
      model: responseModel(request),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1_000),
    completed_at: Math.floor(Date.now() / 1_000),
    status: "completed",
    error: null,
    incomplete_details: null,
    model: responseModel(request),
    output: [
      {
        id: `${responseId}_message`,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 0,
    },
  };
};

const createLocalResponseStream = (
  request: ProviderExecutionRequest,
  text: string,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const responseId = `tidu_git_${randomUUID()}`;
  const body = createLocalResponseBody(request, text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (request.protocol === "chat-completions") {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1_000), model: responseModel(request), choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ id: responseId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1_000), model: responseModel(request), choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
          ),
        );
      } else {
        controller.enqueue(
          encoder.encode(
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", response_id: responseId, output_index: 0, content_index: 0, delta: text })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: body })}\n\n`,
          ),
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
};

const gitQueues = new Map<string, Promise<void>>();

export const executeLocalGitRequest = async (
  request: ProviderExecutionRequest,
  workingDirectory = process.cwd(),
): Promise<ProviderExecutionResult | undefined> => {
  const operation = parseLocalGitRequest(request);
  if (operation === undefined) return undefined;
  const previous = gitQueues.get(workingDirectory) ?? Promise.resolve();
  const execution = previous.then(() => executeLocalGitOperation(operation, workingDirectory));
  const next = execution.then(
    () => undefined,
    () => undefined,
  );
  gitQueues.set(workingDirectory, next);
  void next.finally(() => {
    if (gitQueues.get(workingDirectory) === next) gitQueues.delete(workingDirectory);
  });
  const text = await execution;
  if (request.body.stream === true) {
    return {
      kind: "stream",
      statusCode: 200,
      stream: createLocalResponseStream(request, text),
    };
  }
  return {
    kind: "json",
    statusCode: 200,
    body: createLocalResponseBody(request, text),
  };
};

export const createLocalGitProvider = (
  provider: ModelProvider,
  workingDirectory = process.cwd(),
): ModelProvider => ({
  ...provider,
  execute: async (request): Promise<ProviderExecutionResult> =>
    (await executeLocalGitRequest(request, workingDirectory)) ?? provider.execute(request),
});

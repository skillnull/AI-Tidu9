import { type AgentHostId, MODEL_ROUTING_CAPABILITIES } from "../config/index.js";
import type {
  ModelProvider,
  ProviderExecutionRequest,
  ProviderExecutionResult,
} from "../providers/index.js";
import {
  AgentExecutionError,
  type AgentModelPreferences,
  type AgentPlan,
  type AgentStepOutput,
  type AgentWorker,
  type TaskPlanner,
  type TaskUnderstanding,
  type TaskVerificationResult,
  type TaskVerifier,
} from "./index.js";

/*
 * Upstream diagnostics cross a public API boundary, so only explicit bounded
 * fields are retained. Full provider bodies are never included in an error.
 */
const PROVIDER_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/u;
const MAXIMUM_PROVIDER_ERROR_MESSAGE_CHARACTERS = 240;
const REDACTED_PROVIDER_VALUE = "[REDACTED]";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sanitizeProviderErrorMessage = (value: unknown, fallback: string): string => {
  if (typeof value !== "string") return fallback;
  const sanitized = Array.from(value, (character) => {
    const characterCode = character.charCodeAt(0);
    return characterCode <= 31 || characterCode === 127 ? " " : character;
  })
    .join("")
    .replace(/\bBearer\s+[^\s,;]+/giu, `Bearer ${REDACTED_PROVIDER_VALUE}`)
    .replace(
      /\b(api[_-]?key|authorization|token|secret|password)\s*[:=]\s*[^\s,;]+/giu,
      `$1=${REDACTED_PROVIDER_VALUE}`,
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, `$1${REDACTED_PROVIDER_VALUE}@`)
    .replace(/\s+/gu, " ")
    .trim();
  return (sanitized === "" ? fallback : sanitized).slice(
    0,
    MAXIMUM_PROVIDER_ERROR_MESSAGE_CHARACTERS,
  );
};

const createProviderExecutionError = (
  body: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): AgentExecutionError => {
  const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
  const code =
    typeof error?.code === "string" && PROVIDER_ERROR_CODE_PATTERN.test(error.code)
      ? error.code
      : fallbackCode;
  return new AgentExecutionError(
    code,
    sanitizeProviderErrorMessage(error?.message, fallbackMessage),
  );
};

const createProviderResultError = (
  result: ProviderExecutionResult,
  fallbackCode: string,
  fallbackMessage: string,
): AgentExecutionError =>
  createProviderExecutionError(
    result.kind === "json" ? result.body : undefined,
    fallbackCode,
    fallbackMessage,
  );

export interface ModelProviderAgentAdapters {
  /** Model-driven goal understanding, planning, and replanning. */
  planner: TaskPlanner;
  /** Model-driven execution for non-tool plan steps. */
  worker: AgentWorker;
  /** Independent model pass that evaluates explicit acceptance criteria. */
  verifier: TaskVerifier;
}

const MAXIMUM_MODEL_JSON_CHARACTERS = 64 * 1024;
const MAXIMUM_MODEL_STREAM_EVENT_BYTES = 4 * 1024 * 1024;
const modelRoutingCapabilities = new Set<string>(MODEL_ROUTING_CAPABILITIES);

const filterModelRoutingCapabilities = (capabilities: readonly string[]): readonly string[] =>
  capabilities.filter((capability) => modelRoutingCapabilities.has(capability));

const compactResponseOnlyPlan = (plan: AgentPlan): AgentPlan => {
  if (plan.steps.length <= 1 || plan.steps.some((step) => step.kind === "tool")) return plan;
  return {
    revision: plan.revision,
    steps: [
      {
        id: "deliver",
        title: "Deliver the requested outcome",
        kind: "reason",
      },
    ],
  };
};

const extractTextContent = (body: unknown): string => {
  if (!isRecord(body)) {
    throw new Error("Agent model returned an unsupported response envelope.");
  }
  if (Array.isArray(body.choices)) {
    const firstChoice = body.choices[0];
    if (isRecord(firstChoice) && isRecord(firstChoice.message)) {
      const content = firstChoice.message.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const choiceText = content
          .filter(
            (part): part is Record<string, unknown> & { text: string } =>
              isRecord(part) && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("");
        if (choiceText !== "") return choiceText;
      }
    }
  }
  if (typeof body.output_text === "string" && body.output_text !== "") return body.output_text;
  if (Array.isArray(body.output)) {
    const outputText = body.output
      .flatMap((item) => (isRecord(item) && Array.isArray(item.content) ? item.content : []))
      .flatMap((content) =>
        isRecord(content) && typeof content.text === "string" ? [content.text] : [],
      )
      .join("");
    if (outputText !== "") return outputText;
  }
  throw new Error("Agent model response does not contain text content.");
};

const extractStreamTextDelta = (body: unknown): string => {
  if (!isRecord(body)) return "";
  if (body.type === "response.output_text.delta" && typeof body.delta === "string") {
    return body.delta;
  }
  if (!Array.isArray(body.choices)) return "";
  const firstChoice = body.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.delta)) return "";
  return typeof firstChoice.delta.content === "string" ? firstChoice.delta.content : "";
};

const extractStreamProcessDelta = (body: unknown): string => {
  if (!isRecord(body) || typeof body.type !== "string" || typeof body.delta !== "string") {
    return "";
  }
  const eventSegments = body.type.toLowerCase().split(/[./_-]+/u);
  const isDelta = eventSegments.at(-1) === "delta";
  const isPublicProcess = ["reasoning", "summary", "thought"].some((segment) =>
    eventSegments.includes(segment),
  );
  return isDelta && isPublicProcess ? body.delta : "";
};

const extractCompletedStreamText = (body: unknown): string => {
  if (!isRecord(body) || body.type !== "response.completed" || !isRecord(body.response)) {
    return "";
  }
  try {
    return extractTextContent(body.response);
  } catch {
    return "";
  }
};

const consumeProviderTextStream = async (
  source: ReadableStream<Uint8Array>,
  protocol: ProviderExecutionRequest["protocol"],
  onOutputDelta: (delta: string) => void,
  onProcessDelta?: (delta: string) => void,
): Promise<string> => {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamedText = "";
  let completedText = "";
  let sawSuccessfulTerminal = false;

  const consumeEvent = (event: string): void => {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (data === "") return;
    if (data === "[DONE]") {
      if (protocol === "chat-completions") sawSuccessfulTerminal = true;
      return;
    }
    const body = JSON.parse(data) as unknown;
    if (isRecord(body) && isRecord(body.error)) {
      throw createProviderExecutionError(
        body,
        "agent_model_stream_failed",
        "Agent model stream failed.",
      );
    }
    if (isRecord(body) && body.type === "error") {
      throw createProviderExecutionError(
        {
          error: {
            code: body.code,
            message: body.message,
          },
        },
        "agent_model_stream_failed",
        "Agent model stream failed.",
      );
    }
    if (
      isRecord(body) &&
      (body.type === "response.failed" || body.type === "response.incomplete")
    ) {
      const response = isRecord(body.response) ? body.response : undefined;
      const responseError = isRecord(response?.error) ? response.error : undefined;
      const incompleteDetails = isRecord(response?.incomplete_details)
        ? response.incomplete_details
        : undefined;
      throw createProviderExecutionError(
        {
          error: {
            code: responseError?.code,
            message:
              responseError?.message ??
              incompleteDetails?.reason ??
              (body.type === "response.incomplete"
                ? "Agent model response was incomplete."
                : "Agent model stream failed."),
          },
        },
        body.type === "response.incomplete"
          ? "agent_model_stream_incomplete"
          : "agent_model_stream_failed",
        body.type === "response.incomplete"
          ? "Agent model response was incomplete."
          : "Agent model stream failed.",
      );
    }
    if (isRecord(body) && body.type === "response.completed" && isRecord(body.response)) {
      if (body.response.status === "failed" || body.response.status === "incomplete") {
        const responseError = isRecord(body.response.error) ? body.response.error : undefined;
        const incompleteDetails = isRecord(body.response.incomplete_details)
          ? body.response.incomplete_details
          : undefined;
        throw createProviderExecutionError(
          {
            error: {
              code: responseError?.code,
              message:
                responseError?.message ??
                incompleteDetails?.reason ??
                "Agent model response did not complete successfully.",
            },
          },
          body.response.status === "incomplete"
            ? "agent_model_stream_incomplete"
            : "agent_model_stream_failed",
          "Agent model response did not complete successfully.",
        );
      }
      if (body.response.status === "completed") sawSuccessfulTerminal = true;
    }
    if (isRecord(body) && Array.isArray(body.choices)) {
      const hasFinishReason = body.choices.some(
        (choice) =>
          isRecord(choice) &&
          typeof choice.finish_reason === "string" &&
          choice.finish_reason !== "",
      );
      if (protocol === "chat-completions" && hasFinishReason) sawSuccessfulTerminal = true;
    }
    const delta = extractStreamTextDelta(body);
    if (delta !== "") {
      streamedText += delta;
      onOutputDelta(delta);
    }
    const processDelta = extractStreamProcessDelta(body);
    if (processDelta !== "") onProcessDelta?.(processDelta);
    const terminalText = extractCompletedStreamText(body);
    if (terminalText !== "") completedText = terminalText;
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > MAXIMUM_MODEL_STREAM_EVENT_BYTES) {
        throw new Error("Agent model stream event exceeds the configured boundary.");
      }
      while (true) {
        const delimiter = /\r?\n\r?\n/u.exec(buffer);
        if (delimiter?.index === undefined) break;
        consumeEvent(buffer.slice(0, delimiter.index));
        buffer = buffer.slice(delimiter.index + delimiter[0].length);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") consumeEvent(buffer);
  } finally {
    reader.releaseLock();
  }

  if (!sawSuccessfulTerminal) {
    throw new AgentExecutionError(
      "agent_model_stream_incomplete",
      "Agent model stream ended without a successful terminal event.",
    );
  }
  if (streamedText !== "") return streamedText;
  if (completedText !== "") {
    onOutputDelta(completedText);
    return completedText;
  }
  throw new Error("Agent model stream did not contain assistant text.");
};

const parseJsonContent = <TValue>(content: string): TValue => {
  if (content.length > MAXIMUM_MODEL_JSON_CHARACTERS) {
    throw new Error("Agent model JSON response exceeds the configured boundary.");
  }
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/u, "")
    .replace(/\s*```$/u, "");
  return JSON.parse(normalized) as TValue;
};

export const createModelProviderAgentAdapters = (
  provider: ModelProvider,
  virtualModelId: string | (() => Promise<string> | string),
): ModelProviderAgentAdapters => {
  const executeJson = async <TValue>(
    role: string,
    payload: unknown,
    signal: AbortSignal,
    securityScopeId: string,
    routingRole: "planning" | "verification" | "worker",
    requiredCapabilities: readonly string[] = [],
    host?: AgentHostId,
    modelPreferences?: AgentModelPreferences,
  ): Promise<TValue> => {
    const resolvedVirtualModelId =
      typeof virtualModelId === "string" ? virtualModelId : await virtualModelId();
    const result = await provider.execute({
      protocol: "chat-completions",
      virtualModelId: resolvedVirtualModelId,
      signal,
      routing: {
        role: routingRole,
        securityScopeId,
        requiredCapabilities,
        host,
      },
      body: {
        model: resolvedVirtualModelId,
        stream: false,
        temperature: 0,
        ...(modelPreferences?.reasoningEffort === undefined
          ? {}
          : { reasoning_effort: modelPreferences.reasoningEffort }),
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are the ${role} inside AI-Tidu9. Return one JSON object only. Never include credentials, full conversations, or unbounded tool output.`,
          },
          { role: "user", content: JSON.stringify(payload) },
        ],
      },
    });
    if (result.kind !== "json" || result.statusCode < 200 || result.statusCode >= 300) {
      throw createProviderResultError(
        result,
        "agent_model_json_request_failed",
        "Agent model request did not return a successful JSON response.",
      );
    }
    return parseJsonContent<TValue>(extractTextContent(result.body));
  };

  const planner: TaskPlanner = {
    understand: async (task, signal) =>
      executeJson<TaskUnderstanding>(
        "goal-understanding adapter",
        {
          instruction:
            "Normalize the goal. Return objective, acceptanceCriteria, constraints, assumptions, and requiredCapabilities as string arrays where applicable.",
          goal: task.goal,
        },
        signal,
        task.taskId,
        "planning",
        [],
        task.originHost,
      ),
    plan: async (input, signal) =>
      compactResponseOnlyPlan(
        await executeJson<AgentPlan>(
          "planning adapter",
          {
            instruction:
              "Return revision 1 and dependency-ordered steps. Each step needs id, title, and kind reason, tool, or verify. Use a tool only when its exact name is available. For a response-only goal with no usable tool, return exactly one reason step; independent verification runs separately.",
            goal: input.task.goal,
            understanding: input.understanding,
            tools: input.tools,
            assets: input.assets,
          },
          signal,
          input.task.taskId,
          "planning",
          filterModelRoutingCapabilities(input.understanding.requiredCapabilities),
          input.task.originHost,
        ),
      ),
    replan: async (input, signal) =>
      compactResponseOnlyPlan(
        await executeJson<AgentPlan>(
          "replanning adapter",
          {
            instruction:
              "Return a higher revision plan that preserves completed work and avoids repeating the failed approach. For a response-only goal with no usable tool, return exactly one reason step.",
            goal: input.task.goal,
            understanding: input.understanding,
            tools: input.tools,
            assets: input.assets,
            previousPlan: input.previousPlan,
            failedStep: input.failedStep,
            failure: input.failure,
            completedStepIds: input.completedStepIds,
          },
          signal,
          input.task.taskId,
          "planning",
          filterModelRoutingCapabilities(input.understanding.requiredCapabilities),
          input.task.originHost,
        ),
      ),
  };

  const worker: AgentWorker = {
    execute: async (input) => {
      if (input.modelRequest !== undefined) {
        const shouldStream = input.modelRequest.onOutputDelta !== undefined;
        let providerProcessStarted = false;
        const forwardProcessDelta =
          input.modelRequest.onProcessDelta === undefined
            ? undefined
            : (delta: string): void => {
                if (!providerProcessStarted) {
                  input.modelRequest?.onProcessDelta?.("\n\n");
                  providerProcessStarted = true;
                }
                input.modelRequest?.onProcessDelta?.(delta);
              };
        const directResult = await provider.execute({
          protocol: input.modelRequest.protocol,
          virtualModelId: input.modelRequest.virtualModelId,
          signal: input.signal,
          onProcessDelta: forwardProcessDelta,
          onExecutionReceipt: input.modelRequest.onExecutionReceipt,
          routing: {
            role: "worker",
            securityScopeId: input.task.taskId,
            requiredCapabilities: filterModelRoutingCapabilities(
              input.understanding.requiredCapabilities,
            ),
            host: input.task.originHost,
          },
          body: {
            ...input.modelRequest.body,
            stream: shouldStream,
            ...(input.modelPreferences?.reasoningEffort === undefined
              ? {}
              : input.modelRequest.protocol === "responses"
                ? {
                    reasoning: {
                      ...(isRecord(input.modelRequest.body.reasoning)
                        ? input.modelRequest.body.reasoning
                        : {}),
                      effort: input.modelPreferences.reasoningEffort,
                    },
                  }
                : { reasoning_effort: input.modelPreferences.reasoningEffort }),
          },
        });
        if (directResult.statusCode < 200 || directResult.statusCode >= 300) {
          throw createProviderResultError(
            directResult,
            "agent_model_request_failed",
            "Agent execution model did not return a successful response.",
          );
        }
        if (directResult.kind === "stream") {
          if (input.modelRequest.onOutputDelta === undefined) {
            throw new Error("Agent execution model unexpectedly returned a stream.");
          }
          return {
            summary: await consumeProviderTextStream(
              directResult.stream,
              input.modelRequest.protocol,
              input.modelRequest.onOutputDelta,
              forwardProcessDelta,
            ),
          };
        }
        if (directResult.kind !== "json") {
          throw createProviderResultError(
            directResult,
            "agent_model_request_failed",
            "Agent execution model did not return a successful JSON response.",
          );
        }
        const summary = extractTextContent(directResult.body);
        input.modelRequest.onOutputDelta?.(summary);
        return { summary };
      }
      return executeJson<AgentStepOutput>(
        "bounded execution adapter",
        {
          instruction:
            "Execute only this non-tool step. Return a substantive result in summary, not a progress label. Include optional minimal evidence records with kind, integrity, summary, and supportsCriteria.",
          goal: input.task.goal,
          understanding: input.understanding,
          step: input.step,
          previousResults: input.previousResults,
        },
        input.signal,
        input.task.taskId,
        "worker",
        filterModelRoutingCapabilities(input.understanding.requiredCapabilities),
        input.task.originHost,
        input.modelPreferences,
      );
    },
  };

  const verifier: TaskVerifier = {
    verify: async (input, signal) =>
      executeJson<TaskVerificationResult>(
        "independent acceptance verifier",
        {
          instruction:
            "Return a self-contained final answer in summary by synthesizing the completed step results. Also return exactly one criteria item for every acceptance criterion. Each item needs criterionIndex, accepted, reason, and evidenceIds chosen only from supplied evidence. Do not accept unsupported claims.",
          goal: input.task.goal,
          stepResults: input.stepResults,
          evidence: input.evidence,
        },
        signal,
        input.task.taskId,
        "verification",
        [],
        input.task.originHost,
      ),
  };

  return { planner, verifier, worker };
};

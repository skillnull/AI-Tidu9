import type { AgentHostId } from "../config/index.js";
import type { ModelProvider } from "../providers/index.js";
import type {
  AgentPlan,
  AgentStepOutput,
  AgentWorker,
  TaskPlanner,
  TaskUnderstanding,
  TaskVerificationResult,
  TaskVerifier,
} from "./index.js";

export interface ModelProviderAgentAdapters {
  /** Model-driven goal understanding, planning, and replanning. */
  planner: TaskPlanner;
  /** Model-driven execution for non-tool plan steps. */
  worker: AgentWorker;
  /** Independent model pass that evaluates explicit acceptance criteria. */
  verifier: TaskVerifier;
}

const MAXIMUM_MODEL_JSON_CHARACTERS = 64 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const extractTextContent = (body: unknown): string => {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    throw new Error("Agent model returned an unsupported response envelope.");
  }
  const firstChoice = body.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error("Agent model response does not contain a message.");
  }
  const content = firstChoice.message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is Record<string, unknown> & { text: string } =>
          isRecord(part) && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("");
  }
  throw new Error("Agent model response does not contain text content.");
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
  ): Promise<TValue> => {
    const resolvedVirtualModelId =
      typeof virtualModelId === "string" ? virtualModelId : await virtualModelId();
    const result = await provider.execute({
      protocol: "chat-completions",
      virtualModelId: resolvedVirtualModelId,
      signal,
      routing: { role: routingRole, securityScopeId, requiredCapabilities, host },
      body: {
        model: resolvedVirtualModelId,
        stream: false,
        temperature: 0,
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
      throw new Error("Agent model request did not return a successful JSON response.");
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
      executeJson<AgentPlan>(
        "planning adapter",
        {
          instruction:
            "Return revision 1 and dependency-ordered steps. Each step needs id, title, and kind reason, tool, or verify. Use a tool only when its exact name is available.",
          goal: input.task.goal,
          understanding: input.understanding,
          tools: input.tools,
          assets: input.assets,
        },
        signal,
        input.task.taskId,
        "planning",
        input.understanding.requiredCapabilities,
        input.task.originHost,
      ),
    replan: async (input, signal) =>
      executeJson<AgentPlan>(
        "replanning adapter",
        {
          instruction:
            "Return a higher revision plan that preserves completed work and avoids repeating the failed approach.",
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
        input.understanding.requiredCapabilities,
        input.task.originHost,
      ),
  };

  const worker: AgentWorker = {
    execute: async (input) =>
      executeJson<AgentStepOutput>(
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
        input.understanding.requiredCapabilities,
        input.task.originHost,
      ),
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

import type { TiduConfiguration } from "../config/index.js";

export interface OpenAiModel {
  /** Stable model identifier selected by compatible clients. */
  id: string;
  /** Unix timestamp for the active virtual-model snapshot. */
  created: number;
  /** OpenAI-compatible object discriminator. */
  object: "model";
  /** Required AI-Tidu9 attribution retained under custom display names. */
  owned_by: "AI-Tidu9";
  /** Human-readable virtual-model name shown by compatible client catalogs. */
  display_name: string;
}

export interface OpenAiModelList {
  /** Currently available virtual models. */
  data: readonly OpenAiModel[];
  /** OpenAI-compatible list discriminator. */
  object: "list";
}

export interface OpenAiErrorBody {
  /** OpenAI-compatible error details. */
  error: {
    /** Stable machine-readable error code. */
    code: string;
    /** Human-readable error without request content or secrets. */
    message: string;
    /** Request field responsible for the failure when applicable. */
    param: string | null;
    /** Broad OpenAI-compatible error category. */
    type: "invalid_request_error" | "server_error";
  };
}

export interface OpenAiRequestValidation {
  /** Whether the request can proceed to provider routing. */
  valid: boolean;
  /** Error returned when valid is false. */
  error?: OpenAiErrorBody;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const createOpenAiError = (
  code: string,
  message: string,
  type: OpenAiErrorBody["error"]["type"],
  param: string | null = null,
): OpenAiErrorBody => ({ error: { code, message, param, type } });

export const createOpenAiModel = (
  configuration: TiduConfiguration,
  activatedAt: string,
): OpenAiModel => ({
  id: configuration.activeProfileId,
  created: Math.floor(Date.parse(activatedAt) / 1_000),
  object: "model",
  owned_by: "AI-Tidu9",
  display_name: configuration.virtualModelName,
});

const validateModel = (
  body: Record<string, unknown>,
  activeModelId: string,
): OpenAiRequestValidation => {
  if (typeof body.model !== "string" || body.model.trim() === "") {
    return {
      valid: false,
      error: createOpenAiError(
        "invalid_model",
        "model must be a non-empty string.",
        "invalid_request_error",
        "model",
      ),
    };
  }
  if (body.model !== activeModelId) {
    return {
      valid: false,
      error: createOpenAiError(
        "model_not_found",
        `The model '${body.model}' is not available.`,
        "invalid_request_error",
        "model",
      ),
    };
  }
  return { valid: true };
};

const isFunctionName = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/u.test(value);

const isChatFunctionTool = (value: unknown): boolean =>
  isRecord(value) &&
  value.type === "function" &&
  isRecord(value.function) &&
  isFunctionName(value.function.name) &&
  (value.function.parameters === undefined || isRecord(value.function.parameters));

const isResponsesTool = (value: unknown, depth = 0): boolean => {
  if (!isRecord(value) || depth > 4) {
    return false;
  }
  if (value.type === "web_search" || value.type === "web_search_preview") {
    return (
      (value.search_context_size === undefined ||
        value.search_context_size === "low" ||
        value.search_context_size === "medium" ||
        value.search_context_size === "high") &&
      (value.user_location === undefined || isRecord(value.user_location))
    );
  }
  if (!isFunctionName(value.name)) {
    return false;
  }
  if (value.type === "function") {
    return value.parameters === undefined || isRecord(value.parameters);
  }
  if (value.type === "custom") {
    return (
      (value.description === undefined || typeof value.description === "string") &&
      (value.format === undefined || isRecord(value.format))
    );
  }
  if (value.type === "namespace") {
    return (
      (value.description === undefined || typeof value.description === "string") &&
      Array.isArray(value.tools) &&
      value.tools.length > 0 &&
      value.tools.every((tool) => isResponsesTool(tool, depth + 1))
    );
  }
  return false;
};

const validateTools = (
  body: Record<string, unknown>,
  protocol: "chat-completions" | "responses",
): OpenAiRequestValidation => {
  if (body.tools !== undefined) {
    const toolIsValid = protocol === "chat-completions" ? isChatFunctionTool : isResponsesTool;
    if (
      !Array.isArray(body.tools) ||
      body.tools.length === 0 ||
      !body.tools.every((tool) => toolIsValid(tool))
    ) {
      const unsupportedTypes = Array.isArray(body.tools)
        ? [
            ...new Set(
              body.tools
                .filter((tool) => !toolIsValid(tool))
                .map((tool) => {
                  if (!isRecord(tool)) {
                    return "invalid";
                  }
                  if (typeof tool.type === "string" && tool.type !== "") {
                    return tool.type;
                  }
                  return `missing-type(${Object.keys(tool).sort().join("|")})`;
                }),
            ),
          ].join(", ")
        : "invalid";
      return {
        valid: false,
        error: createOpenAiError(
          "invalid_tools",
          `tools contains unsupported definitions: ${unsupportedTypes}.`,
          "invalid_request_error",
          "tools",
        ),
      };
    }
  }
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    const validStringChoice = choice === "auto" || choice === "none" || choice === "required";
    const validObjectChoice =
      isRecord(choice) &&
      choice.type === "function" &&
      (protocol === "chat-completions"
        ? isRecord(choice.function) && isFunctionName(choice.function.name)
        : isFunctionName(choice.name));
    if (!validStringChoice && !validObjectChoice) {
      return {
        valid: false,
        error: createOpenAiError(
          "invalid_tool_choice",
          "tool_choice must select a valid function behavior.",
          "invalid_request_error",
          "tool_choice",
        ),
      };
    }
    const selectedName =
      validObjectChoice && isRecord(choice)
        ? protocol === "chat-completions" && isRecord(choice.function)
          ? choice.function.name
          : choice.name
        : undefined;
    const configuredNames = Array.isArray(body.tools)
      ? body.tools.flatMap((tool) => {
          if (!isRecord(tool)) {
            return [];
          }
          const name =
            protocol === "chat-completions" && isRecord(tool.function)
              ? tool.function.name
              : tool.name;
          return typeof name === "string" ? [name] : [];
        })
      : [];
    if (
      (choice !== "none" && configuredNames.length === 0) ||
      (typeof selectedName === "string" && !configuredNames.includes(selectedName))
    ) {
      return {
        valid: false,
        error: createOpenAiError(
          "invalid_tool_choice",
          "tool_choice must reference a configured function.",
          "invalid_request_error",
          "tool_choice",
        ),
      };
    }
  }
  return { valid: true };
};

const isChatToolCall = (value: unknown): boolean =>
  isRecord(value) &&
  value.type === "function" &&
  typeof value.id === "string" &&
  isRecord(value.function) &&
  isFunctionName(value.function.name) &&
  typeof value.function.arguments === "string";

export const validateChatCompletionRequest = (
  body: unknown,
  activeModelId: string,
): OpenAiRequestValidation => {
  if (!isRecord(body)) {
    return {
      valid: false,
      error: createOpenAiError(
        "invalid_request_body",
        "Request body must be a JSON object.",
        "invalid_request_error",
      ),
    };
  }
  const modelValidation = validateModel(body, activeModelId);
  if (!modelValidation.valid) {
    return modelValidation;
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return {
      valid: false,
      error: createOpenAiError(
        "invalid_messages",
        "messages must be a non-empty array.",
        "invalid_request_error",
        "messages",
      ),
    };
  }
  const messagesAreValid = body.messages.every((message) => {
    if (!isRecord(message) || typeof message.role !== "string") {
      return false;
    }
    const validContent =
      typeof message.content === "string" ||
      Array.isArray(message.content) ||
      ((message.content === null || message.content === undefined) &&
        message.role === "assistant" &&
        Array.isArray(message.tool_calls));
    const validToolCalls =
      message.tool_calls === undefined ||
      (Array.isArray(message.tool_calls) && message.tool_calls.every(isChatToolCall));
    const validToolResult = message.role !== "tool" || typeof message.tool_call_id === "string";
    return validContent && validToolCalls && validToolResult;
  });
  if (!messagesAreValid) {
    return {
      valid: false,
      error: createOpenAiError(
        "invalid_messages",
        "Each message must contain a role and string or array content.",
        "invalid_request_error",
        "messages",
      ),
    };
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return {
      valid: false,
      error: createOpenAiError(
        "invalid_stream",
        "stream must be a boolean when provided.",
        "invalid_request_error",
        "stream",
      ),
    };
  }
  return validateTools(body, "chat-completions");
};

export const validateResponsesRequest = (
  body: unknown,
  activeModelId: string,
): OpenAiRequestValidation => {
  if (!isRecord(body)) {
    return {
      valid: false,
      error: createOpenAiError(
        "invalid_request_body",
        "Request body must be a JSON object.",
        "invalid_request_error",
      ),
    };
  }
  const modelValidation = validateModel(body, activeModelId);
  if (!modelValidation.valid) {
    return modelValidation;
  }
  if (
    !(
      (typeof body.input === "string" && body.input.trim() !== "") ||
      (Array.isArray(body.input) && body.input.length > 0)
    )
  ) {
    return {
      valid: false,
      error: createOpenAiError(
        "invalid_input",
        "input must be a non-empty string or array.",
        "invalid_request_error",
        "input",
      ),
    };
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return {
      valid: false,
      error: createOpenAiError(
        "invalid_stream",
        "stream must be a boolean when provided.",
        "invalid_request_error",
        "stream",
      ),
    };
  }
  return validateTools(body, "responses");
};

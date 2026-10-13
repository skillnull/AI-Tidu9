import { randomUUID } from "node:crypto";

import { TiduError } from "../core/index.js";
import type { ModelProvider, ProviderExecutionRequest } from "../providers/index.js";

export type SecretGateAction = "block" | "redact";
export type SecretGateDestination = "model" | "tool";

export interface SecretGateRule {
  /** Stable identifier included in non-sensitive findings. */
  id: string;
  /** Regular-expression source evaluated against string values. */
  pattern: string;
  /** Whether matching egress is rejected or replaced locally. */
  action: SecretGateAction;
  /** Optional regular-expression flags; global matching is added automatically. */
  flags?: string;
}

export interface SecretGateOptions {
  /** Enables automatic and explicit rules. */
  enabled?: boolean;
  /** Additional organization or user-defined rules. */
  rules?: readonly SecretGateRule[];
  /** Maximum secrets retained in one isolated runtime scope. */
  maximumSecretsPerScope?: number;
  /** Maximum lifetime of an isolated placeholder vault. */
  scopeTtlMilliseconds?: number;
}

export interface SecretGateContext {
  /** Isolated request or task identifier. */
  scopeId: string;
  /** Egress boundary being protected. */
  destination: SecretGateDestination;
}

export interface SecretGateFinding {
  /** Rule that produced the finding. */
  ruleId: string;
  /** Enforcement action applied to the matching value. */
  action: SecretGateAction;
  /** JSON path containing the match; never includes the secret value. */
  path: string;
}

export interface SecretGateResult<TValue> {
  /** Sanitized value safe for the requested egress boundary. */
  value: TValue;
  /** Non-sensitive enforcement findings. */
  findings: readonly SecretGateFinding[];
}

export interface SecretGate {
  /** Detects and protects secrets before model or tool egress. */
  protect: <TValue>(value: TValue, context: SecretGateContext) => SecretGateResult<TValue>;
  /** Restores placeholders only inside the matching local execution scope. */
  recover: <TValue>(value: TValue, scopeId: string) => TValue;
  /** Removes all recoverable values for one completed or cancelled scope. */
  closeScope: (scopeId: string) => void;
  /** Returns non-sensitive scope counts for diagnostics. */
  inspect: () => { activeScopes: number; retainedSecrets: number };
}

interface CompiledRule {
  id: string;
  action: SecretGateAction;
  pattern: RegExp;
}

interface SecretScope {
  expiresAt: number;
  secrets: Map<string, string>;
}

const SECRET_KEY_PATTERN =
  /(?:api[-_]?key|authorization|credential|password|private[-_]?key|secret|token)/iu;
const PLACEHOLDER_PATTERN = /\{\{TIDU_SECRET:([a-zA-Z0-9-]+):([a-zA-Z0-9-]+)\}\}/gu;
const MAXIMUM_SCOPES = 10_000;
const MAXIMUM_STRING_LENGTH = 1024 * 1024;
const DEFAULT_SCOPE_TTL_MILLISECONDS = 30 * 60 * 1000;
const DEFAULT_MAXIMUM_SECRETS = 256;
const AUTOMATIC_RULES: readonly SecretGateRule[] = Object.freeze([
  {
    id: "private-key",
    pattern:
      "-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\\s\\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----",
    action: "block",
    flags: "u",
  },
  {
    id: "bearer-token",
    pattern: "Bearer\\s+[A-Za-z0-9._~+/-]{12,}={0,2}",
    action: "redact",
    flags: "iu",
  },
  {
    id: "jwt",
    pattern: "eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}",
    action: "redact",
    flags: "u",
  },
  {
    id: "provider-key",
    pattern: "(?:sk|key|token)[-_][A-Za-z0-9_-]{16,}",
    action: "redact",
    flags: "iu",
  },
  {
    id: "aws-access-key",
    pattern: "(?:AKIA|ASIA)[A-Z0-9]{16}",
    action: "redact",
    flags: "u",
  },
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const compileRule = (rule: SecretGateRule): CompiledRule => {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(rule.id)) {
    throw new Error("Secret Gate rule identifiers must use lowercase safe names.");
  }
  if (!rule.pattern || rule.pattern.length > 1024) {
    throw new Error("Secret Gate rule patterns must contain 1-1024 characters.");
  }
  const suppliedFlags = rule.flags ?? "u";
  if (!/^[imsu]*$/u.test(suppliedFlags)) {
    throw new Error("Secret Gate rules support only i, m, s, and u flags.");
  }
  return {
    id: rule.id,
    action: rule.action,
    pattern: new RegExp(rule.pattern, `${suppliedFlags}g`),
  };
};

export const createSecretGate = (options: SecretGateOptions = {}): SecretGate => {
  const enabled = options.enabled ?? true;
  const maximumSecretsPerScope = options.maximumSecretsPerScope ?? DEFAULT_MAXIMUM_SECRETS;
  const scopeTtlMilliseconds = options.scopeTtlMilliseconds ?? DEFAULT_SCOPE_TTL_MILLISECONDS;
  if (
    !Number.isSafeInteger(maximumSecretsPerScope) ||
    maximumSecretsPerScope < 1 ||
    maximumSecretsPerScope > 4096
  ) {
    throw new Error("maximumSecretsPerScope must be an integer from 1 to 4096.");
  }
  if (
    !Number.isSafeInteger(scopeTtlMilliseconds) ||
    scopeTtlMilliseconds < 1000 ||
    scopeTtlMilliseconds > 24 * 60 * 60 * 1000
  ) {
    throw new Error("scopeTtlMilliseconds must be between one second and one day.");
  }
  const rules = [...AUTOMATIC_RULES, ...(options.rules ?? [])].map(compileRule);
  const scopes = new Map<string, SecretScope>();

  const pruneScopes = (): void => {
    const currentTime = Date.now();
    for (const [scopeId, scope] of scopes) {
      if (scope.expiresAt <= currentTime) {
        scopes.delete(scopeId);
      }
    }
    if (scopes.size > MAXIMUM_SCOPES) {
      const overflow = scopes.size - MAXIMUM_SCOPES;
      for (const scopeId of [...scopes.keys()].slice(0, overflow)) {
        scopes.delete(scopeId);
      }
    }
  };

  const requireScope = (scopeId: string): SecretScope => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(scopeId)) {
      throw new Error("Secret Gate scopes require a safe stable identifier.");
    }
    pruneScopes();
    const existing = scopes.get(scopeId);
    if (existing !== undefined) {
      existing.expiresAt = Date.now() + scopeTtlMilliseconds;
      return existing;
    }
    const created = {
      expiresAt: Date.now() + scopeTtlMilliseconds,
      secrets: new Map<string, string>(),
    };
    scopes.set(scopeId, created);
    return created;
  };

  const retainSecret = (scopeId: string, secret: string): string => {
    const scope = requireScope(scopeId);
    for (const [secretId, retainedSecret] of scope.secrets) {
      if (retainedSecret === secret) {
        return `{{TIDU_SECRET:${scopeId}:${secretId}}}`;
      }
    }
    if (scope.secrets.size >= maximumSecretsPerScope) {
      throw new TiduError("CONFIGURATION_INVALID", "Secret Gate scope capacity is exhausted.");
    }
    const secretId = randomUUID();
    scope.secrets.set(secretId, secret);
    return `{{TIDU_SECRET:${scopeId}:${secretId}}}`;
  };

  const protectString = (
    input: string,
    path: string,
    context: SecretGateContext,
    findings: SecretGateFinding[],
    forceSensitive: boolean,
  ): string => {
    if (input.length > MAXIMUM_STRING_LENGTH) {
      throw new TiduError("CONFIGURATION_INVALID", "Secret Gate input exceeds the size boundary.");
    }
    if (input.includes(`{{TIDU_SECRET:${context.scopeId}:`)) {
      return input;
    }
    if (forceSensitive && input.trim() !== "") {
      findings.push({ ruleId: "sensitive-field", action: "redact", path });
      return retainSecret(context.scopeId, input);
    }
    let output = input;
    const retainedPlaceholders: string[] = [];
    for (const rule of rules) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(output)) {
        continue;
      }
      findings.push({ ruleId: rule.id, action: rule.action, path });
      if (rule.action === "block") {
        throw new TiduError(
          "CONFIGURATION_INVALID",
          `Secret Gate blocked ${context.destination} egress by rule ${rule.id}.`,
          { details: { path, ruleId: rule.id } },
        );
      }
      rule.pattern.lastIndex = 0;
      output = output.replace(rule.pattern, (secret) => {
        const marker = `\uE000${retainedPlaceholders.length}\uE001`;
        retainedPlaceholders.push(retainSecret(context.scopeId, secret));
        return marker;
      });
    }
    return output.replace(/\uE000([0-9]+)\uE001/gu, (_, placeholderIndex: string) => {
      const placeholder = retainedPlaceholders[Number(placeholderIndex)];
      if (placeholder === undefined) {
        throw new Error("Secret Gate generated an invalid local placeholder marker.");
      }
      return placeholder;
    });
  };

  const protectValue = (
    input: unknown,
    path: string,
    context: SecretGateContext,
    findings: SecretGateFinding[],
    sensitiveField = false,
  ): unknown => {
    if (typeof input === "string") {
      return protectString(input, path, context, findings, sensitiveField);
    }
    if (Array.isArray(input)) {
      return input.map((item, itemIndex) =>
        protectValue(item, `${path}[${itemIndex}]`, context, findings),
      );
    }
    if (isRecord(input)) {
      return Object.fromEntries(
        Object.entries(input).map(([key, value]) => [
          key,
          protectValue(value, `${path}.${key}`, context, findings, SECRET_KEY_PATTERN.test(key)),
        ]),
      );
    }
    return input;
  };

  const recoverValue = (input: unknown, scopeId: string): unknown => {
    if (typeof input === "string") {
      const scope = scopes.get(scopeId);
      if (scope === undefined) {
        return input;
      }
      PLACEHOLDER_PATTERN.lastIndex = 0;
      return input.replace(
        PLACEHOLDER_PATTERN,
        (placeholder, placeholderScopeId: string, secretId: string) =>
          placeholderScopeId === scopeId
            ? (scope.secrets.get(secretId) ?? placeholder)
            : placeholder,
      );
    }
    if (Array.isArray(input)) {
      return input.map((item) => recoverValue(item, scopeId));
    }
    if (isRecord(input)) {
      return Object.fromEntries(
        Object.entries(input).map(([key, value]) => [key, recoverValue(value, scopeId)]),
      );
    }
    return input;
  };

  return {
    protect: <TValue>(value: TValue, context: SecretGateContext): SecretGateResult<TValue> => {
      if (!enabled) {
        return { value, findings: [] };
      }
      const findings: SecretGateFinding[] = [];
      const protectedValue = protectValue(value, "$", context, findings) as TValue;
      return { value: protectedValue, findings };
    },
    recover: <TValue>(value: TValue, scopeId: string): TValue =>
      recoverValue(value, scopeId) as TValue,
    closeScope: (scopeId) => {
      scopes.delete(scopeId);
    },
    inspect: () => {
      pruneScopes();
      return {
        activeScopes: scopes.size,
        retainedSecrets: [...scopes.values()].reduce(
          (totalSecrets, scope) => totalSecrets + scope.secrets.size,
          0,
        ),
      };
    },
  };
};

export const guardModelProvider = (
  provider: ModelProvider,
  secretGate: SecretGate,
): ModelProvider => ({
  descriptor: provider.descriptor,
  execute: async (request: ProviderExecutionRequest) => {
    const persistentScopeId = request.routing?.securityScopeId;
    const scopeId = persistentScopeId ?? `request-${randomUUID()}`;
    const protectedRequest = secretGate.protect(request.body, {
      scopeId,
      destination: "model",
    });
    try {
      return await provider.execute({
        ...request,
        body: protectedRequest.value,
        routing: { ...request.routing, securityScopeId: scopeId },
      });
    } finally {
      if (persistentScopeId === undefined) {
        secretGate.closeScope(scopeId);
      }
    }
  },
});

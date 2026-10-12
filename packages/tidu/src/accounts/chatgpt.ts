import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

export const CHATGPT_AUTHORIZE_ENDPOINT = "https://auth.openai.com/api/accounts/authorize";
export const CHATGPT_TOKEN_ENDPOINT = "https://auth.openai.com/api/accounts/oauth/token";
export const CHATGPT_OPENID_CONFIGURATION =
  "https://auth.openai.com/.well-known/openid-configuration";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";

const CHATGPT_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "resource.invoke",
  CHATGPT_PLAN_SCOPE,
] as const;

export interface ChatGptSavedRegistration {
  /** Issued dynamic client ID associated with one validated account registration. */
  clientId: string;
  /** Retained ID token used only as a returning-account hint. */
  idTokenHint?: string;
  /** Optional email hint from the same validated identity. */
  loginHint?: string;
}

export interface ChatGptAuthorizationOptions {
  /** Stable per-installation identifier in urn:uuid form. */
  hostId: string;
  /** Consistent public application name shown during initial authorization. */
  agentName: string;
  /** Port already reserved by the loopback callback listener. */
  callbackPort: number;
  /** Existing registration for reauthorization; omit it for a new account. */
  registration?: ChatGptSavedRegistration;
  /** Cryptographically secure random-byte provider override used by tests. */
  random?: (size: number) => Uint8Array;
}

export interface ChatGptAuthorizationAttempt {
  /** Browser URL for this one authorization attempt. */
  authorizationUrl: string;
  /** Exact loopback URI reused during code exchange. */
  redirectUri: string;
  /** Client ID used to start the request. */
  requestedClientId: string;
  /** Whether the callback must supply a newly issued client ID. */
  newRegistration: boolean;
  /** Opaque state that must match the callback. */
  state: string;
  /** OIDC nonce verified against the ID token. */
  nonce: string;
  /** Secret PKCE verifier retained only for code exchange. */
  codeVerifier: string;
}

export interface ChatGptAuthorizationCallback {
  /** One-time authorization code returned by OpenAI. */
  code: string;
  /** Issued client ID used for token exchange and ID-token audience validation. */
  clientId: string;
  /** Scopes reported on the callback, pending authoritative token validation. */
  scopes: readonly string[];
}

export interface ChatGptTokenResponse {
  /** OAuth bearer token used for eligible Responses API requests. */
  accessToken: string;
  /** Rotating token used to renew access. */
  refreshToken: string;
  /** ID token that still requires cryptographic validation. */
  idToken: string;
  /** Lifetime of the access token in seconds. */
  expiresIn: number;
  /** Granted scopes returned by the token endpoint. */
  scopes: readonly string[];
}

export interface ChatGptVerifiedIdentity {
  /** Stable subject from the cryptographically verified ID token. */
  subject: string;
  /** Verified issuer. */
  issuer: "https://auth.openai.com";
  /** Optional verified email claim for display only. */
  email: string | null;
}

export interface ChatGptVerifiedConnection {
  /** Issued client ID bound to this account registration. */
  clientId: string;
  /** Cryptographically verified OpenAI identity. */
  identity: ChatGptVerifiedIdentity;
  /** OAuth credentials returned by the official token endpoint. */
  tokens: ChatGptTokenResponse;
}

export interface ChatGptOpenIdJwk {
  /** JWK key type. */
  kty: string;
  /** JWK key identifier selected by the JWT header. */
  kid: string;
  /** Additional public JWK properties. */
  [key: string]: unknown;
}

const encodeBase64Url = (value: Uint8Array): string => Buffer.from(value).toString("base64url");

const safeEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const readJsonRecord = (value: string, label: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
};

export const createChatGptAuthorizationAttempt = (
  options: ChatGptAuthorizationOptions,
): ChatGptAuthorizationAttempt => {
  if (
    !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      options.hostId,
    )
  ) {
    throw new Error("ChatGPT host ID must use urn:uuid format.");
  }
  if (options.agentName.trim() === "" || [...options.agentName].length > 80) {
    throw new Error("ChatGPT agent name must contain 1-80 characters.");
  }
  if (
    !Number.isInteger(options.callbackPort) ||
    options.callbackPort < 1 ||
    options.callbackPort > 65_535
  ) {
    throw new Error("ChatGPT callback port is invalid.");
  }
  if (
    options.registration !== undefined &&
    !/^oaiapp_[a-zA-Z0-9_-]+$/u.test(options.registration.clientId)
  ) {
    throw new Error("ChatGPT issued client ID is invalid.");
  }

  const random = options.random ?? randomBytes;
  const state = encodeBase64Url(random(32));
  const nonce = encodeBase64Url(random(32));
  const codeVerifier = encodeBase64Url(random(48));
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const newRegistration = options.registration === undefined;
  const requestedClientId = options.registration?.clientId ?? CHATGPT_DYNAMIC_CLIENT_ID;
  const redirectUri = `http://127.0.0.1:${options.callbackPort}/auth/callback`;
  const authorizationUrl = new URL(CHATGPT_AUTHORIZE_ENDPOINT);
  authorizationUrl.searchParams.set("client_id", requestedClientId);
  authorizationUrl.searchParams.set("ext_agent_host_id", options.hostId);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("scope", CHATGPT_SCOPES.join(" "));
  authorizationUrl.searchParams.set("resource", CHATGPT_RESOURCE);
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("nonce", nonce);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  if (newRegistration) {
    authorizationUrl.searchParams.set("agent_name_hint", options.agentName);
  } else {
    if (options.registration?.idTokenHint !== undefined) {
      authorizationUrl.searchParams.set("id_token_hint", options.registration.idTokenHint);
    }
    if (options.registration?.loginHint !== undefined) {
      authorizationUrl.searchParams.set("login_hint", options.registration.loginHint);
    }
  }

  return Object.freeze({
    authorizationUrl: authorizationUrl.toString(),
    redirectUri,
    requestedClientId,
    newRegistration,
    state,
    nonce,
    codeVerifier,
  });
};

export const parseChatGptAuthorizationCallback = (
  callbackUrl: string,
  attempt: ChatGptAuthorizationAttempt,
): ChatGptAuthorizationCallback => {
  const callback = new URL(callbackUrl);
  if (`${callback.origin}${callback.pathname}` !== attempt.redirectUri) {
    throw new Error("ChatGPT callback URI does not match the pending authorization attempt.");
  }
  const returnedState = callback.searchParams.get("state") ?? "";
  if (!safeEqual(returnedState, attempt.state)) {
    throw new Error("ChatGPT callback state does not match the pending authorization attempt.");
  }
  const oauthError = callback.searchParams.get("error");
  if (oauthError !== null) {
    throw new Error(`ChatGPT authorization failed with ${oauthError}.`);
  }
  const code = callback.searchParams.get("code");
  if (code === null || code === "") {
    throw new Error("ChatGPT callback did not include an authorization code.");
  }
  const returnedClientId = callback.searchParams.get("client_id");
  const clientId = returnedClientId ?? attempt.requestedClientId;
  if (attempt.newRegistration) {
    if (returnedClientId === null || !/^oaiapp_[a-zA-Z0-9_-]+$/u.test(returnedClientId)) {
      throw new Error("ChatGPT registration did not return a valid issued client ID.");
    }
  } else if (returnedClientId !== null && returnedClientId !== attempt.requestedClientId) {
    throw new Error("ChatGPT callback client ID does not match the selected registration.");
  }
  const scopes = (callback.searchParams.get("scope") ?? "")
    .split(" ")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
  return Object.freeze({ code, clientId, scopes });
};

export const exchangeChatGptAuthorizationCode = async (
  callback: ChatGptAuthorizationCallback,
  attempt: ChatGptAuthorizationAttempt,
  request: typeof fetch = fetch,
): Promise<ChatGptTokenResponse> => {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: callback.clientId,
    code: callback.code,
    code_verifier: attempt.codeVerifier,
    redirect_uri: attempt.redirectUri,
    resource: CHATGPT_RESOURCE,
  });
  const response = await request(CHATGPT_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`ChatGPT token exchange failed with HTTP ${response.status}.`);
  }
  const value = (await response.json()) as Record<string, unknown>;
  if (
    typeof value.access_token !== "string" ||
    typeof value.refresh_token !== "string" ||
    typeof value.id_token !== "string" ||
    value.token_type !== "Bearer" ||
    !Number.isSafeInteger(value.expires_in) ||
    Number(value.expires_in) < 1
  ) {
    throw new Error("ChatGPT token response is invalid.");
  }
  const scopes = typeof value.scope === "string" ? value.scope.split(" ").filter(Boolean) : [];
  if (!scopes.includes(CHATGPT_PLAN_SCOPE)) {
    throw new Error("ChatGPT plan usage was not granted.");
  }
  return Object.freeze({
    accessToken: value.access_token,
    refreshToken: value.refresh_token,
    idToken: value.id_token,
    expiresIn: Number(value.expires_in),
    scopes,
  });
};

export const verifyChatGptIdToken = (
  idToken: string,
  clientId: string,
  nonce: string,
  keys: readonly ChatGptOpenIdJwk[],
  now: Date = new Date(),
): ChatGptVerifiedIdentity => {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("ChatGPT ID token is malformed.");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    throw new Error("ChatGPT ID token is malformed.");
  }
  const header = readJsonRecord(
    Buffer.from(encodedHeader, "base64url").toString("utf8"),
    "JWT header",
  );
  const payload = readJsonRecord(
    Buffer.from(encodedPayload, "base64url").toString("utf8"),
    "JWT payload",
  );
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("ChatGPT ID token uses an unsupported signature.");
  }
  const key = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (key === undefined) {
    throw new Error("ChatGPT ID token signing key was not found.");
  }
  const signatureValid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    createPublicKey({ key, format: "jwk" }),
    Buffer.from(encodedSignature, "base64url"),
  );
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (
    !signatureValid ||
    payload.iss !== "https://auth.openai.com" ||
    !audience.includes(clientId) ||
    typeof payload.exp !== "number" ||
    payload.exp <= Math.floor(now.getTime() / 1_000) ||
    typeof payload.nonce !== "string" ||
    !safeEqual(payload.nonce, nonce) ||
    typeof payload.sub !== "string" ||
    payload.sub === ""
  ) {
    throw new Error("ChatGPT ID token validation failed.");
  }
  return Object.freeze({
    subject: payload.sub,
    issuer: "https://auth.openai.com",
    email: typeof payload.email === "string" ? payload.email : null,
  });
};

export const loadChatGptOpenIdKeys = async (
  request: typeof fetch = fetch,
): Promise<readonly ChatGptOpenIdJwk[]> => {
  const configurationResponse = await request(CHATGPT_OPENID_CONFIGURATION, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!configurationResponse.ok) {
    throw new Error(`ChatGPT OpenID discovery failed with HTTP ${configurationResponse.status}.`);
  }
  const configuration = (await configurationResponse.json()) as Record<string, unknown>;
  if (
    configuration.issuer !== "https://auth.openai.com" ||
    typeof configuration.jwks_uri !== "string"
  ) {
    throw new Error("ChatGPT OpenID configuration is invalid.");
  }
  const jwksUrl = new URL(configuration.jwks_uri);
  if (jwksUrl.protocol !== "https:" || jwksUrl.hostname !== "auth.openai.com") {
    throw new Error("ChatGPT JWKS endpoint is not trusted.");
  }
  const keysResponse = await request(jwksUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!keysResponse.ok) {
    throw new Error(`ChatGPT JWKS request failed with HTTP ${keysResponse.status}.`);
  }
  const keySet = (await keysResponse.json()) as { keys?: unknown };
  if (!Array.isArray(keySet.keys) || keySet.keys.length === 0) {
    throw new Error("ChatGPT JWKS response is invalid.");
  }
  const keys = keySet.keys.filter(
    (key): key is ChatGptOpenIdJwk =>
      typeof key === "object" &&
      key !== null &&
      !Array.isArray(key) &&
      typeof (key as Record<string, unknown>).kid === "string" &&
      typeof (key as Record<string, unknown>).kty === "string",
  );
  if (keys.length === 0) {
    throw new Error("ChatGPT JWKS response contains no supported public keys.");
  }
  return keys;
};

export const completeChatGptAuthorization = async (
  callback: ChatGptAuthorizationCallback,
  attempt: ChatGptAuthorizationAttempt,
  request: typeof fetch = fetch,
): Promise<ChatGptVerifiedConnection> => {
  const tokens = await exchangeChatGptAuthorizationCode(callback, attempt, request);
  const keys = await loadChatGptOpenIdKeys(request);
  const identity = verifyChatGptIdToken(tokens.idToken, callback.clientId, attempt.nonce, keys);
  return Object.freeze({ clientId: callback.clientId, identity, tokens });
};

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import {
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_PLAN_SCOPE,
  type ChatGptOpenIdJwk,
  createChatGptAuthorizationAttempt,
  exchangeChatGptAuthorizationCode,
  parseChatGptAuthorizationCallback,
  verifyChatGptIdToken,
} from "./chatgpt.js";

const HOST_ID = "urn:uuid:123e4567-e89b-42d3-a456-426614174000";
const deterministicRandom = (size: number): Uint8Array => new Uint8Array(size).fill(size);

test("creates an official PKCE authorization request for a new registration", () => {
  const attempt = createChatGptAuthorizationAttempt({
    hostId: HOST_ID,
    agentName: "AI-Tidu9",
    callbackPort: 9639,
    random: deterministicRandom,
  });
  const authorizationUrl = new URL(attempt.authorizationUrl);

  assert.equal(authorizationUrl.searchParams.get("client_id"), CHATGPT_DYNAMIC_CLIENT_ID);
  assert.equal(authorizationUrl.searchParams.get("agent_name_hint"), "AI-Tidu9");
  assert.equal(authorizationUrl.searchParams.get("ext_agent_host_id"), HOST_ID);
  assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(attempt.redirectUri, "http://127.0.0.1:9639/auth/callback");
});

test("validates callback state and issued client identity", () => {
  const attempt = createChatGptAuthorizationAttempt({
    hostId: HOST_ID,
    agentName: "AI-Tidu9",
    callbackPort: 9639,
    random: deterministicRandom,
  });
  const callback = parseChatGptAuthorizationCallback(
    `${attempt.redirectUri}?code=code-1&state=${attempt.state}&client_id=oaiapp_tidu&scope=${CHATGPT_PLAN_SCOPE}`,
    attempt,
  );

  assert.equal(callback.clientId, "oaiapp_tidu");
  assert.throws(
    () =>
      parseChatGptAuthorizationCallback(
        `${attempt.redirectUri}?code=code-1&state=wrong&client_id=oaiapp_tidu`,
        attempt,
      ),
    /state does not match/u,
  );
});

test("exchanges a code without exposing a client secret", async () => {
  const attempt = createChatGptAuthorizationAttempt({
    hostId: HOST_ID,
    agentName: "AI-Tidu9",
    callbackPort: 9639,
    random: deterministicRandom,
  });
  const callback = parseChatGptAuthorizationCallback(
    `${attempt.redirectUri}?code=code-1&state=${attempt.state}&client_id=oaiapp_tidu`,
    attempt,
  );
  let postedBody = "";
  const tokens = await exchangeChatGptAuthorizationCode(callback, attempt, async (_input, init) => {
    postedBody = String(init?.body);
    return new Response(
      JSON.stringify({
        access_token: "access-test",
        refresh_token: "refresh-test",
        id_token: "id-test",
        token_type: "Bearer",
        expires_in: 3600,
        scope: `openid ${CHATGPT_PLAN_SCOPE}`,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });

  assert.equal(tokens.expiresIn, 3600);
  assert.equal(postedBody.includes("client_secret"), false);
  assert.equal(postedBody.includes("code_verifier="), true);
});

test("verifies an RS256 ID token, audience, expiry, and nonce", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      aud: "oaiapp_tidu",
      exp: 1_800_000_000,
      nonce: "nonce-test",
      sub: "account-subject",
      email: "user@example.com",
    }),
  ).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString(
    "base64url",
  );
  const key = { ...publicKey.export({ format: "jwk" }), kid: "test-key" } as ChatGptOpenIdJwk;

  const identity = verifyChatGptIdToken(
    `${header}.${payload}.${signature}`,
    "oaiapp_tidu",
    "nonce-test",
    [key],
    new Date("2026-10-12T00:00:00.000Z"),
  );
  assert.equal(identity.subject, "account-subject");
  assert.throws(
    () =>
      verifyChatGptIdToken(
        `${header}.${payload}.${signature}`,
        "wrong-client",
        "nonce-test",
        [key],
        new Date("2026-10-12T00:00:00.000Z"),
      ),
    /validation failed/u,
  );
});

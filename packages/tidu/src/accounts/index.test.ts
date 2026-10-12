import assert from "node:assert/strict";
import test from "node:test";

import {
  createHostAccountRegistry,
  HOST_ACCOUNT_BRIDGE_VERSION,
  type HostAccountBridge,
  type HostAccountProfile,
} from "./index.js";

const PROFILE: HostAccountProfile = {
  id: "chatgpt-work",
  provider: "chatgpt",
  label: "Current host account",
  authority: "host-delegated",
  status: "available",
  revision: 2,
};

const createBridge = (profile: HostAccountProfile = PROFILE): HostAccountBridge => ({
  id: "codex-host",
  listProfiles: async () => [profile],
  openSession: async (profileId, taskId) => ({
    snapshot: {
      bridgeVersion: HOST_ACCOUNT_BRIDGE_VERSION,
      taskId,
      profileId,
      provider: profile.provider,
      authority: profile.authority,
      profileRevision: profile.revision,
      selectedAt: "host-owned",
    },
    execute: async () => ({ statusCode: 200, headers: {}, body: { ok: true } }),
    close: async () => undefined,
  }),
});

test("creates an immutable task snapshot without copying credentials", async () => {
  const registry = createHostAccountRegistry([createBridge()], {
    now: () => new Date("2026-10-12T09:00:00.000Z"),
  });
  const session = await registry.openSession("chatgpt-work", "task-account-1");

  assert.deepEqual(session.snapshot, {
    bridgeVersion: HOST_ACCOUNT_BRIDGE_VERSION,
    taskId: "task-account-1",
    profileId: "chatgpt-work",
    provider: "chatgpt",
    authority: "host-delegated",
    profileRevision: 2,
    selectedAt: "2026-10-12T09:00:00.000Z",
  });
  assert.equal(Object.isFrozen(session.snapshot), true);
  assert.equal(JSON.stringify(session.snapshot).includes("token"), false);
});

test("rejects unavailable and ambiguous profiles before opening a session", async () => {
  const unavailable = createHostAccountRegistry([createBridge({ ...PROFILE, status: "expired" })]);
  await assert.rejects(unavailable.openSession("chatgpt-work", "task-account-2"), /is expired/u);

  const duplicateBridge = { ...createBridge(), id: "second-host" };
  const ambiguous = createHostAccountRegistry([createBridge(), duplicateBridge]);
  await assert.rejects(ambiguous.listProfiles(), /ambiguous/u);
});

test("closes a mismatched authority session", async () => {
  let closed = false;
  const bridge = createBridge();
  bridge.openSession = async (_profileId, taskId) => ({
    snapshot: {
      bridgeVersion: HOST_ACCOUNT_BRIDGE_VERSION,
      taskId,
      profileId: "wrong-profile",
      provider: "chatgpt",
      authority: "host-delegated",
      profileRevision: 2,
      selectedAt: "host-owned",
    },
    execute: async () => ({ statusCode: 200, headers: {}, body: {} }),
    close: async () => {
      closed = true;
    },
  });

  await assert.rejects(
    createHostAccountRegistry([bridge]).openSession("chatgpt-work", "task-account-3"),
    /does not match/u,
  );
  assert.equal(closed, true);
});

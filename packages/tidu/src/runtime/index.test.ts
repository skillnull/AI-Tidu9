import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG_SCHEMA_VERSION } from "../config/index.js";
import { PRODUCT } from "../core/index.js";
import { IN_MEMORY_DATABASE_PATH, STORAGE_SCHEMA_VERSION } from "../storage/index.js";
import { startLocalRuntime } from "./index.js";

test("starts a loopback runtime with a verifiable health endpoint", async () => {
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
  });

  try {
    const response = await fetch(`${runtime.origin}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      product: PRODUCT.name,
      status: "ok",
      storage: {
        provider: "sqlite",
        schemaVersion: STORAGE_SCHEMA_VERSION,
        status: "ok",
      },
      version: PRODUCT.version,
    });
  } finally {
    await runtime.close();
  }
});

test("serves the local configuration center and its bootstrap API", async () => {
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
  });

  try {
    const pageResponse = await fetch(runtime.origin);
    assert.equal(pageResponse.status, 200);
    assert.match(pageResponse.headers.get("content-type") ?? "", /^text\/html/u);
    assert.match(pageResponse.headers.get("content-security-policy") ?? "", /default-src 'self'/u);
    assert.equal(pageResponse.headers.get("x-frame-options"), "DENY");
    const page = await pageResponse.text();
    assert.match(page, /九门赛博提督/u);

    const assetPath = page.match(/src="(\/assets\/[^"]+\.js)"/u)?.[1];
    assert.notEqual(assetPath, undefined);
    const assetResponse = await fetch(`${runtime.origin}${assetPath}`);
    assert.equal(assetResponse.status, 200);
    assert.match(assetResponse.headers.get("content-type") ?? "", /^text\/javascript/u);

    const bootstrapResponse = await fetch(`${runtime.origin}/api/config-center`);
    assert.equal(bootstrapResponse.status, 200);
    const bootstrap = (await bootstrapResponse.json()) as {
      configuration: { editable: boolean; schemaVersion: string };
      product: { name: string };
      storage: { provider: string };
    };
    assert.equal(bootstrap.product.name, PRODUCT.name);
    assert.equal(bootstrap.storage.provider, "sqlite");
    assert.equal(bootstrap.configuration.schemaVersion, CONFIG_SCHEMA_VERSION);
    assert.equal(bootstrap.configuration.editable, false);
  } finally {
    await runtime.close();
  }
});

test("does not expose undefined routes", async () => {
  const runtime = await startLocalRuntime({
    databasePath: IN_MEMORY_DATABASE_PATH,
    port: 0,
  });

  try {
    const response = await fetch(`${runtime.origin}/unknown`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "NOT_FOUND" });
  } finally {
    await runtime.close();
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { PRODUCT } from "../core/index.js";
import { createConfigCenterBootstrap } from "./index.js";

test("creates a safe read-only configuration-center bootstrap", () => {
  const bootstrap = createConfigCenterBootstrap({
    provider: "sqlite",
    schemaVersion: "1",
  });

  assert.equal(bootstrap.product.name, PRODUCT.name);
  assert.equal(bootstrap.runtime.status, "ok");
  assert.equal(bootstrap.storage.provider, "sqlite");
  assert.equal(bootstrap.configuration.activeMode, "managed");
  assert.equal(bootstrap.configuration.editable, false);
});

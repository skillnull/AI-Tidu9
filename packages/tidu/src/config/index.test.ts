import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultConfiguration } from "./index.js";

test("creates a safe managed configuration", () => {
  const configuration = createDefaultConfiguration();

  assert.equal(configuration.activeMode, "managed");
  assert.equal(configuration.activeProfileId, "managed-default");
  assert.equal(configuration.virtualModelName, "九门赛博提督");
});

import assert from "node:assert/strict";
import test from "node:test";

import { PRODUCT, TiduError } from "./index.js";

test("exports the confirmed product identity", () => {
  assert.equal(PRODUCT.name, "九门赛博提督");
  assert.equal(PRODUCT.explanation, "九门赛博提督·智能协作中枢");
  assert.match(PRODUCT.positioning, /可验证的业务结果/);
});

test("provides a stable structured error contract", () => {
  const error = new TiduError("UNSUPPORTED_COMMAND", "Unsupported command", {
    details: { command: "invalid" },
  });

  assert.equal(error.name, "TiduError");
  assert.equal(error.code, "UNSUPPORTED_COMMAND");
  assert.deepEqual(error.details, { command: "invalid" });
});

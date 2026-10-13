import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  scanPublicRepository,
  validatePackedFiles,
  validateReleaseCandidateDocuments,
} from "./release-candidate.mjs";

test("blocks private paths and credential-shaped values from public files", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "tidu-rc-privacy-"));
  try {
    writeFileSync(join(temporaryDirectory, "safe.md"), "Use /Users/example/project as a sample.");
    const privatePath = ["", "Users", "private-owner", "project"].join("/");
    writeFileSync(join(temporaryDirectory, "private.md"), `Local path: ${privatePath}`);
    assert.deepEqual(scanPublicRepository(temporaryDirectory, ["safe.md"]), []);
    assert.deepEqual(scanPublicRepository(temporaryDirectory, ["private.md"]), [
      "private.md: macOS home path",
    ]);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("rejects tests, environment files, repositories, and key material from npm output", () => {
  assert.deepEqual(validatePackedFiles(["dist/index.js", "README.md"]), []);
  assert.deepEqual(validatePackedFiles(["dist/index.test.js", ".env", "private.pem"]), [
    "Forbidden npm package path: dist/index.test.js",
    "Forbidden npm package path: .env",
    "Forbidden npm package path: private.pem",
  ]);
});

test("requires synchronized Chinese and English RC documentation", () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "tidu-rc-docs-"));
  try {
    mkdirSync(join(temporaryDirectory, "docs"));
    writeFileSync(join(temporaryDirectory, "README.md"), "集成发布候选");
    writeFileSync(join(temporaryDirectory, "docs/README.en.md"), "Integrated release candidate");
    writeFileSync(join(temporaryDirectory, "docs/architecture.md"), "客户端兼容矩阵");
    writeFileSync(
      join(temporaryDirectory, "docs/architecture.en.md"),
      "Client compatibility matrix",
    );
    writeFileSync(
      join(temporaryDirectory, "docs/release-candidate.md"),
      "升级与回滚 Upgrade and rollback 安全与隐私 Security and privacy 迁移说明 Migration notes",
    );
    assert.deepEqual(validateReleaseCandidateDocuments(temporaryDirectory), []);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

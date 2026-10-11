import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  validateBranchName,
  validateCommitMessage,
  validateMainUpdateActor,
  validatePullRequestPolicy,
  validateReleaseLines,
  validateReleaseTag,
  validateRepositoryVersions,
  validateVersion,
} from "./project-policy.mjs";

test("accepts protected, work, support, and automation branches", () => {
  for (const branchName of [
    "main",
    "feat/123-model-routing",
    "security/runtime-secret-gate",
    "support/1.x",
    "dependabot/npm_and_yarn/typescript-7.0.3",
  ]) {
    assert.equal(validateBranchName(branchName).valid, true, branchName);
  }
});

test("rejects ambiguous branch names", () => {
  for (const branchName of [
    "feature/new-ui",
    "fix_secret",
    "release/v1.2.0",
    "support/v1",
    "Feat/new-ui",
  ]) {
    assert.equal(validateBranchName(branchName).valid, false, branchName);
  }
});

test("accepts conventional commit headers", () => {
  for (const commitMessage of [
    "feat(router): add capability completion",
    "fix!: isolate runtime credentials",
    "docs: 更新贡献规范",
  ]) {
    assert.equal(validateCommitMessage(commitMessage).valid, true, commitMessage);
  }
});

test("rejects nonconforming commit headers", () => {
  for (const commitMessage of ["update readme", "feature: add router", "fix: trailing period."]) {
    assert.equal(validateCommitMessage(commitMessage).valid, false, commitMessage);
  }
});

test("accepts only supported semantic versions", () => {
  assert.equal(validateVersion("1.0.0"), true);
  assert.equal(validateVersion("0.4.0-beta.1"), true);
  assert.equal(validateVersion("1.0"), false);
  assert.equal(validateVersion("1.0.0-preview.1"), false);
});

test("allows only the repository owner to update protected release lines", () => {
  assert.equal(validateMainUpdateActor("skillnull", "main").valid, true);
  assert.equal(validateMainUpdateActor("contributor", "main").valid, false);
  assert.equal(validateMainUpdateActor("contributor", "support/1.x").valid, false);
  assert.equal(validateMainUpdateActor("contributor", "feat/model-routing").valid, true);
});

test("requires focused pull requests and maintenance-safe changes", () => {
  assert.equal(
    validatePullRequestPolicy("feat/model-routing", "main", "feat: add routing").valid,
    true,
  );
  assert.equal(
    validatePullRequestPolicy("fix/runtime-gate", "support/1.x", "fix: close runtime leak").valid,
    true,
  );
  assert.equal(
    validatePullRequestPolicy("feat/new-router", "support/1.x", "feat: add router").valid,
    false,
  );
  assert.equal(
    validatePullRequestPolicy("support/1.x", "main", "fix: merge support line").valid,
    false,
  );
});

test("enforces one active owner for each major version", () => {
  assert.deepEqual(validateReleaseLines("main", "3.0.0", ["support/1.x", "support/2.x"]), []);
  assert.equal(validateReleaseLines("main", "3.0.0", ["support/3.x"]).length, 1);
  assert.equal(validateReleaseLines("support/2.x", "3.0.0", ["support/2.x"]).length, 1);
  assert.equal(
    validateReleaseLines("main", "4.0.0", ["support/1.x", "support/2.x", "support/3.x"]).length,
    1,
  );
});

test("requires release tags to match the repository version", () => {
  assert.equal(validateReleaseTag("v1.2.3", "1.2.3").valid, true);
  assert.equal(validateReleaseTag("v1.2.4", "1.2.3").valid, false);
});

test("keeps each published workspace version synchronized with the lockfile", () => {
  assert.deepEqual(validateRepositoryVersions(fileURLToPath(new URL("../", import.meta.url))), []);
});

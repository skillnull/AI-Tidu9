import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPublishFailure,
  formatPublishSuccess,
  getDistributionTag,
  getNextPrereleaseVersion,
  prepareChangelog,
  validatePublishContext,
} from "./publish-tidu.mjs";

const validContext = Object.freeze({
  branchName: "main",
  changelog: "## 1.2.3",
  headCommit: "release-commit",
  packageName: "@skillnull/tidu",
  packageVersion: "1.2.3",
  repositoryVersion: "1.2.3",
  remoteTagCommit: "release-commit",
  status: "",
  tagCommit: "release-commit",
});

test("maps semantic versions to safe npm distribution tags", () => {
  assert.equal(getDistributionTag("1.2.3"), "latest");
  assert.equal(getDistributionTag("1.2.3-alpha.1"), "alpha");
  assert.equal(getDistributionTag("1.2.3-beta.2"), "beta");
  assert.equal(getDistributionTag("1.2.3-rc.3"), "rc");
});

test("increments prerelease versions without changing their channel", () => {
  assert.equal(getNextPrereleaseVersion("1.2.3-alpha.9"), "1.2.3-alpha.10");
  assert.equal(getNextPrereleaseVersion("1.2.3-beta.2"), "1.2.3-beta.3");
  assert.throws(() => getNextPrereleaseVersion("1.2.3"), /Cannot automatically increment/u);
});

test("moves unreleased notes under an automatically generated release heading", () => {
  const changelog = "# Changelog\n\n## Unreleased / 未发布\n\n- Added a release flow.\n";
  const prepared = prepareChangelog(changelog, "1.2.3-alpha.2", "2026-10-11");

  assert.match(prepared, /## Unreleased \/ 未发布\n\n## 1\.2\.3-alpha\.2 - 2026-10-11/u);
  assert.equal(prepareChangelog(prepared, "1.2.3-alpha.2", "2026-10-11"), prepared);
});

test("prints unambiguous publish outcomes", () => {
  assert.match(formatPublishFailure("Missing release tag."), /^✖ PUBLISH BLOCKED/u);
  assert.equal(formatPublishFailure("Missing release tag.", true).startsWith("\u001b[1;31m"), true);
  assert.match(
    formatPublishSuccess({ distributionTag: "alpha", dryRun: true, version: "1.2.3-alpha.1" }),
    /validated but not published/u,
  );
  assert.match(
    formatPublishSuccess({ distributionTag: "latest", dryRun: false, version: "1.2.3" }),
    /^✔ PUBLISHED/u,
  );
});

test("accepts a clean tagged release context", () => {
  assert.deepEqual(validatePublishContext(validContext), []);
  assert.deepEqual(validatePublishContext({ ...validContext, branchName: "support/1.x" }), []);
});

test("allows a dry-run before release tags are created", () => {
  const context = { ...validContext, remoteTagCommit: "", tagCommit: "" };

  assert.deepEqual(validatePublishContext(context, { requireReleaseTag: false }), []);
});

test("rejects releases from a support branch for another major", () => {
  const problems = validatePublishContext({ ...validContext, branchName: "support/2.x" });

  assert.deepEqual(problems, ["The support/2.x branch may publish only major 2."]);
});

test("requires a real changelog version heading", () => {
  const problems = validatePublishContext({
    ...validContext,
    changelog: "## Unreleased\n\nPreparing version 1.2.3.",
  });

  assert.deepEqual(problems, ["docs/CHANGELOG.md must contain a heading for version 1.2.3."]);
});

test("rejects dirty, untagged, mismatched, or unrecorded releases", () => {
  const problems = validatePublishContext({
    ...validContext,
    branchName: "feat/release",
    changelog: "## Unreleased",
    packageName: "tidu",
    packageVersion: "1.2.4",
    remoteTagCommit: "",
    status: "M package.json",
    tagCommit: "",
  });

  assert.equal(problems.length, 7);
});

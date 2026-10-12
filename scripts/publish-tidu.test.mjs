import assert from "node:assert/strict";
import test from "node:test";

import {
  formatPublishedPackageSyncFailure,
  formatPublishFailure,
  formatPublishSuccess,
  formatReleaseSummary,
  getDistributionTag,
  getDistributionTags,
  getNextPrereleaseVersion,
  parseGitStatusPaths,
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

test("promotes prereleases to latest only before the first stable release", () => {
  assert.deepEqual(getDistributionTags("0.2.0-alpha.1", ["0.1.0-alpha.2"]), ["alpha", "latest"]);
  assert.deepEqual(getDistributionTags("1.1.0-beta.1", ["1.0.0"]), ["beta"]);
  assert.deepEqual(getDistributionTags("1.1.0", ["1.0.0"]), ["latest"]);
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

test("preserves paths from git porcelain status", () => {
  assert.deepEqual(
    parseGitStatusPaths(
      " M docs/CHANGELOG.md\nM  package.json\n?? packages/tidu/generated-file.json",
    ),
    ["docs/CHANGELOG.md", "package.json", "packages/tidu/generated-file.json"],
  );
});

test("prints unambiguous publish outcomes", () => {
  assert.match(formatPublishFailure("Missing release tag."), /^✖ PUBLISH BLOCKED/u);
  assert.equal(formatPublishFailure("Missing release tag.", true).startsWith("\u001b[1;31m"), true);
  assert.match(
    formatPublishSuccess({
      distributionTag: "alpha",
      dryRun: true,
      version: "1.2.3-alpha.1",
    }),
    /validated but not published/u,
  );
  assert.match(
    formatPublishSuccess({
      distributionTag: "latest",
      dryRun: false,
      version: "1.2.3",
    }),
    /^✔ PUBLISHED/u,
  );
  assert.match(
    formatPublishedPackageSyncFailure("Push rejected."),
    /^✖ RELEASE SYNC FAILED.*is published/u,
  );
  assert.match(
    formatPublishSuccess({
      distributionTag: "alpha",
      distributionTags: ["alpha", "latest"],
      dryRun: false,
      version: "0.2.0-alpha.1",
    }),
    /npm tags alpha, latest/u,
  );
});

test("prints a concise color-aware release summary", () => {
  const summary = formatReleaseSummary({
    currentVersion: "1.2.3-alpha.1",
    releaseDate: "2026-10-11",
    version: "1.2.3-alpha.2",
  });
  const coloredSummary = formatReleaseSummary(
    {
      currentVersion: "1.2.3-alpha.1",
      releaseDate: "2026-10-11",
      version: "1.2.3-alpha.2",
    },
    true,
  );

  assert.match(summary, /1\.2\.3-alpha\.1 → 1\.2\.3-alpha\.2/u);
  assert.match(summary, /npm tags:\s+alpha, latest/u);
  assert.match(summary, /local commit\/tag → npm publish → push/u);
  assert.doesNotMatch(summary, /diff --git/u);
  assert.equal(coloredSummary.includes("\u001b[1;36mRelease summary"), true);
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
  const problems = validatePublishContext({
    ...validContext,
    branchName: "support/2.x",
  });

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

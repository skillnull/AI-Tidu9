import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  formatPublishedPackageSyncFailure,
  formatPublishFailure,
  formatPublishSuccess,
  formatReleaseSummary,
  getDistributionTag,
  getDistributionTags,
  getNextPrereleaseVersion,
  getNextReleaseVersion,
  getUnexpectedChangedPaths,
  parseGitStatusPaths,
  prepareChangelog,
  selectQualityWorkflowRun,
  toPythonVersion,
  updateJsonVersion,
  updatePythonVersion,
  validatePublishContext,
} from "./publish-tidu.mjs";
import { synchronizeStagedPackageVersions } from "./sync-package-versions.mjs";

const validContext = Object.freeze({
  branchName: "main",
  changelog: "## 1.2.3",
  changelogEnglish: "## 1.2.3",
  headCommit: "release-commit",
  packageName: "@skillnull/tidu",
  packageVersion: "1.2.3",
  repositoryVersion: "1.2.3",
  remoteTagCommit: "release-commit",
  status: "",
  tagCommit: "release-commit",
});

test("forwards npm release arguments to the publishing script", () => {
  const repositoryPackage = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );

  assert.equal(
    repositoryPackage.scripts["publish:tidu"],
    `sh -c '. ./scripts/use-project-node.sh && node scripts/publish-tidu.mjs "$@"' --`,
  );
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

test("increments a published stable version as a patch release", () => {
  assert.equal(getNextReleaseVersion("1.1.0"), "1.1.1");
  assert.equal(getNextReleaseVersion("1.2.3-rc.2"), "1.2.3-rc.3");
});

test("moves unreleased notes under an automatically generated release heading", () => {
  const changelog = "# Changelog\n\n## Unreleased\n\n- Added a release flow.\n";
  const prepared = prepareChangelog(changelog, "1.2.3-alpha.2", "2026-10-11");

  assert.match(prepared, /## Unreleased\n\n## 1\.2\.3-alpha\.2 - 2026-10-11/u);
  assert.equal(prepareChangelog(prepared, "1.2.3-alpha.2", "2026-10-11"), prepared);

  const chinese = "# 变更记录\n\n## 未发布\n\n- 增加发布流程。\n";
  assert.match(
    prepareChangelog(chinese, "1.2.3-alpha.2", "2026-10-11", "## 未发布"),
    /## 未发布\n\n## 1\.2\.3-alpha\.2 - 2026-10-11/u,
  );
});

test("updates release versions without reformatting JSON metadata", () => {
  const metadata =
    '{\n  "name": "example",\n  "version": "1.0.0",\n  "values": ["one", "two"]\n}\n';
  assert.equal(
    updateJsonVersion(metadata, "1.1.0-alpha.1"),
    '{\n  "name": "example",\n  "version": "1.1.0-alpha.1",\n  "values": ["one", "two"]\n}\n',
  );
  assert.throws(() => updateJsonVersion('{"name":"example"}', "1.1.0"), /version field/u);
});

test("maps SemVer prereleases to synchronized Python metadata", () => {
  assert.equal(toPythonVersion("0.8.0-alpha.2"), "0.8.0a2");
  assert.equal(toPythonVersion("0.8.0-beta.1"), "0.8.0b1");
  assert.equal(toPythonVersion("1.0.0-rc.3"), "1.0.0rc3");
  assert.equal(toPythonVersion("1.0.0"), "1.0.0");
  assert.equal(
    updatePythonVersion('version = "0.7.0rc1"\n', "0.8.0-beta.1"),
    'version = "0.8.0b1"\n',
  );
  assert.equal(
    updatePythonVersion('__version__ = "0.7.0rc1"\n', "0.8.0-beta.1"),
    '__version__ = "0.8.0b1"\n',
  );
});

test("synchronizes staged package versions into both connector manifests", () => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "tidu-version-sync-"));
  const packagePath = join(repositoryRoot, "packages/tidu/package.json");
  const manifestPaths = [
    join(repositoryRoot, "packages/tidu/connectors/codex/ai-tidu9/plugin.json"),
    join(repositoryRoot, "packages/tidu/connectors/codex/ai-tidu9/.codex-plugin/plugin.json"),
  ];
  const pythonMetadataPaths = [
    join(repositoryRoot, "sdk/python/pyproject.toml"),
    join(repositoryRoot, "sdk/python/src/ai_tidu9/__init__.py"),
  ];
  try {
    for (const filePath of [packagePath, ...manifestPaths]) {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, '{\n  "version": "0.5.0-beta.1"\n}\n');
    }
    mkdirSync(dirname(pythonMetadataPaths[0]), { recursive: true });
    mkdirSync(dirname(pythonMetadataPaths[1]), { recursive: true });
    writeFileSync(pythonMetadataPaths[0], 'version = "0.5.0b1"\n');
    writeFileSync(pythonMetadataPaths[1], '__version__ = "0.5.0b1"\n');
    execFileSync("git", ["init", "--quiet"], { cwd: repositoryRoot });
    execFileSync("git", ["add", "."], { cwd: repositoryRoot });
    writeFileSync(packagePath, '{\n  "version": "0.6.0-beta.1"\n}\n');
    execFileSync("git", ["add", "packages/tidu/package.json"], { cwd: repositoryRoot });

    const result = synchronizeStagedPackageVersions(repositoryRoot);

    assert.equal(result.packageVersion, "0.6.0-beta.1");
    assert.equal(result.synchronizedPaths.length, 4);
    for (const manifestPath of manifestPaths) {
      assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).version, "0.6.0-beta.1");
      const relativePath = manifestPath.slice(repositoryRoot.length + 1);
      const stagedManifest = execFileSync("git", ["show", `:${relativePath}`], {
        cwd: repositoryRoot,
        encoding: "utf8",
      });
      assert.equal(JSON.parse(stagedManifest).version, "0.6.0-beta.1");
    }
    assert.equal(readFileSync(pythonMetadataPaths[0], "utf8"), 'version = "0.6.0b1"\n');
    assert.equal(readFileSync(pythonMetadataPaths[1], "utf8"), '__version__ = "0.6.0b1"\n');
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("preserves paths from git porcelain status", () => {
  assert.deepEqual(
    parseGitStatusPaths(
      " M docs/CHANGELOG.md\nM  package.json\n?? packages/tidu/generated-file.json",
    ),
    ["docs/CHANGELOG.md", "package.json", "packages/tidu/generated-file.json"],
  );
});

test("allows partial release metadata while rejecting unrelated working changes", () => {
  const allowedPaths = [
    "docs/CHANGELOG.md",
    "docs/CHANGELOG.EN.md",
    "packages/tidu/package.json",
    "packages/tidu/connectors/codex/ai-tidu9/plugin.json",
  ];

  assert.deepEqual(
    getUnexpectedChangedPaths(
      "M  packages/tidu/package.json\n M packages/tidu/connectors/codex/ai-tidu9/plugin.json",
      allowedPaths,
    ),
    [],
  );
  assert.deepEqual(
    getUnexpectedChangedPaths(
      "M  packages/tidu/package.json\n M packages/tidu/src/index.ts",
      allowedPaths,
    ),
    ["packages/tidu/src/index.ts"],
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
  assert.match(summary, /release commit → branch CI → immutable tag CI → npm publish/u);
  assert.doesNotMatch(summary, /diff --git/u);
  assert.equal(coloredSummary.includes("\u001b[1;36mRelease summary"), true);
});

test("selects only the newest Quality run for the exact release ref and commit", () => {
  const selected = selectQualityWorkflowRun(
    [
      {
        id: 10,
        name: "Quality",
        event: "push",
        head_branch: "main",
        head_sha: "release-commit",
        status: "completed",
        conclusion: "failure",
      },
      {
        id: 12,
        name: "Quality",
        event: "push",
        head_branch: "main",
        head_sha: "release-commit",
        status: "completed",
        conclusion: "success",
      },
      {
        id: 14,
        name: "Quality",
        event: "push",
        head_branch: "v1.2.3",
        head_sha: "release-commit",
        status: "completed",
        conclusion: "success",
      },
    ],
    "release-commit",
    "main",
  );

  assert.equal(selected?.id, 12);
  assert.equal(selectQualityWorkflowRun([], "release-commit", "main"), undefined);
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

test("requires synchronized English changelog headings", () => {
  const problems = validatePublishContext({
    ...validContext,
    changelogEnglish: "## Unreleased\n\nPreparing version 1.2.3.",
  });

  assert.deepEqual(problems, ["docs/CHANGELOG.EN.md must contain a heading for version 1.2.3."]);
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

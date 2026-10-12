import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateVersion } from "./project-policy.mjs";

const RELEASE = Object.freeze({
  packageName: "@skillnull/tidu",
  packagePath: "packages/tidu",
  supportedArguments: new Set(["--dry-run"]),
});
const TERMINAL_COLOR = Object.freeze({
  blue: "\u001b[1;34m",
  cyan: "\u001b[1;36m",
  green: "\u001b[1;32m",
  magenta: "\u001b[1;35m",
  red: "\u001b[1;31m",
  reset: "\u001b[0m",
  yellow: "\u001b[1;33m",
});

class PublishedPackageSyncError extends Error {}

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));
const writeJson = (filePath, value) =>
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);

const getChangelogVersionPattern = (version) => {
  const escapedVersion = version.replaceAll(".", "\\.");
  return new RegExp(`^##\\s+(?:\\[)?${escapedVersion}(?:\\])?(?:\\s|$)`, "mu");
};

export const getNextPrereleaseVersion = (version) => {
  const prereleaseMatch = version.match(/^(\d+)\.(\d+)\.(\d+)-(alpha|beta|rc)\.(\d+)$/u);
  if (prereleaseMatch === null) {
    throw new Error(`Cannot automatically increment non-prerelease version ${version}.`);
  }
  const [, major, minor, patch, channel, sequence] = prereleaseMatch;
  return `${major}.${minor}.${patch}-${channel}.${Number(sequence) + 1}`;
};

export const prepareChangelog = (changelog, version, releaseDate) => {
  if (getChangelogVersionPattern(version).test(changelog)) {
    return changelog;
  }
  const marker = "## Unreleased / 未发布";
  if (!changelog.includes(marker)) {
    throw new Error(`docs/CHANGELOG.md must contain ${marker}.`);
  }
  return changelog.replace(marker, `${marker}\n\n## ${version} - ${releaseDate}`);
};

export const getDistributionTag = (version) => {
  const prereleaseMatch = version.match(/-(alpha|beta|rc)\.[1-9]\d*$/u);
  return prereleaseMatch?.[1] ?? "latest";
};

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export const getDistributionTags = (version, publishedVersions = []) => {
  const primaryTag = getDistributionTag(version);
  const hasStableRelease = publishedVersions.some((publishedVersion) =>
    STABLE_VERSION_PATTERN.test(publishedVersion),
  );
  return primaryTag === "latest" || hasStableRelease ? [primaryTag] : [primaryTag, "latest"];
};

const applyTerminalColor = (message, color, enabled) =>
  enabled ? `${TERMINAL_COLOR[color]}${message}${TERMINAL_COLOR.reset}` : message;

const isTerminalColorEnabled = (stream) =>
  process.env.NO_COLOR === undefined &&
  (process.env.FORCE_COLOR === "0"
    ? false
    : process.env.FORCE_COLOR !== undefined || stream.isTTY === true);

export const formatReleaseSummary = (
  { currentVersion, publishedVersions = [], releaseDate, version },
  colorEnabled = false,
) =>
  [
    "",
    applyTerminalColor("Release summary", "cyan", colorEnabled),
    `  ${applyTerminalColor("Package:", "blue", colorEnabled)}   ${RELEASE.packageName}`,
    `  ${applyTerminalColor("Version:", "blue", colorEnabled)}   ${currentVersion} → ${version}`,
    `  ${applyTerminalColor("npm tags:", "yellow", colorEnabled)}  ${getDistributionTags(version, publishedVersions).join(", ")}`,
    `  ${applyTerminalColor("CHANGELOG:", "yellow", colorEnabled)} ${version} (${releaseDate})`,
    `  ${applyTerminalColor("Files:", "magenta", colorEnabled)}     package and connector manifests, docs/CHANGELOG.md`,
    `  ${applyTerminalColor("Next:", "magenta", colorEnabled)}      local commit/tag → npm publish → push`,
    "",
  ].join("\n");

export const formatPublishFailure = (message, colorEnabled = false) =>
  applyTerminalColor(
    `✖ PUBLISH BLOCKED — ${RELEASE.packageName} was not published.\n${message}`,
    "red",
    colorEnabled,
  );

export const formatPublishedPackageSyncFailure = (message, colorEnabled = false) =>
  applyTerminalColor(
    `✖ RELEASE SYNC FAILED — ${RELEASE.packageName} is published, but npm tags or Git are not fully synchronized.\n${message}`,
    "red",
    colorEnabled,
  );

export const formatPublishSuccess = (
  { distributionTag, distributionTags, dryRun, version },
  colorEnabled = false,
) => {
  const synchronizedTags = distributionTags ?? [distributionTag];
  const message = dryRun
    ? `✔ DRY RUN PASSED — ${RELEASE.packageName}@${version} was validated but not published.`
    : `✔ PUBLISHED — ${RELEASE.packageName}@${version} with npm tags ${synchronizedTags.join(", ")}.`;
  return applyTerminalColor(message, "green", colorEnabled);
};

export const validatePublishContext = (
  {
    branchName,
    changelog,
    headCommit,
    packageName,
    packageVersion,
    repositoryVersion,
    remoteTagCommit,
    status,
    tagCommit,
  },
  { requireReleaseTag = true } = {},
) => {
  const problems = [];
  const expectedTag = `v${repositoryVersion}`;
  const supportBranchMatch = branchName.match(/^support\/(0|[1-9]\d*)\.x$/u);
  const isReleaseLine = branchName === "main" || supportBranchMatch !== null;
  const releaseMajor = repositoryVersion.split(".", 1)[0];
  const changelogVersionHeading = getChangelogVersionPattern(repositoryVersion);

  if (packageName !== RELEASE.packageName) {
    problems.push(`Expected package ${RELEASE.packageName}; received ${packageName}.`);
  }
  if (packageVersion !== repositoryVersion) {
    problems.push(`Package version ${packageVersion} does not match ${repositoryVersion}.`);
  }
  if (!isReleaseLine) {
    problems.push("Publish only from main or support/<major>.x.");
  }
  if (supportBranchMatch !== null && supportBranchMatch[1] !== releaseMajor) {
    problems.push(`The ${branchName} branch may publish only major ${supportBranchMatch[1]}.`);
  }
  if (status.trim() !== "") {
    problems.push("The working tree must be clean before publishing.");
  }
  if (tagCommit === "" && requireReleaseTag) {
    problems.push(`Create the immutable ${expectedTag} tag before publishing.`);
  } else if (tagCommit !== "" && tagCommit !== headCommit) {
    problems.push(`${expectedTag} must point to the current commit.`);
  }
  if (remoteTagCommit === "" && requireReleaseTag) {
    problems.push(`Push ${expectedTag} to origin before publishing.`);
  } else if (remoteTagCommit !== "" && remoteTagCommit !== headCommit) {
    problems.push(`The origin ${expectedTag} tag must point to the current commit.`);
  }
  if (!changelogVersionHeading.test(changelog)) {
    problems.push(`docs/CHANGELOG.md must contain a heading for version ${repositoryVersion}.`);
  }

  return problems;
};

const runCommand = (command, argumentsList, options = {}) =>
  execFileSync(command, argumentsList, {
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });

const readCommandOutput = (command, argumentsList, options = {}) =>
  execFileSync(command, argumentsList, { encoding: "utf8", ...options });

const readCommand = (command, argumentsList, options = {}) =>
  readCommandOutput(command, argumentsList, options).trim();

const readGitStatus = (repositoryRoot) =>
  readCommandOutput("git", ["status", "--porcelain"], {
    cwd: repositoryRoot,
  }).replace(/\r?\n$/u, "");

export const parseGitStatusPaths = (status) =>
  status
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((statusLine) => statusLine.slice(3));

const readTagCommit = (repositoryRoot, tagName) => {
  const result = spawnSync("git", ["rev-list", "-n", "1", tagName], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "";
};

const readRemoteTagCommit = (repositoryRoot, tagName) => {
  const output = readCommand(
    "git",
    ["ls-remote", "--tags", "origin", `refs/tags/${tagName}`, `refs/tags/${tagName}^{}`],
    { cwd: repositoryRoot },
  );
  const references = output.split(/\r?\n/u).filter(Boolean);
  const peeledReference = references.find((reference) =>
    reference.endsWith(`refs/tags/${tagName}^{}`),
  );
  const selectedReference = peeledReference ?? references[0] ?? "";
  return selectedReference.split(/\s+/u, 1)[0] ?? "";
};

const isCommitAncestor = (repositoryRoot, ancestorCommit, descendantCommit) =>
  spawnSync("git", ["merge-base", "--is-ancestor", ancestorCommit, descendantCommit], {
    cwd: repositoryRoot,
  }).status === 0;

const readPublishedVersions = (packageName, repositoryRoot) => {
  const result = spawnSync("npm", ["view", packageName, "versions", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status === 0) {
    const parsedVersions = JSON.parse(result.stdout);
    return Array.isArray(parsedVersions) ? parsedVersions : [parsedVersions];
  }
  if (`${result.stdout}\n${result.stderr}`.includes("E404")) {
    return [];
  }
  throw new Error("Unable to read published npm versions.");
};

const isVersionPublished = (packageName, version, repositoryRoot) => {
  const result = spawnSync("npm", ["view", `${packageName}@${version}`, "version", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status === 0) {
    return true;
  }

  const errorOutput = `${result.stdout}\n${result.stderr}`;
  if (!errorOutput.includes("E404")) {
    throw new Error("Unable to verify whether the npm version is available.");
  }
  return false;
};

const assertVersionIsUnpublished = (packageName, version, repositoryRoot) => {
  if (isVersionPublished(packageName, version, repositoryRoot)) {
    throw new Error(`${packageName}@${version} is already published and cannot be overwritten.`);
  }
};

const publishPackage = (
  repositoryRoot,
  version,
  argumentsList = [],
  publishedVersions = readPublishedVersions(RELEASE.packageName, repositoryRoot),
) => {
  const distributionTags = getDistributionTags(version, publishedVersions);
  const [distributionTag] = distributionTags;
  runCommand(
    "npm",
    [
      "publish",
      "--workspace",
      RELEASE.packageName,
      "--access",
      "public",
      "--tag",
      distributionTag,
      ...argumentsList,
    ],
    { cwd: repositoryRoot },
  );
  return {
    distributionTag,
    distributionTags,
    dryRun: argumentsList.includes("--dry-run"),
    version,
  };
};

const synchronizeDistributionTags = (repositoryRoot, version, distributionTags) => {
  for (const distributionTag of distributionTags) {
    runCommand("npm", ["dist-tag", "add", `${RELEASE.packageName}@${version}`, distributionTag], {
      cwd: repositoryRoot,
    });
  }
};

const getReleaseFiles = (repositoryRoot) => ({
  changelog: resolve(repositoryRoot, "docs/CHANGELOG.md"),
  codexManifest: resolve(
    repositoryRoot,
    RELEASE.packagePath,
    "connectors/codex/ai-tidu9/.codex-plugin/plugin.json",
  ),
  package: resolve(repositoryRoot, RELEASE.packagePath, "package.json"),
  pluginManifest: resolve(
    repositoryRoot,
    RELEASE.packagePath,
    "connectors/codex/ai-tidu9/plugin.json",
  ),
});

const captureReleaseFiles = (releaseFiles) =>
  new Map(
    Object.values(releaseFiles).map((filePath) => [filePath, readFileSync(filePath, "utf8")]),
  );

const restoreReleaseFiles = (snapshots) => {
  for (const [filePath, content] of snapshots) {
    writeFileSync(filePath, content);
  }
};

const synchronizeReleaseFiles = (releaseFiles, snapshots, version, releaseDate) => {
  if (!validateVersion(version)) {
    throw new Error(`Invalid release version ${version}.`);
  }

  const publishedPackage = JSON.parse(snapshots.get(releaseFiles.package));
  publishedPackage.version = version;

  const connectorManifests = [releaseFiles.codexManifest, releaseFiles.pluginManifest];
  for (const connectorManifest of connectorManifests) {
    const manifest = JSON.parse(snapshots.get(connectorManifest));
    manifest.version = version;
    writeJson(connectorManifest, manifest);
  }

  writeJson(releaseFiles.package, publishedPackage);
  writeFileSync(
    releaseFiles.changelog,
    prepareChangelog(snapshots.get(releaseFiles.changelog), version, releaseDate),
  );
};

const readPublishContext = (repositoryRoot) => {
  const publishedPackage = readJson(resolve(repositoryRoot, RELEASE.packagePath, "package.json"));
  const releaseTag = `v${publishedPackage.version}`;
  return {
    branchName: readCommand("git", ["branch", "--show-current"], {
      cwd: repositoryRoot,
    }),
    changelog: readFileSync(resolve(repositoryRoot, "docs/CHANGELOG.md"), "utf8"),
    headCommit: readCommand("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
    }),
    packageName: publishedPackage.name,
    packageVersion: publishedPackage.version,
    releaseTag,
    remoteTagCommit: readRemoteTagCommit(repositoryRoot, releaseTag),
    repositoryVersion: publishedPackage.version,
    status: readGitStatus(repositoryRoot),
    tagCommit: readTagCommit(repositoryRoot, releaseTag),
  };
};

const publishPreparedRelease = (repositoryRoot, argumentsList) => {
  const context = readPublishContext(repositoryRoot);
  const isDryRun = argumentsList.includes("--dry-run");
  const problems = validatePublishContext(context, {
    requireReleaseTag: !isDryRun,
  });
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }

  assertVersionIsUnpublished(RELEASE.packageName, context.repositoryVersion, repositoryRoot);
  runCommand("npm", ["run", "check"], { cwd: repositoryRoot });

  return publishPackage(repositoryRoot, context.repositoryVersion, argumentsList);
};

const ensureReleaseFilesAreIsolated = (repositoryRoot, releaseFiles) => {
  const allowedPaths = new Set(
    Object.values(releaseFiles).map((filePath) => filePath.slice(repositoryRoot.length + 1)),
  );
  const changedPaths = parseGitStatusPaths(readGitStatus(repositoryRoot));
  const unexpectedPaths = changedPaths.filter((filePath) => !allowedPaths.has(filePath));
  if (unexpectedPaths.length > 0) {
    throw new Error(
      `Unexpected files changed during release preparation:\n${unexpectedPaths.join("\n")}`,
    );
  }
};

const prepareAndPublishInteractively = async (repositoryRoot) => {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new Error("Interactive publishing requires a terminal.");
  }

  const initialContext = readPublishContext(repositoryRoot);
  if (initialContext.status !== "") {
    throw new Error("The working tree must be clean before release preparation.");
  }
  if (
    initialContext.branchName !== "main" &&
    !/^support\/(0|[1-9]\d*)\.x$/u.test(initialContext.branchName)
  ) {
    throw new Error("Prepare releases only from main or support/<major>.x.");
  }

  runCommand(
    "git",
    [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${initialContext.branchName}:refs/remotes/origin/${initialContext.branchName}`,
    ],
    { cwd: repositoryRoot },
  );
  const remoteBranchCommit = readCommand(
    "git",
    ["rev-parse", `origin/${initialContext.branchName}`],
    { cwd: repositoryRoot },
  );
  const currentChangelogPrepared = getChangelogVersionPattern(
    initialContext.repositoryVersion,
  ).test(initialContext.changelog);
  const localReleasePrepared =
    currentChangelogPrepared && initialContext.tagCommit === initialContext.headCommit;
  const localReleaseAhead =
    remoteBranchCommit !== initialContext.headCommit &&
    isCommitAncestor(repositoryRoot, remoteBranchCommit, initialContext.headCommit);
  if (
    remoteBranchCommit !== initialContext.headCommit &&
    !(localReleasePrepared && localReleaseAhead)
  ) {
    throw new Error(`Local ${initialContext.branchName} must match origin before publishing.`);
  }

  const releaseFiles = getReleaseFiles(repositoryRoot);
  const snapshots = captureReleaseFiles(releaseFiles);
  const releaseDate = new Date().toISOString().slice(0, 10);
  const publishedVersions = readPublishedVersions(RELEASE.packageName, repositoryRoot);
  const versionAlreadyTagged =
    initialContext.tagCommit !== "" || initialContext.remoteTagCommit !== "";
  const versionAlreadyPublished = isVersionPublished(
    RELEASE.packageName,
    initialContext.repositoryVersion,
    repositoryRoot,
  );
  const changelogAlreadyPrepared = currentChangelogPrepared;
  const remoteSyncPending =
    versionAlreadyPublished &&
    localReleasePrepared &&
    (remoteBranchCommit !== initialContext.headCommit ||
      initialContext.remoteTagCommit !== initialContext.headCommit);
  let candidateVersion = remoteSyncPending
    ? initialContext.repositoryVersion
    : versionAlreadyPublished || (versionAlreadyTagged && !changelogAlreadyPrepared)
      ? getNextPrereleaseVersion(initialContext.repositoryVersion)
      : initialContext.repositoryVersion;
  let releaseConfirmed = false;
  let packagePublished = false;
  let releaseCommitPrepared = false;
  const colorEnabled = isTerminalColorEnabled(process.stdout);
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    synchronizeReleaseFiles(releaseFiles, snapshots, candidateVersion, releaseDate);
    while (!releaseConfirmed) {
      process.stdout.write(
        formatReleaseSummary(
          {
            currentVersion: initialContext.repositoryVersion,
            publishedVersions,
            releaseDate,
            version: candidateVersion,
          },
          colorEnabled,
        ),
      );
      if (
        !getChangelogVersionPattern(candidateVersion).test(
          readFileSync(releaseFiles.changelog, "utf8"),
        )
      ) {
        throw new Error(`CHANGELOG must contain a heading for ${candidateVersion}.`);
      }
      ensureReleaseFilesAreIsolated(repositoryRoot, releaseFiles);
      const synchronizingPublishedVersion =
        remoteSyncPending && candidateVersion === initialContext.repositoryVersion;
      if (!synchronizingPublishedVersion) {
        assertVersionIsUnpublished(RELEASE.packageName, candidateVersion, repositoryRoot);
      }
      runCommand("npm", ["run", "check"], { cwd: repositoryRoot });
      runCommand("npm", ["pack", "--workspace", RELEASE.packageName, "--dry-run"], {
        cwd: repositoryRoot,
      });
      process.stdout.write(
        `${applyTerminalColor("✔ Candidate checks passed.", "green", colorEnabled)}\n`,
      );

      const response = (
        await prompt.question(
          applyTerminalColor(
            `\nType "${candidateVersion}" to publish, "edit" to modify CHANGELOG, "version" to change the version, or "cancel": `,
            "yellow",
            colorEnabled,
          ),
        )
      ).trim();
      if (response === "cancel") {
        throw new Error("Release cancelled. No package was published.");
      }
      if (response === "edit") {
        await prompt.question(
          applyTerminalColor(
            `Edit ${releaseFiles.changelog} in your editor, then press Enter to review again.`,
            "cyan",
            colorEnabled,
          ),
        );
        continue;
      }
      if (response === "version") {
        const requestedVersion = (
          await prompt.question(
            applyTerminalColor(
              `Enter release version [${candidateVersion}]: `,
              "cyan",
              colorEnabled,
            ),
          )
        ).trim();
        if (requestedVersion !== "") {
          candidateVersion = requestedVersion;
        }
        synchronizeReleaseFiles(releaseFiles, snapshots, candidateVersion, releaseDate);
        continue;
      }
      releaseConfirmed = response === candidateVersion;
    }

    process.stdout.write(
      `${applyTerminalColor("Preparing local release commit...", "magenta", colorEnabled)}\n`,
    );

    const releaseChanges = readGitStatus(repositoryRoot);
    if (releaseChanges !== "") {
      runCommand("git", ["add", ...Object.values(releaseFiles)], {
        cwd: repositoryRoot,
      });
      runCommand("git", ["commit", "-m", `chore(release): v${candidateVersion}`], {
        cwd: repositoryRoot,
      });
    }

    const releaseTag = `v${candidateVersion}`;
    const releaseCommit = readCommand("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
    });
    const existingTagCommit = readTagCommit(repositoryRoot, releaseTag);
    if (existingTagCommit === "") {
      runCommand("git", ["tag", "-a", releaseTag, "-m", releaseTag], {
        cwd: repositoryRoot,
      });
    } else if (existingTagCommit !== releaseCommit) {
      throw new Error(`${releaseTag} already points to another commit.`);
    }
    releaseCommitPrepared = true;

    const synchronizingPublishedVersion =
      remoteSyncPending && candidateVersion === initialContext.repositoryVersion;
    let publishResult = {
      distributionTag: getDistributionTag(candidateVersion),
      distributionTags: getDistributionTags(candidateVersion, publishedVersions),
      dryRun: false,
      version: candidateVersion,
    };
    if (synchronizingPublishedVersion) {
      packagePublished = true;
      process.stdout.write(
        `${applyTerminalColor("npm version is already published; synchronizing npm tags and Git...", "yellow", colorEnabled)}\n`,
      );
    } else {
      process.stdout.write(
        `${applyTerminalColor("Publishing package to npm...", "magenta", colorEnabled)}\n`,
      );
      try {
        publishResult = publishPackage(repositoryRoot, candidateVersion, [], publishedVersions);
        packagePublished = true;
      } catch (error) {
        if (!isVersionPublished(RELEASE.packageName, candidateVersion, repositoryRoot)) {
          throw error;
        }
        packagePublished = true;
      }
    }

    synchronizeDistributionTags(repositoryRoot, candidateVersion, publishResult.distributionTags);

    runCommand("git", ["push", "origin", initialContext.branchName], {
      cwd: repositoryRoot,
    });
    const existingRemoteTagCommit = readRemoteTagCommit(repositoryRoot, releaseTag);
    if (existingRemoteTagCommit === "") {
      runCommand("git", ["push", "origin", releaseTag], {
        cwd: repositoryRoot,
      });
    } else if (existingRemoteTagCommit !== releaseCommit) {
      throw new Error(`The origin ${releaseTag} tag points to another commit.`);
    }
    return publishResult;
  } catch (error) {
    if (!packagePublished && !releaseCommitPrepared) {
      restoreReleaseFiles(snapshots);
    }
    if (!packagePublished && releaseCommitPrepared) {
      const message = error instanceof Error ? error.message : "Package publication failed.";
      throw new Error(`${message}\nLocal release commit and tag were retained for a safe retry.`);
    }
    if (packagePublished && !(error instanceof PublishedPackageSyncError)) {
      const message = error instanceof Error ? error.message : "Git synchronization failed.";
      throw new PublishedPackageSyncError(message);
    }
    throw error;
  } finally {
    prompt.close();
  }
};

const publish = async (argumentsList) => {
  const unknownArguments = argumentsList.filter(
    (argument) => !RELEASE.supportedArguments.has(argument),
  );
  if (unknownArguments.length > 0) {
    throw new Error(`Unsupported publish arguments: ${unknownArguments.join(", ")}`);
  }

  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  return argumentsList.includes("--dry-run")
    ? publishPreparedRelease(repositoryRoot, argumentsList)
    : prepareAndPublishInteractively(repositoryRoot);
};

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined && import.meta.url === pathToFileURL(realpathSync(entryPath)).href;

if (isDirectExecution) {
  try {
    const result = await publish(process.argv.slice(2));
    const colorEnabled = isTerminalColorEnabled(process.stdout);
    process.stdout.write(`${formatPublishSuccess(result, colorEnabled)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Package publication failed.";
    const colorEnabled = isTerminalColorEnabled(process.stderr);
    const output =
      error instanceof PublishedPackageSyncError
        ? formatPublishedPackageSyncFailure(message, colorEnabled)
        : formatPublishFailure(message, colorEnabled);
    process.stderr.write(`${output}\n`);
    process.exitCode = 1;
  }
}

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELEASE = Object.freeze({
  packageName: "@skillnull/tidu",
  packagePath: "packages/tidu",
  supportedArguments: new Set(["--dry-run"]),
});
const TERMINAL_COLOR = Object.freeze({
  green: "\u001b[1;32m",
  red: "\u001b[1;31m",
  reset: "\u001b[0m",
});

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

export const getDistributionTag = (version) => {
  const prereleaseMatch = version.match(/-(alpha|beta|rc)\.[1-9]\d*$/u);
  return prereleaseMatch?.[1] ?? "latest";
};

const applyTerminalColor = (message, color, enabled) =>
  enabled ? `${TERMINAL_COLOR[color]}${message}${TERMINAL_COLOR.reset}` : message;

export const formatPublishFailure = (message, colorEnabled = false) =>
  applyTerminalColor(
    `✖ PUBLISH BLOCKED — ${RELEASE.packageName} was not published.\n${message}`,
    "red",
    colorEnabled,
  );

export const formatPublishSuccess = (
  { distributionTag, dryRun, version },
  colorEnabled = false,
) => {
  const message = dryRun
    ? `✔ DRY RUN PASSED — ${RELEASE.packageName}@${version} was validated but not published.`
    : `✔ PUBLISHED — ${RELEASE.packageName}@${version} with npm tag ${distributionTag}.`;
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
  const escapedVersion = repositoryVersion.replaceAll(".", "\\.");
  const changelogVersionHeading = new RegExp(
    `^##\\s+(?:\\[)?${escapedVersion}(?:\\])?(?:\\s|$)`,
    "mu",
  );

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
  execFileSync(command, argumentsList, { encoding: "utf8", stdio: "inherit", ...options });

const readCommand = (command, argumentsList, options = {}) =>
  execFileSync(command, argumentsList, { encoding: "utf8", ...options }).trim();

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

const assertVersionIsUnpublished = (packageName, version, repositoryRoot) => {
  const result = spawnSync("npm", ["view", `${packageName}@${version}`, "version", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.status === 0) {
    throw new Error(`${packageName}@${version} is already published and cannot be overwritten.`);
  }

  const errorOutput = `${result.stdout}\n${result.stderr}`;
  if (!errorOutput.includes("E404")) {
    throw new Error("Unable to verify whether the npm version is available.");
  }
};

const publish = (argumentsList) => {
  const unknownArguments = argumentsList.filter(
    (argument) => !RELEASE.supportedArguments.has(argument),
  );
  if (unknownArguments.length > 0) {
    throw new Error(`Unsupported publish arguments: ${unknownArguments.join(", ")}`);
  }

  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const rootPackage = readJson(resolve(repositoryRoot, "package.json"));
  const publishedPackage = readJson(resolve(repositoryRoot, RELEASE.packagePath, "package.json"));
  const releaseTag = `v${rootPackage.version}`;
  const context = {
    branchName: readCommand("git", ["branch", "--show-current"], { cwd: repositoryRoot }),
    changelog: readFileSync(resolve(repositoryRoot, "docs/CHANGELOG.md"), "utf8"),
    headCommit: readCommand("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
    packageName: publishedPackage.name,
    packageVersion: publishedPackage.version,
    repositoryVersion: rootPackage.version,
    remoteTagCommit: readRemoteTagCommit(repositoryRoot, releaseTag),
    status: readCommand("git", ["status", "--porcelain"], { cwd: repositoryRoot }),
    tagCommit: readTagCommit(repositoryRoot, releaseTag),
  };
  const isDryRun = argumentsList.includes("--dry-run");
  const problems = validatePublishContext(context, { requireReleaseTag: !isDryRun });
  if (problems.length > 0) {
    throw new Error(problems.join("\n"));
  }

  assertVersionIsUnpublished(RELEASE.packageName, rootPackage.version, repositoryRoot);
  runCommand("npm", ["run", "check"], { cwd: repositoryRoot });

  const distributionTag = getDistributionTag(rootPackage.version);
  const publishArguments = [
    "publish",
    "--workspace",
    RELEASE.packageName,
    "--access",
    "public",
    "--tag",
    distributionTag,
    ...argumentsList,
  ];
  runCommand("npm", publishArguments, { cwd: repositoryRoot });
  return { distributionTag, dryRun: isDryRun, version: rootPackage.version };
};

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined && import.meta.url === pathToFileURL(realpathSync(entryPath)).href;

if (isDirectExecution) {
  try {
    const result = publish(process.argv.slice(2));
    const colorEnabled = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
    process.stdout.write(`${formatPublishSuccess(result, colorEnabled)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Package publication failed.";
    const colorEnabled = process.env.NO_COLOR === undefined && process.stderr.isTTY === true;
    process.stderr.write(`${formatPublishFailure(message, colorEnabled)}\n`);
    process.exitCode = 1;
  }
}

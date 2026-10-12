import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROJECT_POLICY = JSON.parse(
  readFileSync(new URL("../config/project-policy.json", import.meta.url), "utf8"),
);

const CHANGE_TYPE_PATTERN = PROJECT_POLICY.workBranchTypes.join("|");
const SUPPORT_PREFIX = PROJECT_POLICY.maintenance.branchPrefix;

const POLICY = Object.freeze({
  branchPattern: new RegExp(
    `^(?:${CHANGE_TYPE_PATTERN})\\/(?:[1-9]\\d*-)?[a-z0-9]+(?:-[a-z0-9]+)*$`,
  ),
  commitPattern: new RegExp(
    `^(?:${CHANGE_TYPE_PATTERN}|revert)(?:\\([a-z0-9][a-z0-9-]*\\))?!?: (.+)$`,
    "u",
  ),
  protectedBranches: new Set(PROJECT_POLICY.protectedBranches),
  supportBranchPattern: new RegExp(`^${SUPPORT_PREFIX}/(0|[1-9]\\d*)\\.x$`),
  semverPattern:
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$/,
});

const getChangeType = (value) => value.match(/^([a-z]+)(?:[/(]|!?:)/u)?.[1] ?? "";

const getSupportMajor = (branchName) => {
  const match = POLICY.supportBranchPattern.exec(branchName);
  return match === null ? null : Number(match[1]);
};

const isAutomationBranch = (branchName) =>
  /^(?:dependabot|renovate)\/[A-Za-z0-9._/-]+$/.test(branchName);

const isProtectedBranch = (branchName) =>
  POLICY.protectedBranches.has(branchName) || getSupportMajor(branchName) !== null;

export const validateBranchName = (branchName) => {
  if (branchName.length > 80) {
    return { valid: false, reason: "Branch names must not exceed 80 characters." };
  }

  const isAllowed =
    isProtectedBranch(branchName) ||
    POLICY.branchPattern.test(branchName) ||
    isAutomationBranch(branchName);

  return isAllowed
    ? { valid: true, reason: "" }
    : {
        valid: false,
        reason:
          "Use <type>/<issue>-<kebab-description>, support/<major>.x, or an approved automation branch.",
      };
};

export const validateCommitMessage = (commitMessage) => {
  const header = commitMessage.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  const match = POLICY.commitPattern.exec(header);

  if (header.length > 100) {
    return { valid: false, reason: "Commit headers must not exceed 100 characters." };
  }

  if (match === null) {
    return {
      valid: false,
      reason: "Use Conventional Commits: type(scope)!: description.",
    };
  }

  const description = match[1];
  if (description !== description.trim() || /[.。]$/u.test(description)) {
    return {
      valid: false,
      reason: "Commit descriptions must be trimmed and must not end with a full stop.",
    };
  }

  return { valid: true, reason: "" };
};

export const validateVersion = (version) => POLICY.semverPattern.test(version);

export const validateMainUpdateActor = (actor, branchName) => {
  const branchIsProtected = isProtectedBranch(branchName);
  const isOwner = actor.toLowerCase() === PROJECT_POLICY.owner.toLowerCase();

  return !branchIsProtected || isOwner
    ? { valid: true, reason: "" }
    : {
        valid: false,
        reason: `${branchName} may only be updated by repository owner @${PROJECT_POLICY.owner}.`,
      };
};

export const validatePullRequestPolicy = (sourceBranch, targetBranch, title) => {
  if (!isProtectedBranch(targetBranch)) {
    return {
      valid: false,
      reason: `Pull requests may only target ${PROJECT_POLICY.primaryBranch} or ${SUPPORT_PREFIX}/<major>.x.`,
    };
  }

  if (isProtectedBranch(sourceBranch)) {
    return {
      valid: false,
      reason:
        "Protected branches cannot be merged into each other; use a focused backport or forward-port branch.",
    };
  }

  const branchResult = validateBranchName(sourceBranch);
  if (!branchResult.valid) {
    return branchResult;
  }

  const supportMajor = getSupportMajor(targetBranch);
  if (supportMajor === null || isAutomationBranch(sourceBranch)) {
    return { valid: true, reason: "" };
  }

  const allowedTypes = new Set(PROJECT_POLICY.maintenance.allowedChangeTypes);
  const sourceType = getChangeType(sourceBranch);
  const titleType = getChangeType(title);
  if (!allowedTypes.has(sourceType) || !allowedTypes.has(titleType)) {
    return {
      valid: false,
      reason: `${targetBranch} accepts only ${[...allowedTypes].join(", ")} changes; features and architecture work belong on ${PROJECT_POLICY.primaryBranch}.`,
    };
  }

  return { valid: true, reason: "" };
};

export const validateReleaseLines = (branchName, version, supportBranches) => {
  const problems = [];
  const versionMajor = Number(version.split(".", 1)[0]);
  const supportMajors = supportBranches
    .map((supportBranch) => ({ branch: supportBranch, major: getSupportMajor(supportBranch) }))
    .filter((supportLine) => supportLine.major !== null);
  const uniqueSupportMajors = new Set(supportMajors.map((supportLine) => supportLine.major));

  if (uniqueSupportMajors.size > PROJECT_POLICY.maintenance.maxActiveLines) {
    problems.push(
      `At most ${PROJECT_POLICY.maintenance.maxActiveLines} active support lines are allowed; end-of-life an older line first.`,
    );
  }

  const currentSupportMajor = getSupportMajor(branchName);
  if (currentSupportMajor !== null && currentSupportMajor !== versionMajor) {
    problems.push(
      `${branchName} may only carry ${currentSupportMajor}.x versions; received ${version}.`,
    );
  }

  if (branchName === PROJECT_POLICY.primaryBranch && uniqueSupportMajors.has(versionMajor)) {
    problems.push(
      `${PROJECT_POLICY.primaryBranch} and ${SUPPORT_PREFIX}/${versionMajor}.x cannot own the same major version.`,
    );
  }

  return problems;
};

export const validateReleaseTag = (tagName, version) => {
  const expectedTag = `v${version}`;
  return tagName === expectedTag
    ? { valid: true, reason: "" }
    : { valid: false, reason: `Release tag ${tagName} must match package version ${expectedTag}.` };
};

const readJson = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

const findWorkspacePackages = (repositoryRoot) => {
  const workspaceRoots = ["packages"];
  return workspaceRoots.flatMap((workspaceRoot) => {
    const absoluteRoot = join(repositoryRoot, workspaceRoot);
    return readdirSync(absoluteRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(absoluteRoot, entry.name, "package.json"));
  });
};

export const validateRepositoryVersions = (repositoryRoot) => {
  const rootPackage = readJson(join(repositoryRoot, "package.json"));
  const packageFiles = findWorkspacePackages(repositoryRoot);
  const lockFile = readJson(join(repositoryRoot, "package-lock.json"));
  const problems = [];
  const workspacePackages = packageFiles.map((packageFile) => ({
    file: packageFile,
    metadata: readJson(packageFile),
  }));
  const workspaceVersions = new Map(
    workspacePackages.map(({ metadata }) => [metadata.name, metadata.version]),
  );

  if (!rootPackage.private) {
    problems.push("The repository root must remain private.");
  }
  if (rootPackage.version !== undefined) {
    problems.push("The private repository root must not declare a release version.");
  }

  for (const { file: packageFile, metadata: workspacePackage } of workspacePackages) {
    if (!validateVersion(workspacePackage.version)) {
      problems.push(`Invalid ${workspacePackage.name} version: ${workspacePackage.version}`);
    }

    const workspacePath = relative(repositoryRoot, dirname(packageFile)).replaceAll("\\", "/");
    if (lockFile.packages?.[workspacePath]?.version !== workspacePackage.version) {
      problems.push(`${workspacePackage.name} version is not synchronized in package-lock.json.`);
    }

    const internalDependencies = Object.entries(workspacePackage.dependencies ?? {}).filter(
      ([dependencyName]) => workspaceVersions.has(dependencyName),
    );
    for (const [dependencyName, dependencyVersion] of internalDependencies) {
      const expectedVersion = workspaceVersions.get(dependencyName);
      if (dependencyVersion !== expectedVersion) {
        problems.push(
          `${workspacePackage.name} depends on ${dependencyName}@${dependencyVersion}; expected ${expectedVersion}`,
        );
      }
    }
  }

  const tiduVersion = workspaceVersions.get("@skillnull/tidu");
  const connectorManifests = [
    "packages/tidu/connectors/codex/ai-tidu9/plugin.json",
    "packages/tidu/connectors/codex/ai-tidu9/.codex-plugin/plugin.json",
  ];
  for (const manifestPath of connectorManifests) {
    const absoluteManifestPath = join(repositoryRoot, manifestPath);
    if (
      existsSync(absoluteManifestPath) &&
      readJson(absoluteManifestPath).version !== tiduVersion
    ) {
      problems.push(`${manifestPath} version must match @skillnull/tidu@${tiduVersion}.`);
    }
  }

  if (lockFile.version !== undefined || lockFile.packages?.[""]?.version !== undefined) {
    problems.push("package-lock.json must not declare a private root release version.");
  }

  return problems;
};

const getBranchName = () => {
  if (process.env.TIDU_BRANCH_NAME) {
    return process.env.TIDU_BRANCH_NAME;
  }

  return execFileSync("git", ["branch", "--show-current"], { encoding: "utf8" }).trim();
};

const getCommitMessage = (argumentsList) => {
  const fileOptionIndex = argumentsList.indexOf("--file");
  if (fileOptionIndex >= 0) {
    const messageFile = argumentsList[fileOptionIndex + 1];
    if (!messageFile) {
      throw new Error("--file requires a commit-message file path.");
    }
    return readFileSync(resolve(messageFile), "utf8");
  }

  return process.env.TIDU_COMMIT_MESSAGE ?? argumentsList.join(" ");
};

const getSupportBranches = () => {
  const refs = execFileSync(
    "git",
    [
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/${SUPPORT_PREFIX}`,
      `refs/remotes/origin/${SUPPORT_PREFIX}`,
    ],
    { encoding: "utf8" },
  );

  return [
    ...new Set(
      refs
        .split(/\r?\n/u)
        .map((branchName) => branchName.replace(/^origin\//u, ""))
        .filter(Boolean),
    ),
  ];
};

const run = () => {
  const [command, ...argumentsList] = process.argv.slice(2);
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  if (command === "branch") {
    const branchName = argumentsList[0] ?? getBranchName();
    if (!branchName) {
      process.stdout.write("Branch policy skipped for detached HEAD.\n");
      return;
    }
    const result = validateBranchName(branchName);
    if (!result.valid) {
      throw new Error(`${result.reason} Received: ${branchName}`);
    }
    process.stdout.write(`Branch policy passed: ${branchName}\n`);
    return;
  }

  if (command === "commit") {
    const commitMessage = getCommitMessage(argumentsList);
    const result = validateCommitMessage(commitMessage);
    if (!result.valid) {
      throw new Error(result.reason);
    }
    process.stdout.write("Commit policy passed.\n");
    return;
  }

  if (command === "owner") {
    const branchName = argumentsList[0] ?? process.env.TIDU_BRANCH_NAME ?? getBranchName();
    const actor = argumentsList[1] ?? process.env.TIDU_ACTOR ?? "";
    const result = validateMainUpdateActor(actor, branchName);
    if (!result.valid) {
      throw new Error(result.reason);
    }
    process.stdout.write(`Owner policy passed: ${actor || "non-protected branch"}\n`);
    return;
  }

  if (command === "pull-request") {
    const sourceBranch = argumentsList[0] ?? process.env.TIDU_HEAD_BRANCH ?? "";
    const targetBranch = argumentsList[1] ?? process.env.TIDU_BASE_BRANCH ?? "";
    const title = argumentsList[2] ?? process.env.TIDU_PR_TITLE ?? "";
    const result = validatePullRequestPolicy(sourceBranch, targetBranch, title);
    if (!result.valid) {
      throw new Error(result.reason);
    }
    process.stdout.write(`Pull-request policy passed: ${sourceBranch} -> ${targetBranch}\n`);
    return;
  }

  if (command === "versions") {
    const problems = validateRepositoryVersions(repositoryRoot);
    if (problems.length > 0) {
      throw new Error(problems.join("\n"));
    }
    process.stdout.write("Version policy passed.\n");
    return;
  }

  if (command === "release-lines") {
    const publishedPackage = readJson(join(repositoryRoot, "packages/tidu/package.json"));
    const branchName = argumentsList[0] ?? process.env.TIDU_RELEASE_LINE ?? getBranchName();
    const problems = validateReleaseLines(
      branchName,
      publishedPackage.version,
      getSupportBranches(),
    );
    if (problems.length > 0) {
      throw new Error(problems.join("\n"));
    }
    process.stdout.write(`Release-line policy passed: ${branchName || "detached HEAD"}\n`);
    return;
  }

  if (command === "tag") {
    const publishedPackage = readJson(join(repositoryRoot, "packages/tidu/package.json"));
    const tagName = argumentsList[0] ?? process.env.TIDU_TAG_NAME ?? "";
    const result = validateReleaseTag(tagName, publishedPackage.version);
    if (!result.valid) {
      throw new Error(result.reason);
    }
    process.stdout.write(`Release-tag policy passed: ${tagName}\n`);
    return;
  }

  throw new Error(
    "Expected one of: branch, commit, owner, pull-request, versions, release-lines, tag.",
  );
};

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined && import.meta.url === pathToFileURL(realpathSync(entryPath)).href;

if (isDirectExecution) {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Project policy validation failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

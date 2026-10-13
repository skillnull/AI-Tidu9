import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RELEASE_CANDIDATE_FILES = Object.freeze({
  chineseReadme: "README.md",
  englishReadme: "docs/README.en.md",
  architectureChinese: "docs/architecture.md",
  architectureEnglish: "docs/architecture.en.md",
  qualification: "docs/release-candidate.md",
});

const PUBLIC_PRIVACY_PATTERNS = Object.freeze([
  {
    name: "macOS home path",
    pattern: /\/Users\/(?!example\/|username\/|<user>\/)[A-Za-z0-9._-]+\//u,
  },
  { name: "Linux home path", pattern: /\/home\/(?!example\/|user\/|username\/)[A-Za-z0-9._-]+\//u },
  { name: "private key", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u },
  { name: "npm access token", pattern: /npm_[A-Za-z0-9]{30,}/u },
  { name: "GitHub access token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/u },
  { name: "OpenAI-style access token", pattern: /sk-[A-Za-z0-9]{32,}/u },
]);

const FORBIDDEN_PACKAGE_PATHS = Object.freeze([
  /(?:^|\/)\.env(?:\.|$)/u,
  /(?:^|\/)\.git(?:\/|$)/u,
  /(?:^|\/)[^/]*\.test\.[^/]+$/u,
  /(?:^|\/)(?:id_rsa|id_ed25519|[^/]*\.pem|[^/]*\.key)$/u,
]);

const readPublicFiles = (repositoryRoot) =>
  execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);

export const scanPublicRepository = (
  repositoryRoot,
  filePaths = readPublicFiles(repositoryRoot),
) => {
  const findings = [];
  for (const filePath of filePaths) {
    const absolutePath = resolve(repositoryRoot, filePath);
    let content;
    try {
      content = readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) {
      continue;
    }
    for (const privacyPattern of PUBLIC_PRIVACY_PATTERNS) {
      if (privacyPattern.pattern.test(content)) {
        findings.push(`${filePath}: ${privacyPattern.name}`);
      }
    }
  }
  return findings;
};

export const validatePackedFiles = (filePaths) =>
  filePaths.flatMap((filePath) =>
    FORBIDDEN_PACKAGE_PATHS.some((pattern) => pattern.test(filePath))
      ? [`Forbidden npm package path: ${filePath}`]
      : [],
  );

export const validateReleaseCandidateDocuments = (repositoryRoot) => {
  const problems = [];
  const documents = Object.fromEntries(
    Object.entries(RELEASE_CANDIDATE_FILES).map(([name, filePath]) => [
      name,
      readFileSync(join(repositoryRoot, filePath), "utf8"),
    ]),
  );
  const expectations = [
    ["chineseReadme", "集成发布候选"],
    ["englishReadme", "Integrated release candidate"],
    ["architectureChinese", "客户端兼容矩阵"],
    ["architectureEnglish", "Client compatibility matrix"],
    ["qualification", "升级与回滚"],
    ["qualification", "Upgrade and rollback"],
    ["qualification", "安全与隐私"],
    ["qualification", "Security and privacy"],
    ["qualification", "迁移说明"],
    ["qualification", "Migration notes"],
  ];
  for (const [documentName, expectedText] of expectations) {
    if (!documents[documentName]?.includes(expectedText)) {
      problems.push(`${RELEASE_CANDIDATE_FILES[documentName]} is missing: ${expectedText}`);
    }
  }
  return problems;
};

const readPackFiles = (repositoryRoot) => {
  const output = execFileSync(
    "npm",
    ["pack", "--workspace", "@skillnull/tidu", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const packResult = JSON.parse(output);
  return (packResult[0]?.files ?? []).map((file) => file.path);
};

export const verifyReleaseCandidate = (repositoryRoot) => {
  execFileSync("npm", ["run", "check"], { cwd: repositoryRoot, stdio: "inherit" });
  const findings = [
    ...scanPublicRepository(repositoryRoot),
    ...validatePackedFiles(readPackFiles(repositoryRoot)),
    ...validateReleaseCandidateDocuments(repositoryRoot),
  ];
  if (findings.length > 0) {
    throw new Error(`Release-candidate verification failed:\n${findings.join("\n")}`);
  }
  return {
    publicFileCount: readPublicFiles(repositoryRoot).length,
    packageFileCount: readPackFiles(repositoryRoot).length,
  };
};

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href;

if (isDirectExecution) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const result = verifyReleaseCandidate(repositoryRoot);
    process.stdout.write(
      `\u001B[32m✓ RELEASE CANDIDATE VERIFIED\u001B[0m\n${result.publicFileCount} tracked files scanned; ${result.packageFileCount} npm files verified.\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown verification error";
    process.stderr.write(`\u001B[31m✖ RELEASE CANDIDATE BLOCKED\u001B[0m\n${message}\n`);
    process.exitCode = 1;
  }
}

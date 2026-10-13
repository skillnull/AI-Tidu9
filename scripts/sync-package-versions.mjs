import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { updateJsonVersion } from "./publish-tidu.mjs";

const VERSION_METADATA = Object.freeze({
  packagePath: "packages/tidu/package.json",
  manifestPaths: [
    "packages/tidu/connectors/codex/ai-tidu9/plugin.json",
    "packages/tidu/connectors/codex/ai-tidu9/.codex-plugin/plugin.json",
  ],
});

const runGit = (repositoryRoot, argumentsList, input) =>
  execFileSync("git", argumentsList, {
    cwd: repositoryRoot,
    encoding: "utf8",
    input,
  });

const readIndexFile = (repositoryRoot, filePath) =>
  runGit(repositoryRoot, ["show", `:${filePath}`]);

const replaceIndexFile = (repositoryRoot, filePath, content) => {
  const indexEntry = runGit(repositoryRoot, ["ls-files", "--stage", "--", filePath]).trim();
  const fileMode = indexEntry.split(/\s/u, 1)[0];
  if (!/^100[67][45]{2}$/u.test(fileMode)) {
    throw new Error(`Cannot synchronize untracked release metadata: ${filePath}`);
  }
  const blobId = runGit(repositoryRoot, ["hash-object", "-w", "--stdin"], content).trim();
  runGit(repositoryRoot, ["update-index", "--cacheinfo", `${fileMode},${blobId},${filePath}`]);
};

export const synchronizeStagedPackageVersions = (repositoryRoot) => {
  const stagedPackage = JSON.parse(readIndexFile(repositoryRoot, VERSION_METADATA.packagePath));
  const packageVersion = stagedPackage.version;
  if (typeof packageVersion !== "string") {
    throw new Error(`${VERSION_METADATA.packagePath} must contain a string version.`);
  }

  const synchronizedPaths = [];
  for (const manifestPath of VERSION_METADATA.manifestPaths) {
    const absoluteManifestPath = resolve(repositoryRoot, manifestPath);
    const indexContent = readIndexFile(repositoryRoot, manifestPath);
    const synchronizedIndexContent = updateJsonVersion(indexContent, packageVersion);
    if (synchronizedIndexContent === indexContent) {
      continue;
    }

    const worktreeContent = readFileSync(absoluteManifestPath, "utf8");
    replaceIndexFile(repositoryRoot, manifestPath, synchronizedIndexContent);
    writeFileSync(
      absoluteManifestPath,
      worktreeContent === indexContent
        ? synchronizedIndexContent
        : updateJsonVersion(worktreeContent, packageVersion),
    );
    synchronizedPaths.push(manifestPath);
  }
  return { packageVersion, synchronizedPaths };
};

const entryPath = process.argv[1];
const isDirectExecution =
  entryPath !== undefined && import.meta.url === pathToFileURL(realpathSync(entryPath)).href;

if (isDirectExecution) {
  try {
    const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const result = synchronizeStagedPackageVersions(repositoryRoot);
    process.stdout.write(
      result.synchronizedPaths.length === 0
        ? `✔ Version metadata already matches @skillnull/tidu@${result.packageVersion}.\n`
        : `✔ Version metadata synchronized to @skillnull/tidu@${result.packageVersion}:\n${result.synchronizedPaths.map((filePath) => `  ${filePath}`).join("\n")}\n`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Version metadata synchronization failed.";
    process.stderr.write(`✖ VERSION SYNC FAILED\n${message}\n`);
    process.exitCode = 1;
  }
}

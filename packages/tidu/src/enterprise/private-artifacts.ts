import { constants as fileConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { EnterprisePrivateArtifactStore } from "./index.js";

const MAXIMUM_PRIVATE_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

const assertSafeIdentifier = (value: string, field: string): void => {
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${field} is invalid.`);
  }
};

const assertRealDirectory = async (directoryPath: string): Promise<void> => {
  const status = await lstat(directoryPath);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error("Private artifact directory must be a real directory.");
  }
};

const ensureRealDirectory = async (directoryPath: string): Promise<void> => {
  try {
    await mkdir(directoryPath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertRealDirectory(directoryPath);
};

export const createPrivateFileArtifactStore = (
  rootDirectory: string,
): EnterprisePrivateArtifactStore => {
  const privateRoot = resolve(rootDirectory);
  const resolveArtifactPath = (scopeId: string, artifactId: string): string => {
    assertSafeIdentifier(scopeId, "Artifact scope");
    assertSafeIdentifier(artifactId, "Artifact identifier");
    return resolve(privateRoot, scopeId, artifactId);
  };
  const resolveVerifiedPaths = async (
    scopeId: string,
    artifactId: string,
    createDirectories: boolean,
  ): Promise<{ artifactPath: string; scopeDirectory: string }> => {
    const artifactPath = resolveArtifactPath(scopeId, artifactId);
    const scopeDirectory = dirname(artifactPath);
    if (createDirectories) {
      await ensureRealDirectory(privateRoot);
      await ensureRealDirectory(scopeDirectory);
    } else {
      await assertRealDirectory(privateRoot);
      await assertRealDirectory(scopeDirectory);
    }
    const [rootRealPath, scopeRealPath] = await Promise.all([
      realpath(privateRoot),
      realpath(scopeDirectory),
    ]);
    if (dirname(scopeRealPath) !== rootRealPath) {
      throw new Error("Private artifact scope escapes the configured root.");
    }
    return { artifactPath, scopeDirectory };
  };
  const assertWritableArtifact = async (artifactPath: string): Promise<void> => {
    try {
      const status = await lstat(artifactPath);
      if (!status.isFile() || status.isSymbolicLink()) {
        throw new Error("Private artifact must be a regular file.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  const noFollowFlag = process.platform === "win32" ? 0 : fileConstants.O_NOFOLLOW;

  return {
    put: async (scopeId, artifactId, content) => {
      if (content.byteLength > MAXIMUM_PRIVATE_ARTIFACT_BYTES) {
        throw new Error(`Private artifact exceeds ${MAXIMUM_PRIVATE_ARTIFACT_BYTES} bytes.`);
      }
      const { artifactPath } = await resolveVerifiedPaths(scopeId, artifactId, true);
      await assertWritableArtifact(artifactPath);
      const file = await open(
        artifactPath,
        fileConstants.O_WRONLY | fileConstants.O_CREAT | fileConstants.O_TRUNC | noFollowFlag,
        0o600,
      );
      try {
        await writeFile(file, content);
        if (process.platform === "win32") await chmod(artifactPath, 0o600);
        else await file.chmod(0o600);
      } finally {
        await file.close();
      }
    },
    get: async (scopeId, artifactId) => {
      try {
        const { artifactPath } = await resolveVerifiedPaths(scopeId, artifactId, false);
        const file = await open(artifactPath, fileConstants.O_RDONLY | noFollowFlag);
        try {
          return await readFile(file);
        } finally {
          await file.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    delete: async (scopeId, artifactId) => {
      try {
        const { artifactPath } = await resolveVerifiedPaths(scopeId, artifactId, false);
        const status = await lstat(artifactPath);
        if (!status.isFile() || status.isSymbolicLink()) {
          throw new Error("Private artifact must be a regular file.");
        }
        await rm(artifactPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },
  };
};

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { EnterprisePrivateArtifactStore } from "./index.js";

const MAXIMUM_PRIVATE_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

const assertSafeIdentifier = (value: string, field: string): void => {
  if (!SAFE_IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${field} is invalid.`);
  }
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

  return {
    put: async (scopeId, artifactId, content) => {
      if (content.byteLength > MAXIMUM_PRIVATE_ARTIFACT_BYTES) {
        throw new Error(`Private artifact exceeds ${MAXIMUM_PRIVATE_ARTIFACT_BYTES} bytes.`);
      }
      const scopeDirectory = resolve(privateRoot, scopeId);
      const artifactPath = resolveArtifactPath(scopeId, artifactId);
      await mkdir(scopeDirectory, { recursive: true, mode: 0o700 });
      await writeFile(artifactPath, content, { mode: 0o600 });
      if (process.platform !== "win32") {
        await chmod(artifactPath, 0o600);
      }
    },
    get: async (scopeId, artifactId) => {
      try {
        return await readFile(resolveArtifactPath(scopeId, artifactId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },
    delete: async (scopeId, artifactId) => {
      try {
        await rm(resolveArtifactPath(scopeId, artifactId));
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

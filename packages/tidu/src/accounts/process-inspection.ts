import { spawn } from "node:child_process";

export interface ProcessInspectionResult {
  /** Process exit code, or null when the process failed to start or timed out. */
  status: number | null;
  /** Captured standard output. */
  stdout: string;
  /** Captured standard error. */
  stderr: string;
  /** Stable system error code when the process could not be started. */
  errorCode?: string;
}

export const inspectProcess = (
  command: string,
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMilliseconds: number,
): Promise<ProcessInspectionResult> =>
  new Promise((resolve) => {
    const child = spawn(command, argumentsList, {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: "", stderr: "" };
    let completed = false;
    const finish = (result: ProcessInspectionResult): void => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output.stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      output.stderr += chunk;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish({ status: null, ...output, errorCode: error.code });
    });
    child.once("exit", (status) => finish({ status, ...output }));
    const timeout = setTimeout(() => {
      child.kill();
      finish({ status: null, ...output });
    }, timeoutMilliseconds);
  });

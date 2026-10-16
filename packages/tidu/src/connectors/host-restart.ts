import { spawnSync } from "node:child_process";

export type RestartableHostId = "codex" | "cursor";

export interface HostRestartResult {
  /** Host whose desktop process was inspected. */
  id: RestartableHostId;
  /** Whether the host was running before restart was requested. */
  detected: boolean;
  /** Whether a detected host quit and launched successfully. */
  restarted: boolean;
  /** Privacy-safe restart outcome. */
  detail: string;
}

const MACOS_HOSTS = Object.freeze<Record<RestartableHostId, string>>({
  codex: "Codex",
  cursor: "Cursor",
});

const run = (command: string, argumentsList: readonly string[]): boolean =>
  spawnSync(command, [...argumentsList], {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  }).status === 0;

export const detectRunningHosts = (): readonly RestartableHostId[] => {
  if (process.platform !== "darwin") {
    return [];
  }
  return (Object.entries(MACOS_HOSTS) as Array<[RestartableHostId, string]>)
    .filter(([, applicationName]) => run("pgrep", ["-x", applicationName]))
    .map(([hostId]) => hostId);
};

export const restartDetectedHosts = (
  hostIds: readonly RestartableHostId[],
): readonly HostRestartResult[] =>
  hostIds.map((hostId) => {
    const applicationName = MACOS_HOSTS[hostId];
    if (process.platform !== "darwin") {
      return {
        id: hostId,
        detected: false,
        restarted: false,
        detail: "Automatic desktop restart is currently available on macOS only.",
      };
    }
    const stopped = run("osascript", [
      "-e",
      `tell application ${JSON.stringify(applicationName)} to quit`,
    ]);
    const started = stopped && run("open", ["-a", applicationName]);
    return {
      id: hostId,
      detected: true,
      restarted: started,
      detail: started
        ? `${applicationName} restarted with the AI-Tidu9 setup.`
        : `${applicationName} could not be restarted automatically; restart it manually.`,
    };
  });

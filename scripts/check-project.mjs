import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

// Include actual dependency bytes, not just package versions or modification times.
export const validationFingerprint = (root, environment = process.env) => {
  const hash = createHash("sha256");
  const paths = [
    ...new Set(
      git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .split("\0")
        .filter(Boolean),
    ),
  ]
    .filter((path) => {
      try {
        lstatSync(join(root, path));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    })
    .sort();
  const environmentKeys = [
    "CI",
    "NODE_ENV",
    "NODE_OPTIONS",
    "NODE_PATH",
    "TZ",
    "LANG",
    "LC_ALL",
    "CODEX_HOME",
    ...Object.keys(environment).filter((key) => key.startsWith("TIDU_")),
  ].sort();
  if (
    environment.NODE_OPTIONS ||
    environment.NODE_PATH ||
    environmentKeys.some((key) => /TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|KEY/u.test(key))
  )
    throw new Error("This external runtime profile requires a full validation.");
  // npm injects these paths for every script; they do not distinguish a hook from npm run check.
  const searchPath = [
    ...new Set(
      Object.keys(environment)
        .filter((key) => /^path$/iu.test(key))
        .flatMap((key) => (environment[key] ?? "").split(delimiter))
        .filter(
          (path) =>
            !/(?:\/node_modules\/\.bin|\/@npmcli\/run-script\/lib\/node-gyp-bin)$/u.test(
              path.replaceAll("\\", "/").replace(/\/+$/u, ""),
            ),
        ),
    ),
  ];
  hash.update(
    JSON.stringify([
      1,
      process.version,
      process.execPath,
      process.platform,
      process.arch,
      environmentKeys.map((key) => [key, environment[key] ?? ""]),
      searchPath,
    ]),
  );
  const add = (path, dependency = false) => {
    hash.update(`${relative(root, path)}\0`);
    let status;
    try {
      status = lstatSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("missing\0");
      return;
    }
    const entries =
      dependency && status.isDirectory()
        ? readdirSync(path)
            .filter((entry) => ![".cache", ".vite", ".vite-temp"].includes(entry))
            .sort()
        : undefined;
    // Hoisted workspaces can acquire a cache-only container during their first build.
    if (basename(path) === "node_modules" && entries?.length === 0) {
      hash.update("missing\0");
      return;
    }
    hash.update(`${status.mode & 0o777}\0`);
    if (status.isSymbolicLink()) {
      const target = readlinkSync(path);
      const location = relative(root, resolve(dirname(path), target));
      if (!dependency || location.startsWith("..") || isAbsolute(location))
        throw new Error("Validation reuse does not support external or source symlinks.");
      hash.update(`link:${target}\0`);
    } else if (status.isFile()) {
      hash.update(`${status.size}\0`);
      hash.update(readFileSync(path));
    } else if (entries !== undefined) {
      for (const entry of entries) add(join(path, entry), true);
    } else {
      throw new Error("Validation reuse requires regular repository inputs.");
    }
    hash.update("\0");
  };
  for (const path of paths) add(join(root, path));
  const packageDirectories = new Set([
    root,
    ...paths
      .filter((path) => path.endsWith("/package.json"))
      .map((path) => dirname(join(root, path))),
  ]);
  for (const directory of [...packageDirectories].sort())
    add(join(directory, "node_modules"), true);
  for (const name of ["TIDU_CODEX_PROTOCOL_TEST_COMMAND", "TIDU_CODEX_APP_ASAR"]) {
    const path = environment[name];
    if (path === undefined) continue;
    if (!isAbsolute(path)) throw new Error("External test executables require full validation.");
    if (
      name === "TIDU_CODEX_APP_ASAR"
        ? !path.endsWith(".asar")
        : (lstatSync(path).mode & 0o111) === 0
    )
      throw new Error("External test assets require full validation.");
    add(path);
  }
  return hash.digest("hex");
};

const matchesPush = (root, refs) => {
  if (git(root, ["status", "--porcelain", "--untracked-files=all"]).trim() !== "") return false;
  const tree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  return refs
    .trim()
    .split("\n")
    .every((line) => {
      const fields = line.trim().split(/\s+/u);
      if (fields.length !== 4 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(fields[1])) return false;
      if (/^0+$/u.test(fields[1])) return true;
      try {
        return git(root, ["rev-parse", `${fields[1]}^{tree}`]).trim() === tree;
      } catch {
        return false;
      }
    });
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

const acquire = async (directory, output) => {
  const claimsDirectory = join(directory, "locks");
  mkdirSync(claimsDirectory, { recursive: true });
  const owner = { pid: process.pid, runId: randomUUID(), ticket: 0 };
  const candidate = join(directory, `${owner.runId}.tmp`);
  const claimPath = join(claimsDirectory, `${owner.runId}.json`);
  const publish = () => {
    writeFileSync(candidate, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    renameSync(candidate, claimPath);
  };
  const claims = () =>
    readdirSync(claimsDirectory)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        const path = join(claimsDirectory, name);
        const current = readJson(path);
        if (current === undefined && !existsSync(path)) return [];
        if (
          !Number.isSafeInteger(current?.pid) ||
          current.pid <= 0 ||
          current.runId !== name.slice(0, -5) ||
          !Number.isSafeInteger(current.ticket) ||
          current.ticket < 0
        )
          throw new Error("The local validation lock is invalid.");
        if (!alive(current.pid)) {
          rmSync(path, { force: true });
          return [];
        }
        return [current];
      });
  let waitedFor;
  try {
    // Publish selection before choosing a ticket. Unique paths make stale cleanup race-safe.
    publish();
    owner.ticket = Math.max(0, ...claims().map((current) => current.ticket)) + 1;
    publish();
    while (true) {
      const blocking = claims().find(
        (current) =>
          current.runId !== owner.runId &&
          (current.ticket === 0 ||
            current.ticket < owner.ticket ||
            (current.ticket === owner.ticket && current.runId < owner.runId)),
      );
      if (blocking === undefined) break;
      if (waitedFor === undefined)
        output("[check] Waiting for the running validation to finish.\n");
      waitedFor = blocking.runId;
      await delay(100);
    }
  } catch (error) {
    rmSync(claimPath, { force: true });
    throw error;
  } finally {
    rmSync(candidate, { force: true });
  }
  return {
    /** Identifier of the validation owning the lock. */
    runId: owner.runId,
    /** Last validation observed while waiting; its failures propagate too. */
    waitedFor,
    /** Releases only this invocation's lock. */
    release: () => {
      rmSync(claimPath, { force: true });
    },
  };
};

const executeCommand = (command, args, options) =>
  new Promise((resolveExit) => {
    const child = spawn(command, args, {
      ...options,
      stdio: "inherit",
      // Batch launchers require a shell on Windows; these arguments are fixed check commands.
      shell: process.platform === "win32" && command.endsWith(".cmd"),
    });
    const terminate = () => child.kill("SIGTERM");
    const cancel = () => child.kill("SIGINT");
    process.once("SIGTERM", terminate);
    process.once("SIGINT", cancel);
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolveExit(1);
    });
    child.once("close", (code) => {
      process.off("SIGTERM", terminate);
      process.off("SIGINT", cancel);
      resolveExit(code ?? 1);
    });
  });

/**
 * @param options.repositoryRoot Repository whose existing checks are executed.
 * @param options.prePush Whether fresh ref policies and exact-tree reuse are requested.
 * @param options.refs Git's pending ref updates, never a shell command.
 * @param options.environment Check environment; only public runtime fields enter the digest.
 * @param options.execute Process adapter for isolated runner tests.
 * @param options.output Progress output adapter.
 */
export const runProjectCheck = async ({
  repositoryRoot,
  prePush = false,
  refs = "",
  environment = process.env,
  execute = executeCommand,
  output = (text) => process.stdout.write(text),
}) => {
  if (prePush && refs.trim() === "") return 0;
  const started = performance.now();
  const validationScope = `local Node ${process.version}, ${process.platform}/${process.arch}; remote GitHub Quality not checked`;
  const run = async (label, command, args) => {
    const begin = performance.now();
    const code = await execute(command, args, { cwd: repositoryRoot, env: environment });
    output(
      `[check] ${label}: ${((performance.now() - begin) / 1000).toFixed(2)}s${code === 0 ? "" : " (failed)"}\n`,
    );
    return code;
  };
  const policy = (...args) => [join(repositoryRoot, "scripts", "project-policy.mjs"), ...args];
  if (prePush) {
    for (const name of ["branch", "release-lines"]) {
      const code = await run(name, process.execPath, policy(name));
      if (code !== 0) return code;
    }
  }
  const directory = resolve(
    repositoryRoot,
    git(repositoryRoot, ["rev-parse", "--git-path", "tidu-validation"]).trim(),
  );
  const lock = await acquire(directory, output);
  const releaseOnExit = () => lock.release();
  process.once("exit", releaseOnExit);
  const receiptPath = join(directory, "result.json");
  const fingerprint = () => {
    try {
      return validationFingerprint(repositoryRoot, environment);
    } catch {
      return undefined;
    }
  };
  const record = (result) => {
    const temporary = join(directory, `${lock.runId}.result.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({ ...result, runId: lock.runId }), { mode: 0o600 });
      renameSync(temporary, receiptPath);
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  try {
    const before = fingerprint();
    const prior = readJson(receiptPath);
    const joined = lock.waitedFor !== undefined;
    const eligible = !prePush || matchesPush(repositoryRoot, refs);
    const canReuse =
      before !== undefined &&
      prior?.fingerprint === before &&
      Number.isInteger(prior?.status) &&
      prior.status >= 0 &&
      prior.status <= 255 &&
      ((joined && prior.status !== 0) || (prior.status === 0 && eligible && (joined || prePush)));
    if (canReuse) {
      record(prior);
      const failedStage = ["versions", "lint", "tests"].includes(prior.failedStage)
        ? ` at ${prior.failedStage}`
        : "";
      output(
        `[check] ${prior.status === 0 ? "Reused successful validation" : `Shared validation failed${failedStage}`} (${validationScope}): ${((performance.now() - started) / 1000).toFixed(2)}s\n`,
      );
      return prior.status;
    }
    rmSync(receiptPath, { force: true });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    for (const [label, command, args] of [
      ["versions", process.execPath, policy("versions")],
      ["lint", npm, ["run", "lint"]],
      ["tests", npm, ["test"]],
    ]) {
      const status = await run(label, command, args);
      if (status !== 0) {
        record({ fingerprint: before, status, failedStage: label });
        return status;
      }
    }
    const after = fingerprint();
    const status = before !== after ? 1 : 0;
    record({ fingerprint: after, status });
    output(
      status === 0
        ? `[check] Full validation passed (${validationScope}): ${((performance.now() - started) / 1000).toFixed(2)}s\n`
        : "[check] Inputs changed during validation; a fresh check is required.\n",
    );
    return status;
  } finally {
    process.off("exit", releaseOnExit);
    lock.release();
  }
};

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(realpathSync(entryPath)).href) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const prePush = process.argv.includes("--pre-push");
  try {
    process.exitCode = await runProjectCheck({
      repositoryRoot: root,
      prePush,
      refs: prePush ? readFileSync(0, "utf8") : "",
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

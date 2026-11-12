import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runProjectCheck, validationFingerprint } from "./check-project.mjs";

const fixture = (context) => {
  const root = mkdtempSync(join(tmpdir(), "project-validation-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  git("init", "--initial-branch=main");
  writeFileSync(join(root, ".gitignore"), "node_modules\n");
  writeFileSync(join(root, "package.json"), '{"name":"fixture"}\n');
  writeFileSync(join(root, "source.txt"), "original\n");
  mkdirSync(join(root, "node_modules", "dependency"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dependency", "index.js"), "export default 1;\n");
  const commit = () => {
    git("add", "-A");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-qm",
      "test: update fixture",
    );
  };
  commit();
  const commands = [];
  const messages = [];
  const options = {
    repositoryRoot: root,
    environment: { PATH: process.env.PATH },
    execute: async (_command, args) => {
      commands.push(args.join(" "));
      return 0;
    },
    output: (message) => messages.push(message),
  };
  const refs = (revision = git("rev-parse", "HEAD")) =>
    `refs/heads/main ${revision} refs/heads/main ${"0".repeat(40)}\n`;
  return { root, git, commit, commands, messages, options, refs };
};

test("reuses only an exact successful checkout while refreshing push policies", async (context) => {
  const state = fixture(context);
  writeFileSync(join(state.root, "source.txt"), "changed before verification\n");
  assert.equal(await runProjectCheck(state.options), 0);
  state.commit();
  assert.equal(await runProjectCheck({ ...state.options, prePush: true, refs: state.refs() }), 0);
  assert.equal(state.commands.length, 5);
  assert.match(state.commands[3], /project-policy\.mjs branch$/u);
  assert.match(state.commands[4], /project-policy\.mjs release-lines$/u);
  assert.match(state.messages.join(""), /Reused successful/u);
  const reused = state.messages.at(-1);
  assert.match(reused, /local Node/u);
  assert.ok(reused.includes(process.version));
  assert.ok(reused.includes(`${process.platform}/${process.arch}`));
  assert.match(reused, /remote GitHub Quality not checked/u);
  // A direct check remains a full validation, including in CI.
  assert.equal(await runProjectCheck(state.options), 0);
  assert.equal(state.commands.length, 8);
  assert.match(state.messages.at(-1), /local Node.*remote GitHub Quality not checked/u);
  rmSync(join(state.root, "source.txt"));
  assert.equal(await runProjectCheck(state.options), 0);
  state.commit();
  assert.equal(await runProjectCheck({ ...state.options, prePush: true, refs: state.refs() }), 0);
  assert.equal(state.commands.length, 13);
  assert.equal(
    await runProjectCheck({
      ...state.options,
      prePush: true,
      refs: state.refs(),
      execute: async () => 9,
    }),
    9,
  );
});

for (const target of ["root", "workspace"])
  test(`keeps cache-only dependency containers stable for ${target}`, (context) => {
    const state = fixture(context);
    const packageRoot = target === "root" ? state.root : join(state.root, "packages", "workspace");
    const modules = join(packageRoot, "node_modules");
    if (target === "root") rmSync(modules, { recursive: true, force: true });
    else {
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(join(packageRoot, "package.json"), '{"name":"workspace-fixture"}\n');
      state.commit();
    }
    const original = validationFingerprint(state.root, state.options.environment);
    mkdirSync(modules);
    assert.equal(validationFingerprint(state.root, state.options.environment), original);
    for (const cache of [".cache", ".vite", ".vite-temp"]) {
      mkdirSync(join(modules, cache));
      writeFileSync(join(modules, cache, "generated.js"), "generated cache\n");
      assert.equal(validationFingerprint(state.root, state.options.environment), original);
    }
    const unknown = join(modules, ".unknown-cache");
    mkdirSync(unknown);
    assert.notEqual(validationFingerprint(state.root, state.options.environment), original);
    rmSync(unknown, { recursive: true });
    assert.equal(validationFingerprint(state.root, state.options.environment), original);

    const dependencyDirectory = join(modules, "dependency");
    const dependency = join(dependencyDirectory, "index.js");
    mkdirSync(dependencyDirectory);
    writeFileSync(dependency, "export default 1;\n");
    const installed = validationFingerprint(state.root, state.options.environment);
    assert.notEqual(installed, original);
    writeFileSync(dependency, "export default 2;\n");
    assert.notEqual(validationFingerprint(state.root, state.options.environment), installed);
    writeFileSync(dependency, "export default 1;\n");
    assert.equal(validationFingerprint(state.root, state.options.environment), installed);
    if (process.platform !== "win32") {
      for (const path of [dependencyDirectory, dependency]) {
        const mode = lstatSync(path).mode & 0o777;
        try {
          chmodSync(path, mode ^ 0o020);
          assert.notEqual(validationFingerprint(state.root, state.options.environment), installed);
        } finally {
          chmodSync(path, mode);
        }
        assert.equal(validationFingerprint(state.root, state.options.environment), installed);
      }
    }
    rmSync(dependencyDirectory, { recursive: true });
    assert.equal(validationFingerprint(state.root, state.options.environment), original);
    assert.notEqual(validationFingerprint(state.root, state.options.environment), installed);
  });

test("accepts generated dependency caches while rejecting dependency changes during validation", async (context) => {
  const state = fixture(context);
  const workspace = join(state.root, "packages", "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "package.json"), '{"name":"workspace-fixture"}\n');
  state.commit();
  rmSync(join(state.root, "node_modules"), { recursive: true, force: true });
  assert.equal(
    await runProjectCheck({
      ...state.options,
      execute: async (_command, args) => {
        if (args[0] === "test")
          for (const packageRoot of [state.root, workspace]) {
            const cache = join(packageRoot, "node_modules", ".vite", "deps");
            mkdirSync(cache, { recursive: true });
            writeFileSync(join(cache, "generated.js"), "generated cache\n");
          }
        return 0;
      },
    }),
    0,
  );
  assert.equal(await runProjectCheck({ ...state.options, prePush: true, refs: state.refs() }), 0);
  assert.match(state.messages.at(-1), /Reused successful validation/u);
  const dependency = join(workspace, "node_modules", "dependency.js");
  writeFileSync(dependency, "export default 1;\n");
  assert.equal(
    await runProjectCheck({
      ...state.options,
      execute: async (_command, args) => {
        if (args[0] === "test") writeFileSync(dependency, "export default 2;\n");
        return 0;
      },
    }),
    1,
  );
  const receipt = JSON.parse(
    readFileSync(join(state.root, ".git", "tidu-validation", "result.json"), "utf8"),
  );
  assert.equal(receipt.status, 1);
});

test("invalidates source, untracked inputs, dependency bytes and runtime changes", async (context) => {
  const state = fixture(context);
  const original = validationFingerprint(state.root, state.options.environment);
  const injectedPath = [
    join(state.root, "node_modules", ".bin"),
    join(state.root, "node_modules", "@npmcli", "run-script", "lib", "node-gyp-bin"),
    state.options.environment.PATH,
  ].join(delimiter);
  assert.equal(
    validationFingerprint(state.root, { ...state.options.environment, PATH: injectedPath }),
    original,
  );
  const dependency = join(state.root, "node_modules", "dependency", "index.js");
  writeFileSync(dependency, "export default 2;\n");
  assert.notEqual(validationFingerprint(state.root, state.options.environment), original);
  writeFileSync(dependency, "export default 1;\n");
  writeFileSync(join(state.root, "untracked.txt"), "new input");
  assert.notEqual(validationFingerprint(state.root, state.options.environment), original);
  rmSync(join(state.root, "untracked.txt"));
  assert.notEqual(
    validationFingerprint(state.root, {
      ...state.options.environment,
      TIDU_TEST_PROFILE: "different",
    }),
    original,
  );
  assert.equal(await runProjectCheck(state.options), 0);
  writeFileSync(join(state.root, "source.txt"), "changed\n");
  state.commit();
  assert.equal(await runProjectCheck({ ...state.options, prePush: true, refs: state.refs() }), 0);
  assert.equal(state.commands.length, 8);
});

test("does not reuse dirty checkouts, different pushed trees, corrupt receipts or failures", async (context) => {
  const state = fixture(context);
  const earlier = state.git("rev-parse", "HEAD");
  writeFileSync(join(state.root, "source.txt"), "new revision\n");
  state.commit();
  assert.equal(await runProjectCheck(state.options), 0);
  assert.equal(
    await runProjectCheck({ ...state.options, prePush: true, refs: state.refs(earlier) }),
    0,
  );
  assert.equal(state.commands.length, 8);
  writeFileSync(join(state.root, ".git", "tidu-validation", "result.json"), "invalid");
  assert.equal(await runProjectCheck({ ...state.options, prePush: true, refs: state.refs() }), 0);
  assert.equal(state.commands.length, 13);
  writeFileSync(join(state.root, "untracked.txt"), "dirty");
  assert.equal(await runProjectCheck({ ...state.options, prePush: true, refs: state.refs() }), 0);
  assert.equal(state.commands.length, 18);
  assert.equal(await runProjectCheck({ ...state.options, execute: async () => 7 }), 7);
  assert.equal(await runProjectCheck({ ...state.options, prePush: true, refs: state.refs() }), 0);
  assert.equal(state.commands.length, 23);
});

test("coalesces concurrent full checks and propagates their failures", async (context) => {
  for (const expected of [0, 7]) {
    const state = fixture(context);
    let release;
    let entered;
    let waiting;
    const running = new Promise((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const joined = new Promise((resolve) => {
      waiting = resolve;
    });
    let calls = 0;
    const first = runProjectCheck({
      ...state.options,
      execute: async () => {
        calls += 1;
        if (calls === 1) {
          entered();
          await blocked;
        }
        return expected;
      },
    });
    await running;
    const second = runProjectCheck({
      ...state.options,
      execute: async () => {
        throw new Error("Duplicate validation executed.");
      },
      output: (message) => {
        if (message.includes("Waiting")) waiting();
      },
    });
    await joined;
    release();
    assert.deepEqual(await Promise.all([first, second]), [expected, expected]);
    assert.equal(calls, expected === 0 ? 3 : 1);
    assert.deepEqual(readdirSync(join(state.root, ".git", "tidu-validation", "locks")), []);
  }
});

test("rejects changed-during-check evidence and removes abandoned locks", async (context) => {
  const state = fixture(context);
  const directory = join(state.root, ".git", "tidu-validation");
  mkdirSync(join(directory, "locks"), { recursive: true });
  writeFileSync(
    join(directory, "locks", "abandoned.json"),
    JSON.stringify({ pid: 2147483647, runId: "abandoned", ticket: 1 }),
  );
  assert.equal(
    await runProjectCheck({
      ...state.options,
      execute: async () => {
        writeFileSync(join(state.root, "source.txt"), "modified while checking\n");
        return 0;
      },
    }),
    1,
  );
  assert.equal(JSON.parse(readFileSync(join(directory, "result.json"), "utf8")).status, 1);
  assert.deepEqual(readdirSync(join(directory, "locks")), []);
  assert.equal(await runProjectCheck({ ...state.options, prePush: true, refs: "" }), 0);
  assert.equal(state.commands.length, 0);
});

test("tracks broken dependency links consistently and falls back for external loaders", async (context) => {
  const state = fixture(context);
  const target = join(state.root, "generated.js");
  symlinkSync("../../generated.js", join(state.root, "node_modules", "dependency", "entry"));
  const original = validationFingerprint(state.root, state.options.environment);
  // Generated files ignored by Git do not become validated source inputs.
  writeFileSync(join(state.root, ".gitignore"), "node_modules\ngenerated.js\n");
  const broken = validationFingerprint(state.root, state.options.environment);
  writeFileSync(target, "generated\n");
  assert.equal(validationFingerprint(state.root, state.options.environment), broken);
  assert.notEqual(broken, original);
  const options = {
    ...state.options,
    environment: { ...state.options.environment, NODE_OPTIONS: "--require=external.js" },
  };
  assert.equal(await runProjectCheck(options), 0);
  assert.equal(await runProjectCheck({ ...options, prePush: true, refs: state.refs() }), 0);
  assert.equal(state.commands.length, 8);
});

test("real concurrent CLI checks execute one suite and a clean push reuses its result", {
  timeout: 30_000,
}, async (context) => {
  const state = fixture(context);
  mkdirSync(join(state.root, "scripts"));
  mkdirSync(join(state.root, ".cache"));
  writeFileSync(join(state.root, ".gitignore"), "node_modules\n.cache\n");
  writeFileSync(
    join(state.root, "scripts", "check-project.mjs"),
    readFileSync(new URL("./check-project.mjs", import.meta.url)),
  );
  writeFileSync(
    join(state.root, "scripts", "project-policy.mjs"),
    "import {appendFileSync} from 'node:fs';appendFileSync('.cache/phases',process.argv[2]+'\\n');\n",
  );
  writeFileSync(
    join(state.root, "phase.mjs"),
    "import {appendFileSync,existsSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';appendFileSync('.cache/phases',process.argv[2]+'\\n');if(process.argv[2]==='tests')while(!existsSync('.cache/release'))await delay(10);\n",
  );
  writeFileSync(
    join(state.root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: {
        lint: "node phase.mjs lint",
        test: "node phase.mjs tests",
      },
    }),
  );
  state.commit();
  const launch = (refs) =>
    new Promise((resolveRun, rejectRun) => {
      const child = spawn(
        process.execPath,
        [
          join(state.root, "scripts", "check-project.mjs"),
          ...(refs === undefined ? [] : ["--pre-push"]),
        ],
        {
          cwd: state.root,
          stdio: ["pipe", "pipe", "pipe"],
          signal: context.signal,
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      child.once("error", rejectRun);
      child.once("close", (status) => resolveRun({ status, output }));
      child.stdin.end(refs ?? "");
    });
  const first = launch();
  const phases = join(state.root, ".cache", "phases");
  while (!existsSync(phases)) await delay(10, undefined, { signal: context.signal });
  const second = launch();
  const claims = join(state.root, ".git", "tidu-validation", "locks");
  while (readdirSync(claims).length < 2) await delay(10, undefined, { signal: context.signal });
  writeFileSync(join(state.root, ".cache", "release"), "ready\n");
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.status, 0, firstResult.output);
  assert.equal(secondResult.status, 0, secondResult.output);
  assert.match(secondResult.output, /Reused successful validation/u);
  assert.deepEqual(readFileSync(phases, "utf8").trim().split("\n"), ["versions", "lint", "tests"]);
  const pushed = await launch(state.refs());
  assert.equal(pushed.status, 0, pushed.output);
  assert.match(pushed.output, /Reused successful validation/u);
  assert.deepEqual(readFileSync(phases, "utf8").trim().split("\n"), [
    "versions",
    "lint",
    "tests",
    "branch",
    "release-lines",
  ]);
});

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PRODUCT } from "../core/index.js";
import * as catalog from "./codex-model-catalog.js";
import { configureCodexClient, switchCodexClientConfiguration } from "./configuration.js";

const endpoint = "http://127.0.0.1:10001";
const request: typeof fetch = async (input) =>
  new Response(
    JSON.stringify(
      String(input).endsWith("/health")
        ? { product: PRODUCT.name, status: "ok" }
        : String(input).endsWith("/v1/models")
          ? { data: [{ id: "ai-tidu9-config", owned_by: "AI-Tidu9" }] }
          : { codexReasoningEffortSupported: true },
    ),
    { headers: { "content-type": "application/json" } },
  );

const prepare = async () => {
  const directory = mkdtempSync(join(tmpdir(), "native-catalog-write-lock-"));
  await configureCodexClient({ endpoint, codexHomeDirectory: directory, verifyRuntime: false });
  await switchCodexClientConfiguration({
    mode: "ai-tidu9",
    codexHomeDirectory: directory,
    request,
  });

  const path = join(directory, ".ai-tidu9-model-catalog.json");
  const managed = JSON.parse(readFileSync(path, "utf8"));
  managed.models[0].supported_reasoning_levels = [];
  writeFileSync(path, JSON.stringify(managed));
  writeFileSync(
    join(directory, "models_cache.json"),
    JSON.stringify({
      client_version: "0.167.0",
      models: [
        {
          slug: "official-source",
          visibility: "list",
          supported_in_api: true,
          model_messages: { instructions_template: "New matching harness." },
        },
      ],
    }),
  );
  return { directory, path };
};

const createWriter = (directory: string) => {
  const fixture = join(directory, "writer.cjs");
  writeFileSync(
    fixture,
    `const fs=require('node:fs');const home=process.argv[2],action=process.argv[3];
if(action==='paused-refresh'||action==='paused-configure-state'){const write=fs.writeFileSync;let paused=false;const marker=action==='paused-refresh'?'.ai-tidu9-model-catalog.json.':'.ai-tidu9-profile-state.json.';fs.writeFileSync=(path,...args)=>{if(!paused&&String(path).includes(marker)){paused=true;process.send({status:'paused'});while(!fs.existsSync(home+'/release'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}return write(path,...args);};require('node:module').syncBuiltinESMExports();}
(async()=>{const [configuration,catalog,core]=await Promise.all(process.argv.slice(4).map(path=>import(path)));const request=async input=>new Response(JSON.stringify(String(input).endsWith('/health')?{product:core.PRODUCT.name,status:'ok'}:String(input).endsWith('/v1/models')?{data:[{id:'ai-tidu9-config',owned_by:'AI-Tidu9'}]}:{codexReasoningEffortSupported:true}));
if(action==='paused-refresh')catalog.refreshManagedCodexCatalog({codexHomeDirectory:home,hostVersion:'0.167.0'});
else if(action==='configure'||action==='paused-configure-state')await configuration.configureCodexClient({endpoint:'http://127.0.0.1:10002',codexHomeDirectory:home,request});
else if(action==='refresh')await configuration.refreshCodexClientModelCatalog({codexHomeDirectory:home,request});
else if(action==='switch')await configuration.switchCodexClientConfiguration({mode:'official',codexHomeDirectory:home});
else if(action==='rollback')configuration.rollbackCodexClientConfiguration({codexHomeDirectory:home});
else if(action==='probe-lock')catalog.withManagedCodexCatalogLock(home,()=>{});
else if(action==='hold-lock'||action==='race-lock'){if(action==='race-lock'){process.send({status:'ready'});await new Promise(resolve=>process.once('message',resolve));}const lease=catalog.acquireManagedCodexCatalogLock(home);try{process.send({status:'held'});await new Promise(resolve=>process.once('message',resolve));}finally{lease.release();}}
else configuration.removeCodexClientConfiguration({codexHomeDirectory:home});
process.send({status:'completed'});})().catch(error=>process.send({status:'failed',code:error.code,message:error.message})).finally(()=>process.disconnect());`,
  );
  const start = (operation: string) => {
    const child = fork(
      fixture,
      [
        directory,
        operation,
        new URL(`./configuration.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url)
          .href,
        new URL(
          `./codex-model-catalog.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
          import.meta.url,
        ).href,
        new URL(`../core/index.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url)
          .href,
      ],
      {
        execArgv: ["--import", import.meta.resolve("tsx")],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const exited = once(child, "exit");
    const message = Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10_000) }),
      exited.then(([code]) => {
        throw new Error(`Catalog writer exited before replying: ${code}`);
      }),
    ]);
    return { child, message, exited };
  };
  return start;
};

const assertLeaseAvailable = async (directory: string) => {
  const probe = createWriter(directory)("probe-lock");
  assert.deepEqual((await probe.message)[0], { status: "completed" });
  assert.equal((await probe.exited)[0], 0);
};

test("suppresses only the native SQLite startup warning and restores warning delivery after loading", {
  timeout: 15000,
}, async () => {
  for (const failLoading of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "native-catalog-warning-"));
    const fixture = join(directory, "warning.cjs");
    writeFileSync(
      fixture,
      `const Module=require('node:module');const originalLoad=Module._load;const originalWarning=process.emitWarning;const forwarded=[];const recordWarning=(...parameters)=>forwarded.push(parameters);process.emitWarning=recordWarning;
Module._load=function(name,...parameters){if(name==='node:sqlite'){process.emitWarning('SQLite is an experimental feature and might change at any time','ExperimentalWarning');process.emitWarning('Unrelated native warning','ExperimentalWarning','OTHER_WARNING');process.emitWarning('SQLite is an experimental feature and might change at any time','DifferentWarning');if(process.argv[3]==='fail')throw new Error('Fixture load failure.');}return Reflect.apply(originalLoad,this,[name,...parameters]);};
(async()=>{const catalog=await import(process.argv[2]);let lease,result;try{lease=catalog.acquireManagedCodexCatalogLock(process.argv[4]);result='acquired';}catch(error){result=error.code;}finally{lease?.release();}const restored=process.emitWarning===recordWarning;process.emitWarning('Warning after module load','AfterLoadWarning');process.send({result,restored,forwarded});})().finally(()=>{Module._load=originalLoad;process.emitWarning=originalWarning;process.disconnect();});`,
    );
    const child = fork(
      fixture,
      [
        new URL(
          `./codex-model-catalog.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
          import.meta.url,
        ).href,
        failLoading ? "fail" : "success",
        directory,
      ],
      {
        execArgv: import.meta.url.endsWith(".ts") ? ["--import", import.meta.resolve("tsx")] : [],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const exited = once(child, "exit");
    try {
      const [result] = await Promise.race([
        once(child, "message", { signal: AbortSignal.timeout(10_000) }),
        exited.then(() => {
          throw new Error("The warning fixture exited before replying.");
        }),
      ]);
      assert.deepEqual(result, {
        result: failLoading ? "CONFIGURATION_CONFLICT" : "acquired",
        restored: true,
        forwarded: [
          ["Unrelated native warning", "ExperimentalWarning", "OTHER_WARNING"],
          ["SQLite is an experimental feature and might change at any time", "DifferentWarning"],
          ["Warning after module load", "AfterLoadWarning"],
        ],
      });
      assert.equal((await exited)[0], 0);
    } finally {
      child.kill("SIGKILL");
      await exited;
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("keeps a configure catalog and its next state in one cross-process generation", {
  timeout: 15000,
}, async () => {
  const { directory, path } = await prepare();
  await switchCodexClientConfiguration({ mode: "official", codexHomeDirectory: directory });
  const release = join(directory, "release");
  const writer = createWriter(directory)("paused-configure-state");
  try {
    assert.deepEqual((await writer.message)[0], { status: "paused" });
    assert.ok(
      JSON.parse(readFileSync(path, "utf8")).models[0].supported_reasoning_levels.length > 0,
    );
    const before = readFileSync(path, "utf8");
    assert.deepEqual(
      catalog.refreshManagedCodexCatalog({
        codexHomeDirectory: directory,
        hostVersion: "0.167.0",
      }),
      { changed: false, fingerprint: null },
    );
    assert.equal(readFileSync(path, "utf8"), before);
    writeFileSync(release, "release");
    assert.equal((await writer.exited)[0], 0);
    assert.equal(
      JSON.parse(readFileSync(join(directory, ".ai-tidu9-profile-state.json"), "utf8")).endpoint,
      "http://127.0.0.1:10002",
    );
    catalog.refreshManagedCodexCatalog({ codexHomeDirectory: directory, hostVersion: "0.167.0" });
    assert.ok(
      JSON.parse(readFileSync(path, "utf8")).models[0].supported_reasoning_levels.length > 0,
    );
    await assertLeaseAvailable(directory);
  } finally {
    writeFileSync(release, "release");
    writer.child.kill("SIGKILL");
    await writer.exited;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("allows reentrant same-process commits and releases every lease after errors", async () => {
  const { directory } = await prepare();
  const lockPath = join(directory, ".ai-tidu9-catalog-lock");
  const outer = catalog.acquireManagedCodexCatalogLock(directory);
  try {
    const inner = catalog.acquireManagedCodexCatalogLock(directory);
    inner.release();
    inner.release();
    assert.equal(existsSync(lockPath), true);
    assert.throws(
      () =>
        catalog.withManagedCodexCatalogLock(directory, () => {
          throw new Error("fixture");
        }),
      /fixture/u,
    );
    assert.equal(existsSync(lockPath), true);
    assert.equal(
      catalog.refreshManagedCodexCatalog({
        codexHomeDirectory: directory,
        hostVersion: "0.167.0",
      }).changed,
      true,
    );
  } finally {
    outer.release();
    try {
      await assertLeaseAvailable(directory);
      assert.equal(existsSync(join(lockPath, "lease.sqlite")), true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("never holds the catalog lease during pre-write or post-write network validation", async () => {
  const { directory } = await prepare();
  let networkCalls = 0;
  try {
    await configureCodexClient({
      endpoint,
      codexHomeDirectory: directory,
      request: async (input, init) => {
        networkCalls += 1;
        await assertLeaseAvailable(directory);
        assert.notEqual(
          catalog.refreshManagedCodexCatalog({
            codexHomeDirectory: directory,
            hostVersion: "0.167.0",
          }).fingerprint,
          null,
        );
        return request(input, init);
      },
    });
    assert.equal(networkCalls, 6);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not create a missing refresh home or lock directory for unowned artifacts", async () => {
  const { directory } = await prepare();
  try {
    const lockPath = join(directory, ".ai-tidu9-catalog-lock", "lease.sqlite");
    const originalLock = lstatSync(lockPath);
    const missing = join(directory, "missing");
    assert.deepEqual(
      catalog.refreshManagedCodexCatalog({ codexHomeDirectory: missing, hostVersion: "0.167.0" }),
      { changed: false, fingerprint: null },
    );
    assert.equal(existsSync(missing), false);
    writeFileSync(
      join(directory, ".ai-tidu9-profile-state.json"),
      JSON.stringify({ owner: "unrelated" }),
    );
    assert.deepEqual(
      catalog.refreshManagedCodexCatalog({
        codexHomeDirectory: directory,
        hostVersion: "0.167.0",
      }),
      { changed: false, fingerprint: null },
    );
    const unchangedLock = lstatSync(lockPath);
    assert.equal(unchangedLock.ino, originalLock.ino);
    assert.equal(unchangedLock.mtimeMs, originalLock.mtimeMs);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const action of ["configure", "refresh", "switch", "rollback", "remove"])
  test(`serializes a catalog refresh commit with cross-process ${action}`, {
    timeout: 15000,
  }, async () => {
    const { directory, path } = await prepare();
    const release = join(directory, "release");
    const start = createWriter(directory);
    const first = start("paused-refresh");
    let second: ReturnType<typeof start> | undefined;
    try {
      assert.deepEqual((await first.message)[0], { status: "paused" });
      const before = readFileSync(path, "utf8");
      assert.deepEqual(
        catalog.refreshManagedCodexCatalog({
          codexHomeDirectory: directory,
          hostVersion: "0.167.0",
        }),
        { changed: false, fingerprint: null },
      );
      second = start(action);
      const result = (await second.message)[0] as {
        status: string;
        code?: string;
        message?: string;
      };
      assert.equal(result.status, "failed");
      assert.equal(result.code, "CONFIGURATION_CONFLICT");
      assert.match(result.message ?? "", /catalog|configuration.*updated/iu);
      assert.doesNotMatch(result.message ?? "", /Stop the running personal runtime/iu);
      assert.equal(readFileSync(path, "utf8"), before);
      writeFileSync(release, "release");
      assert.equal((await first.exited)[0], 0);
      assert.equal((await second.exited)[0], 0);
      await configureCodexClient({ endpoint, codexHomeDirectory: directory, request });
      const final = JSON.parse(readFileSync(path, "utf8")).models[0];
      assert.ok(final.supported_reasoning_levels.length > 0);
      assert.equal(final.model_messages.instructions_template, "New matching harness.");
      await assertLeaseAvailable(directory);
    } finally {
      writeFileSync(release, "release");
      first.child.kill("SIGKILL");
      second?.child.kill("SIGKILL");
      await first.exited;
      await second?.exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });

for (const crashedOwner of [false, true])
  for (const contenders of [2, 4])
    test(`grants one catalog lease among ${contenders} contenders ${crashedOwner ? "after owner crash" : "without an owner"}`, {
      timeout: 15000,
    }, async () => {
      const { directory } = await prepare();
      const start = createWriter(directory);
      const databasePath = join(directory, ".ai-tidu9-catalog-lock", "lease.sqlite");
      const databaseIdentity = lstatSync(databasePath).ino;
      const processes: ReturnType<typeof start>[] = [];
      try {
        for (let iteration = 0; iteration < 3; iteration += 1) {
          if (crashedOwner) {
            const owner = start("hold-lock");
            processes.push(owner);
            assert.deepEqual((await owner.message)[0], { status: "held" });
            owner.child.kill("SIGKILL");
            assert.equal((await owner.exited)[1], "SIGKILL");
          }
          const racers = Array.from({ length: contenders }, () => start("race-lock"));
          processes.push(...racers);
          for (const racer of racers)
            assert.deepEqual((await racer.message)[0], { status: "ready" });
          const outcomes = racers.map((racer) =>
            once(racer.child, "message", { signal: AbortSignal.timeout(10_000) }),
          );
          for (const racer of racers) racer.child.send("start");
          const results = (await Promise.all(outcomes)).map(
            ([result]) => result as { status: string; code?: string },
          );
          assert.equal(results.filter((result) => result.status === "held").length, 1);
          for (const result of results.filter((result) => result.status !== "held")) {
            assert.equal(result.status, "failed");
            assert.equal(result.code, "CONFIGURATION_CONFLICT");
          }
          assert.throws(() => catalog.acquireManagedCodexCatalogLock(directory), {
            code: "CONFIGURATION_CONFLICT",
          });
          racers.forEach((racer, index) => {
            if (results[index]?.status === "held") racer.child.send("release");
          });
          for (const racer of racers) assert.equal((await racer.exited)[0], 0);
          await assertLeaseAvailable(directory);
          assert.equal(lstatSync(databasePath).ino, databaseIdentity);
          if (process.platform !== "win32")
            assert.equal(lstatSync(databasePath).mode & 0o777, 0o600);
        }
      } finally {
        for (const { child } of processes) child.kill("SIGKILL");
        await Promise.all(processes.map(({ exited }) => exited));
        rmSync(directory, { recursive: true, force: true });
      }
    });

test("rejects symbolic-link catalog lock storage without modifying its target", {
  skip: process.platform === "win32",
}, () => {
  const directory = mkdtempSync(join(tmpdir(), "native-catalog-lock-safety-"));
  const outside = join(directory, "unrelated");
  writeFileSync(outside, "Unrelated content.");
  try {
    for (const linkedDirectory of [false, true]) {
      const home = join(directory, linkedDirectory ? "directory-link" : "file-link");
      const lockDirectory = join(home, ".ai-tidu9-catalog-lock");
      mkdirSync(home);
      if (linkedDirectory) symlinkSync(directory, lockDirectory, "dir");
      else {
        mkdirSync(lockDirectory);
        symlinkSync(outside, join(lockDirectory, "lease.sqlite"));
      }
      assert.throws(() => catalog.acquireManagedCodexCatalogLock(home), {
        code: "CONFIGURATION_CONFLICT",
        message: /Unsafe Codex catalog configuration lock/u,
      });
      assert.equal(readFileSync(outside, "utf8"), "Unrelated content.");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PRODUCT } from "../core/index.js";
import { configureCodexClient, switchCodexClientConfiguration } from "./configuration.js";
import * as catalog from "./codex-model-catalog.js";

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
      assert.equal(existsSync(join(directory, ".ai-tidu9-catalog-lock")), false);
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
      assert.equal(existsSync(lockPath), false);
      rmSync(directory, { recursive: true, force: true });
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
          assert.equal(existsSync(join(directory, ".ai-tidu9-catalog-lock")), false);
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
      assert.equal(existsSync(join(directory, ".ai-tidu9-catalog-lock")), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
    return { child, message: once(child, "message"), exited: once(child, "exit") };
  };
  return start;
};

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
      assert.equal(existsSync(join(directory, ".ai-tidu9-catalog-lock")), false);
    } finally {
      writeFileSync(release, "release");
      first.child.kill("SIGKILL");
      second?.child.kill("SIGKILL");
      await first.exited;
      await second?.exited;
      rmSync(directory, { recursive: true, force: true });
    }
  });

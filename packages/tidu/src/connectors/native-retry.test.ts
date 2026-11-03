import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { configureCodexClient } from "../clients/configuration.js";
import { createCodexHostModelProvider } from "../providers/codex-host.js";
import { startLocalRuntime } from "../runtime/index.js";
import { createStdioJsonRpcClient } from "./json-rpc.js";

// Exercise the installed retry component without accessing application state or modifying its bundle.
const nativeRetryControls = async (onRetry: () => Promise<unknown>) => {
  const archive = await readFile(process.env.TIDU_CODEX_APP_ASAR ?? "");
  const header = JSON.parse(archive.subarray(16, 16 + archive.readUInt32LE(12)).toString());
  const assets = header.files.webview.files.assets.files;
  const name = Object.keys(assets).find(
    (name) => name.startsWith("system-error-content-") && name.endsWith(".js"),
  );
  assert.ok(name);
  const entry = assets[name];
  const offset = 8 + archive.readUInt32LE(4) + Number(entry.offset);
  const source = archive.subarray(offset, offset + entry.size).toString();
  assert.match(source, /\$=\[10,30,120,300\]/u);
  const components =
    source.slice(source.indexOf("function pt("), source.indexOf("var mt,q;")) +
    source.slice(source.indexOf("function xt("), source.indexOf("function St("));
  const state = {
    now: 0,
    hooks: [] as unknown[],
    cursor: 0,
    locked: false,
    manual: undefined as (() => void) | undefined,
    tick: undefined as (() => void) | undefined,
    pending: Promise.resolve() as Promise<unknown>,
    triggers: [] as string[],
  };
  const memo = { c: (size: number) => Array(size).fill(Symbol.for("react.memo_cache_sentinel")) };
  const context = {
    mt: memo,
    Y: memo,
    q: jsxRuntime,
    Z: jsxRuntime,
    t: {
      span: (props: { className?: string; children?: React.ReactNode; "aria-hidden"?: boolean }) =>
        React.createElement(
          "span",
          { className: props.className, "aria-hidden": props["aria-hidden"] },
          props.children,
        ),
    },
    _: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => {
      state.manual = props.onClick as (() => void) | undefined;
      return React.createElement("button", { ...props, type: "button" });
    },
    E: (props: { defaultMessage: string; values?: { seconds: number } }) =>
      props.defaultMessage.replace("{seconds}", String(props.values?.seconds ?? "")),
    Date: { now: () => state.now },
    C: () => ({ get: () => "ready" }),
    b: {},
    x: (selector: string) => (selector === "owner" ? { role: "owner" } : true),
    xe: "enabled",
    Ve: "owner",
    k: "status",
    Ye: () => ({ activeMode: {} }),
    X: {
      useState: (initial: unknown) => {
        const index = state.cursor++;
        if (!(index in state.hooks))
          state.hooks[index] = typeof initial === "function" ? initial() : initial;
        return [
          state.hooks[index],
          (value: unknown) => {
            state.hooks[index] = value;
          },
        ];
      },
    },
    et: () => {
      if (state.locked) return false;
      state.locked = true;
      return true;
    },
    Ze: (_store: unknown, _host: unknown, _thread: unknown, params: { turnTrigger: string }) => {
      state.triggers.push(params.turnTrigger);
      state.pending = onRetry();
      return state.pending;
    },
    $e: () => {
      state.locked = false;
    },
    ye: (callback: () => void, interval: number | null) => {
      state.tick = interval === null ? undefined : callback;
    },
    component: undefined as
      | React.ComponentType<{ conversationId: string; hostId: string; retryDelaySeconds: number }>
      | undefined,
  };
  runInNewContext(`${components};component=xt;`, context);
  assert.ok(context.component);
  const component = context.component;
  return {
    state,
    render: () => {
      state.cursor = 0;
      return renderToStaticMarkup(
        React.createElement(component, {
          conversationId: "fixture",
          hostId: "local",
          retryDelaySeconds: 10,
        }),
      );
    },
  };
};

test("preserves native overload identity and reuses the installed countdown and manual retry", {
  skip: !process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND || !process.env.TIDU_CODEX_APP_ASAR,
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-retry-fixture-"));
  const ready = join(directory, "ready");
  const permanent = join(directory, "permanent");
  const command = join(directory, "worker");
  await writeFile(
    command,
    `#!${process.execPath}
if(process.argv[2]==='login'){console.log('Logged in');process.exit(0)}
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const request=JSON.parse(line);if(request.id===undefined)return;
if(request.method==='initialize')send({id:request.id,result:{}});
else if(request.method==='thread/start')send({id:request.id,result:{thread:{id:'worker'},model:'fixture'}});
else if(request.method==='turn/start'){
send({id:request.id,result:{turn:{id:'worker-turn'}}});
if(!require('node:fs').existsSync(${JSON.stringify(ready)})){const permanent=require('node:fs').existsSync(${JSON.stringify(permanent)});send({method:'turn/completed',params:{threadId:'worker',turn:{id:'worker-turn',status:'failed',error:{message:permanent?'Agent protocol message exceeds the limit.':'Fixture capacity failure',codexErrorInfo:permanent?'other':'serverOverloaded'}}}});}
else{send({method:'item/agentMessage/delta',params:{threadId:'worker',turnId:'worker-turn',itemId:'answer',delta:'Recovered with native retry.'}});send({method:'turn/completed',params:{threadId:'worker',turn:{id:'worker-turn',status:'completed'}}});}
}
else send({id:request.id,result:{}});
});
`,
    { mode: 0o700 },
  );
  const provider = await createCodexHostModelProvider(undefined, {
    command,
    codexHomeDirectory: directory,
  });
  assert.ok(provider);
  const runtime = await startLocalRuntime({
    databasePath: ":memory:",
    port: 0,
    provider,
    discoverHostProvider: false,
  });
  const home = join(directory, "caller");
  await configureCodexClient({
    endpoint: runtime.origin,
    codexHomeDirectory: home,
    verifyRuntime: false,
  });
  await writeFile(join(home, "config.toml"), await readFile(join(home, "ai-tidu9.config.toml")));
  let finish = (_turn: { status: string; error?: { codexErrorInfo?: unknown } }): void => undefined;
  const client = createStdioJsonRpcClient(
    {
      command: process.execPath,
      arguments: [
        "--import",
        import.meta.resolve("tsx"),
        fileURLToPath(
          new URL(
            `./codex-client-cli.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
            import.meta.url,
          ),
        ),
        "app-server",
      ],
      environment: {
        PATH: process.env.PATH,
        CODEX_HOME: home,
        TIDU_CODEX_REAL_COMMAND: process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
      },
      workingDirectory: directory,
    },
    {
      onNotification: (event) => {
        if (event.method === "turn/completed")
          finish(
            (event.params as { turn: { status: string; error?: { codexErrorInfo?: unknown } } })
              .turn,
          );
      },
    },
  );
  try {
    const nonstream = await fetch(`${runtime.origin}/v1/hosts/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ai-tidu9-config",
        input: "Test the same capacity error without streaming.",
      }),
    });
    assert.equal(nonstream.status, 503);
    const nonstreamFailure = (await nonstream.json()) as { error: { code: string; type: string } };
    assert.equal(nonstreamFailure.error.code, "server_is_overloaded");
    assert.equal(nonstreamFailure.error.type, "service_unavailable_error");
    await client.request("initialize", {
      clientInfo: { name: "retry_fixture", version: "1" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    const thread = await client.request<{ thread: { id: string } }>("thread/start", {
      model: "ai-tidu9-config",
      cwd: directory,
      approvalPolicy: "never",
      sandbox: "read-only",
    });
    const turn = async (input: { type: string; text: string }[]) => {
      const completion = new Promise<{ status: string; error?: { codexErrorInfo?: unknown } }>(
        (resolve) => {
          finish = resolve;
        },
      );
      await client.request("turn/start", { threadId: thread.thread.id, input });
      return completion;
    };
    for (const mode of ["manual", "automatic"]) {
      await rm(ready, { force: true });
      const failure = await turn([{ type: "text", text: "Test the native capacity retry." }]);
      assert.equal(failure.status, "failed");
      assert.equal(failure.error?.codexErrorInfo, "serverOverloaded");
      await writeFile(ready, "ready");
      const controls = await nativeRetryControls(() => turn([]));
      assert.match(controls.render(), /<button[^>]*>.*Retry in 10s/u);
      if (mode === "manual") {
        controls.state.manual?.();
        controls.state.manual?.();
      } else {
        controls.state.now = 5_000;
        controls.state.tick?.();
        assert.match(controls.render(), /Retry in 5s/u);
        controls.state.now = 10_000;
        controls.state.tick?.();
      }
      const recovered = (await controls.state.pending) as { status: string };
      assert.equal(recovered.status, "completed");
      assert.deepEqual(controls.state.triggers, [`capacity_retry_${mode}`]);
    }
    await rm(ready, { force: true });
    await writeFile(permanent, "permanent");
    const permanentFailure = await turn([{ type: "text", text: "Check a configuration failure." }]);
    assert.equal(permanentFailure.status, "failed");
    assert.notEqual(permanentFailure.error?.codexErrorInfo, "serverOverloaded");
  } finally {
    await client.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

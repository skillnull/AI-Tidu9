import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCodexThreadLinks } from "./codex-thread-links.js";

test("persists official continuations without changing message contents or visible chat identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-chat-links-"));
  try {
    const links = createCodexThreadLinks(directory);
    links.record("original", "managed");
    links.record("original", "official-again");
    const reopened = createCodexThreadLinks(directory);
    assert.equal(reopened.current("original"), "official-again");
    assert.equal(reopened.logical("managed"), "original");
    const input = [{ type: "text", text: "managed", threadId: "original" }];
    assert.deepEqual(
      reopened.toServer({ method: "turn/start", params: { threadId: "original", input } }),
      {
        method: "turn/start",
        params: { threadId: "official-again", input },
      },
    );
    assert.deepEqual(
      reopened.toClient({
        method: "turn/completed",
        params: { threadId: "official-again", turn: { id: "turn", items: input } },
      }),
      {
        method: "turn/completed",
        params: { threadId: "original", turn: { id: "turn", items: input } },
      },
    );
    assert.deepEqual(
      reopened.toClient(
        {
          result: {
            data: [
              { id: "original", modelProvider: "openai" },
              { id: "managed", modelProvider: "managed" },
              { id: "official-again", modelProvider: "openai", forkedFromId: "managed" },
              { id: "unrelated", modelProvider: "openai" },
            ],
            nextCursor: "native-cursor",
          },
        },
        "thread/list",
      ),
      {
        result: {
          data: [
            { id: "original", modelProvider: "openai", forkedFromId: null },
            { id: "unrelated", modelProvider: "openai" },
          ],
          nextCursor: "native-cursor",
        },
      },
    );
    assert.deepEqual(
      reopened.toServer({ method: "thread/list", params: { excludedThreadIds: ["original"] } }),
      {
        method: "thread/list",
        params: { excludedThreadIds: ["official-again"] },
      },
    );
    const path = join(directory, ".client-thread-links.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), [
      {
        threadId: "original",
        currentThreadId: "official-again",
        previousThreadIds: ["original", "managed"],
      },
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const surface of ["item", "turn", "thread", "turnsPage", "itemsPage", "itemsRead"]) {
  test(`maps native child-agent typed thread references in ${surface} without changing content`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "native-agent-thread-links-"));
    try {
      const links = createCodexThreadLinks(directory);
      links.record("parent", "parent-physical");
      links.record("child", "child-previous");
      links.record("child", "child-physical");
      const extension = {
        nested: { senderThreadId: "parent-physical", text: "child-physical" },
        sequence: [false, null, 0],
      };
      const items = [
        {
          id: "spawn",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "completed",
          senderThreadId: "parent-physical",
          receiverThreadIds: ["child-physical", "unrelated-child"],
          agentsStates: {
            "child-physical": { status: "running", message: null, futureState: extension },
            "unrelated-child": { status: "pendingInit", message: null },
          },
          prompt: "parent-physical is literal task text",
          future: extension,
        },
        {
          id: "activity",
          type: "subAgentActivity",
          kind: "completed",
          agentThreadId: "child-physical",
          agentPath: "/parent-physical/child-physical",
          future: extension,
        },
        {
          id: "reasoning",
          type: "reasoning",
          summary: ["parent-physical", "child-physical"],
          future: extension,
        },
        {
          id: "commentary",
          type: "agentMessage",
          phase: "commentary",
          text: "parent-physical\n\nchild-physical",
          future: extension,
        },
        {
          id: "tool",
          type: "dynamicToolCall",
          tool: "inspect",
          arguments: {
            senderThreadId: "parent-physical",
            input: "child-physical",
            item: { type: "collabAgentToolCall", senderThreadId: "parent-physical" },
          },
          future: extension,
        },
        {
          id: "future",
          type: "futureNativeItem",
          senderThreadId: "parent-physical",
          agentThreadId: "child-physical",
          future: extension,
        },
      ];
      const expectedItems = [
        {
          ...items[0],
          senderThreadId: "parent",
          receiverThreadIds: ["child", "unrelated-child"],
          agentsStates: {
            child: { status: "running", message: null, futureState: extension },
            "unrelated-child": { status: "pendingInit", message: null },
          },
        },
        { ...items[1], agentThreadId: "child" },
        ...items.slice(2),
      ];
      const turn = { id: "parent-physical", status: "completed", items, future: extension };
      const expectedTurn = { ...turn, items: expectedItems };
      let message: Record<string, unknown>;
      let expected: Record<string, unknown>;
      let method: string | undefined;
      if (surface === "item") {
        message = {
          method: "item/completed",
          params: {
            threadId: "parent-physical",
            turnId: "parent-physical",
            item: items[0],
            future: extension,
          },
          future: extension,
        };
        expected = {
          ...message,
          params: {
            threadId: "parent",
            turnId: "parent-physical",
            item: expectedItems[0],
            future: extension,
          },
        };
      } else if (surface === "turn") {
        message = {
          method: "turn/completed",
          params: { threadId: "parent-physical", turn, future: extension },
        };
        expected = {
          ...message,
          params: { threadId: "parent", turn: expectedTurn, future: extension },
        };
      } else if (surface === "thread") {
        message = {
          result: {
            thread: { id: "parent-physical", turns: [turn], future: extension },
            future: extension,
          },
        };
        expected = {
          result: {
            thread: { id: "parent", turns: [expectedTurn], future: extension },
            future: extension,
          },
        };
      } else if (surface === "turnsPage") {
        method = "thread/turns/list";
        message = { result: { data: [turn], nextCursor: "parent-physical", future: extension } };
        expected = {
          result: { data: [expectedTurn], nextCursor: "parent-physical", future: extension },
        };
      } else {
        method = surface === "itemsPage" ? "thread/items/list" : "thread/items/read";
        message = {
          result: {
            data: items.map((item) => ({ turnId: "parent-physical", item, future: extension })),
            nextCursor: "child-physical",
            future: extension,
          },
        };
        expected = {
          result: {
            data: expectedItems.map((item) => ({
              turnId: "parent-physical",
              item,
              future: extension,
            })),
            nextCursor: "child-physical",
            future: extension,
          },
        };
      }
      assert.deepEqual(links.toClient(message, method), expected);
      assert.deepEqual(
        links.toClient(expected, method),
        expected,
        "Logical references must be idempotent.",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("preserves an ambiguous native child-agent item instead of overwriting either state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-agent-state-ambiguity-"));
  try {
    const links = createCodexThreadLinks(directory);
    links.record("child", "child-previous");
    links.record("child", "child-current");
    const states = {
      "child-previous": { status: "completed", message: "Earlier result." },
      "child-current": { status: "running", message: null },
    };
    const before = structuredClone(states);
    const item = {
      type: "collabAgentToolCall",
      senderThreadId: "parent",
      receiverThreadIds: ["child-previous", "child-current"],
      agentsStates: states,
    };
    assert.deepEqual(links.toClient({ params: { item } }), { params: { item } });
    assert.deepEqual(states, before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses a foreign continuation index or symbolic link", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-chat-index-safety-"));
  try {
    const path = join(directory, ".client-thread-links.json");
    await writeFile(path, "{}");
    assert.throws(
      () => createCodexThreadLinks(directory).current("existing"),
      /continuation metadata is unavailable/u,
    );
    await rm(path);
    await writeFile(join(directory, "unrelated"), "unrelated");
    await symlink(join(directory, "unrelated"), path);
    assert.throws(
      () => createCodexThreadLinks(directory).record("existing", "replacement"),
      /continuation metadata is unavailable/u,
    );
    assert.equal(await readFile(join(directory, "unrelated"), "utf8"), "unrelated");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refreshes an existing relay when another relay changes or removes a continuation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-chat-refresh-"));
  try {
    const writer = createCodexThreadLinks(directory);
    const reader = createCodexThreadLinks(directory);
    writer.record("original", "managed");
    assert.equal(reader.current("original"), "managed");
    assert.equal(reader.logical("managed"), "original");
    writer.record("original", "official-again");
    assert.equal(reader.current("original"), "official-again");
    await rm(join(directory, ".client-thread-links.json"));
    assert.equal(reader.current("original"), "original");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects conflicting ownership without damaging stored continuations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-chat-ownership-"));
  try {
    const links = createCodexThreadLinks(directory);
    links.record("first", "first-current");
    links.record("second", "second-current");
    const before = await readFile(join(directory, ".client-thread-links.json"), "utf8");
    for (const conflicting of ["first", "first-current"])
      assert.throws(() => links.record("second", conflicting), /belongs to another chat/u);
    assert.equal(await readFile(join(directory, ".client-thread-links.json"), "utf8"), before);
    assert.equal(links.current("second"), "second-current");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects a stale fork instead of replacing a newer continuation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-chat-stale-fork-"));
  try {
    const first = createCodexThreadLinks(directory);
    const second = createCodexThreadLinks(directory);
    first.record("original", "newer", "original");
    assert.throws(() => second.record("original", "stale", "original"), /continuation changed/u);
    assert.equal(first.current("original"), "newer");
    assert.doesNotThrow(() => first.record("original", "newer", "original"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent relay writes without losing either chat", {
  timeout: 10000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-chat-concurrent-"));
  const fixture = join(directory, "writer.cjs");
  const releasePath = join(directory, "release");
  await writeFile(
    fixture,
    `const fs=require('node:fs');const root=process.argv[2];const thread=process.argv[3];
if(thread==='first') { const write=fs.writeFileSync;fs.writeFileSync=(path,...args)=>{if(typeof path==='string'&&path.includes('.client-thread-links.json.')){process.send('paused');while(!fs.existsSync(root+'/release'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}return write(path,...args);};require('node:module').syncBuiltinESMExports();}
import(process.argv[4]).then(({createCodexThreadLinks})=>{if(thread==='second')process.send('started');createCodexThreadLinks(root).record(thread,thread+'-continued');process.disconnect();}).catch(()=>process.exit(1));`,
  );
  const start = (thread: string) =>
    fork(
      fixture,
      [
        directory,
        thread,
        new URL(
          `./codex-thread-links.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
          import.meta.url,
        ).href,
      ],
      {
        execArgv: ["--import", import.meta.resolve("tsx")],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
  const first = start("first");
  const firstEnded = once(first, "exit");
  let second: ReturnType<typeof start> | undefined;
  try {
    assert.deepEqual(await once(first, "message"), ["paused", undefined]);
    second = start("second");
    const secondEnded = once(second, "exit");
    assert.deepEqual(await once(second, "message"), ["started", undefined]);
    await delay(50);
    await writeFile(releasePath, "release");
    assert.equal((await firstEnded)[0], 0);
    assert.equal((await secondEnded)[0], 0);
    const links = createCodexThreadLinks(directory);
    assert.equal(links.current("first"), "first-continued");
    assert.equal(links.current("second"), "second-continued");
  } finally {
    await writeFile(releasePath, "release");
    first.kill("SIGKILL");
    second?.kill("SIGKILL");
    await firstEnded;
    await rm(directory, { recursive: true, force: true });
  }
});

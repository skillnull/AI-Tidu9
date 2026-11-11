import assert from "node:assert/strict";
import test from "node:test";
import { createCodexAgentClient } from "./codex-app-server.js";
import type { JsonRpcClient, JsonRpcClientOptions } from "./json-rpc.js";

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
};

const createFixture = async (holdSteer = false, holdContext = false) => {
  let handlers!: JsonRpcClientOptions;
  const requests: { method: string; params: unknown }[] = [];
  const starts: ReturnType<typeof deferred<unknown>>[] = [];
  const steers: ReturnType<typeof deferred<unknown>>[] = [];
  const contexts: ReturnType<typeof deferred<unknown>>[] = [];
  const client = createCodexAgentClient({
    workingDirectory: ".",
    transportFactory: (options = {}) => {
      handlers = options;
      return {
        process: {} as JsonRpcClient["process"],
        request: <Value>(method: string, params: unknown, signal?: AbortSignal) => {
          requests.push({ method, params });
          const pending = deferred<unknown>();
          if (method === "turn/start") starts.push(pending);
          else if (method === "turn/steer" && holdSteer) steers.push(pending);
          else if (method === "thread/inject_items" && holdContext) contexts.push(pending);
          else pending.resolve({});
          if (signal?.aborted) pending.reject(new Error("Agent protocol request cancelled."));
          else
            signal?.addEventListener(
              "abort",
              () => pending.reject(new Error("Agent protocol request cancelled.")),
              { once: true },
            );
          return pending.promise as Promise<Value>;
        },
        notify: () => undefined,
        close: async () => undefined,
      };
    },
  });
  await client.initialize();
  const notify = (method: string, params: Record<string, unknown>) =>
    handlers.onNotification?.({ method, params });
  const startedTurns = new Set<string>();
  const started = (turnId = "turn", threadId = "thread") => {
    if (startedTurns.has(turnId)) return;
    startedTurns.add(turnId);
    notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
  };
  const call = (callId: string, turnId = "turn", threadId = "thread") => {
    started(turnId, threadId);
    notify("rawResponseItem/completed", {
      threadId,
      turnId,
      item: { type: "function_call", name: "inspect", call_id: callId, arguments: "{}" },
    });
  };
  const boundary = (turnId = "turn", threadId = "thread") => {
    started(turnId, threadId);
    notify("rawResponse/completed", {
      threadId,
      turnId,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
  };
  const tool = (callId: string, turnId = "turn", threadId = "thread") => {
    const reply =
      handlers.onRequest?.({
        id: callId,
        method: "item/tool/call",
        params: { threadId, turnId, callId, tool: "inspect", arguments: {} },
      }) ?? Promise.reject(new Error("Missing tool handler."));
    void reply.catch(() => undefined);
    return reply;
  };
  const finish = (
    status = "completed",
    turnId = "turn",
    threadId = "thread",
    usageFirst = true,
    totalTokens = 2,
  ) => {
    started(turnId, threadId);
    const usage = () =>
      notify("thread/tokenUsage/updated", {
        threadId,
        turnId,
        tokenUsage: { last: { inputTokens: totalTokens - 1, outputTokens: 1, totalTokens } },
      });
    const terminal = () => notify("turn/completed", { threadId, turn: { id: turnId, status } });
    if (usageFirst) {
      usage();
      terminal();
    } else {
      terminal();
      usage();
    }
  };
  return {
    client,
    handlers,
    requests,
    starts,
    steers,
    contexts,
    notify,
    started,
    call,
    boundary,
    tool,
    finish,
  };
};

const resultFor = (callId: string) => ({
  type: "function_call_output",
  call_id: callId,
  output: `${callId} result`,
});
const observe = <Value>(promise: Promise<Value>) => {
  const observation: { status: "pending" | "resolved" | "rejected"; value?: Value; error?: Error } =
    { status: "pending" };
  void promise.then(
    (value) => Object.assign(observation, { status: "resolved", value }),
    (error: Error) => Object.assign(observation, { status: "rejected", error }),
  );
  return observation;
};

test("concurrent repeated caller results settle without replacing the first continuation", async () => {
  const fixture = await createFixture(true);
  try {
    const initial = fixture.client.prompt("thread", [{ type: "text", text: "Inspect." }]);
    fixture.starts[0]?.resolve({ turn: { id: "turn" } });
    await nextTick();
    fixture.call("call");
    fixture.boundary();
    const native = fixture.tool("call");
    await initial;
    const first = observe(
      fixture.client.prompt(
        "thread",
        [{ type: "text", text: "Follow up." }],
        undefined,
        undefined,
        undefined,
        undefined,
        [resultFor("call")],
      ),
    );
    const second = observe(
      fixture.client.prompt(
        "thread",
        [{ type: "text", text: "Follow up." }],
        undefined,
        undefined,
        undefined,
        undefined,
        [resultFor("call")],
      ),
    );
    fixture.steers.forEach((pending) => {
      pending.resolve({ turnId: "turn" });
    });
    await nextTick();
    await native;
    fixture.finish();
    await nextTick();
    assert.equal(first.status, "resolved");
    assert.equal(second.status, "resolved");
    assert.equal(fixture.steers.length, 1);
  } finally {
    await fixture.client.close();
  }
});

test("collects complete caller batches received before the turn start acknowledgement", async () => {
  const fixture = await createFixture();
  try {
    const initial = fixture.client.prompt("thread", [{ type: "text", text: "Inspect twice." }]);
    fixture.call("first");
    fixture.call("second");
    fixture.boundary();
    fixture.starts[0]?.resolve({ turn: { id: "turn" } });
    await nextTick();
    const native = fixture.tool("first");
    const yielded = await initial;
    assert.deepEqual(
      yielded.toolCalls?.map((call) => call.callId),
      ["first", "second"],
    );
    const continuation = fixture.client.prompt(
      "thread",
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      [resultFor("first"), resultFor("second")],
    );
    await native;
    await fixture.tool("second");
    fixture.finish();
    await continuation;
  } finally {
    await fixture.client.close();
  }
});

test("interrupts a native turn whose acknowledgement arrives after cancellation", async () => {
  const fixture = await createFixture();
  try {
    const controller = new AbortController();
    const result = observe(
      fixture.client.prompt("thread", [{ type: "text", text: "Inspect." }], controller.signal),
    );
    controller.abort();
    await nextTick();
    fixture.starts[0]?.resolve({ turn: { id: "turn" } });
    await nextTick();
    assert.equal(result.status, "rejected");
    assert.equal(
      fixture.requests.filter((request) => request.method === "turn/interrupt").length,
      1,
    );
  } finally {
    await fixture.client.close();
  }
});

test("preserves a native terminal event received before the steer acknowledgement", async () => {
  const fixture = await createFixture(true);
  try {
    const initial = fixture.client.prompt("thread", [{ type: "text", text: "Inspect." }]);
    fixture.starts[0]?.resolve({ turn: { id: "turn" } });
    await nextTick();
    fixture.call("call");
    fixture.boundary();
    const native = fixture.tool("call").catch(() => undefined);
    await initial;
    const continuation = observe(
      fixture.client.prompt(
        "thread",
        [{ type: "text", text: "Follow up." }],
        undefined,
        undefined,
        undefined,
        undefined,
        [resultFor("call")],
      ),
    );
    fixture.finish("interrupted");
    fixture.steers[0]?.resolve({ turnId: "turn" });
    await nextTick();
    await native;
    assert.equal(continuation.status, "resolved");
    assert.equal(continuation.value?.status, "interrupted");
  } finally {
    await fixture.client.close();
  }
});

test("keeps all pending start notifications beyond thirty-two parallel turns", async () => {
  const fixture = await createFixture();
  try {
    const results = Array.from({ length: 33 }, (_unused, index) =>
      observe(fixture.client.prompt(`thread-${index}`, [{ type: "text", text: "Inspect." }])),
    );
    for (let index = 0; index < results.length; index += 1)
      fixture.finish("completed", `turn-${index}`, `thread-${index}`);
    fixture.starts.forEach((pending, index) => {
      pending.resolve({ turn: { id: `turn-${index}` } });
    });
    await nextTick();
    assert.equal(results.filter((result) => result.status === "resolved").length, 33);
  } finally {
    await fixture.client.close();
  }
});

for (const earlyAck of [false, true])
  for (const boundaryFirst of [false, true])
    for (const parallel of [false, true])
      for (const callCount of [1, 2])
        for (const batchCount of [1, 2])
          for (const steer of [false, true])
            for (const repeat of [false, true])
              for (const status of ["completed", "failed", "interrupted"])
                for (const usageFirst of [false, true]) {
                  const label = JSON.stringify({
                    earlyAck,
                    boundaryFirst,
                    parallel,
                    callCount,
                    batchCount,
                    steer,
                    repeat,
                    status,
                    usageFirst,
                  });
                  test(`caller lifecycle product ${label}`, { timeout: 2000 }, async () => {
                    const fixture = await createFixture();
                    try {
                      let current = fixture.client.prompt("thread", [
                        { type: "text", text: "Inspect." },
                      ]);
                      if (earlyAck) {
                        fixture.starts[0]?.resolve({ turn: { id: "turn" } });
                        await nextTick();
                      }
                      for (let batch = 0; batch < batchCount; batch += 1) {
                        const callIds = Array.from(
                          { length: callCount },
                          (_unused, index) => `call-${batch}-${index}`,
                        );
                        if (boundaryFirst) fixture.boundary();
                        callIds.forEach((callId) => {
                          fixture.call(callId);
                        });
                        if (!boundaryFirst) fixture.boundary();
                        const replies = parallel
                          ? callIds.map((callId) => fixture.tool(callId))
                          : [
                              callIds.reduce<Promise<unknown>>(async (previous, callId) => {
                                await previous;
                                return fixture.tool(callId);
                              }, Promise.resolve()),
                            ];
                        if (batch === 0 && !earlyAck)
                          fixture.starts[0]?.resolve({ turn: { id: "turn" } });
                        const yielded = await current;
                        assert.deepEqual(
                          yielded.toolCalls?.map((call) => call.callId),
                          callIds,
                          label,
                        );
                        const input = steer
                          ? [{ type: "text" as const, text: "Keep the scope." }]
                          : [];
                        const outputs = callIds.map(resultFor);
                        current = fixture.client.prompt(
                          "thread",
                          input,
                          undefined,
                          undefined,
                          undefined,
                          undefined,
                          outputs,
                        );
                        const repeated = repeat
                          ? fixture.client.prompt(
                              "thread",
                              input,
                              undefined,
                              undefined,
                              undefined,
                              undefined,
                              outputs,
                            )
                          : undefined;
                        if (repeated !== undefined) void repeated.catch(() => undefined);
                        await Promise.all(replies);
                        if (batch === batchCount - 1) {
                          fixture.finish(status, "turn", "thread", usageFirst, 7);
                          const result = await current;
                          assert.equal(result.status, status, label);
                          assert.equal(result.toolCalls, undefined, label);
                          assert.equal(result.usage?.totalTokens, 7, label);
                          if (repeated !== undefined) assert.equal(await repeated, result, label);
                        } else if (repeated !== undefined) {
                          const original = current;
                          current = original.then(async (result) => {
                            assert.equal(await repeated, result, label);
                            return result;
                          });
                        }
                      }
                      assert.equal(
                        fixture.requests.filter((request) => request.method === "turn/start")
                          .length,
                        1,
                        label,
                      );
                      assert.equal(
                        fixture.requests.filter((request) => request.method === "turn/steer")
                          .length,
                        steer ? batchCount : 0,
                        label,
                      );
                      assert.equal(
                        fixture.requests.filter((request) => request.method === "turn/interrupt")
                          .length,
                        0,
                        label,
                      );
                    } finally {
                      await fixture.client.close();
                    }
                  });
                }

for (const steer of [false, true])
  for (const lateRpc of [false, true])
    for (const status of ["completed", "failed", "interrupted"])
      for (const usageFirst of [false, true])
        for (const repeat of [false, true]) {
          const label = JSON.stringify({ steer, lateRpc, status, usageFirst, repeat });
          test(`caller context ownership product ${label}`, { timeout: 2000 }, async () => {
            const fixture = await createFixture(steer, true);
            try {
              const initial = fixture.client.prompt("thread", [
                { type: "text", text: "Inspect twice." },
              ]);
              fixture.starts[0]?.resolve({ turn: { id: "turn" } });
              await nextTick();
              fixture.call("first");
              fixture.call("second");
              fixture.boundary();
              const firstRpc = fixture.tool("first");
              let secondRpc = lateRpc ? undefined : fixture.tool("second");
              await initial;
              const input = steer ? [{ type: "text" as const, text: "Follow up." }] : [];
              const history = [
                resultFor("first"),
                resultFor("second"),
                {
                  type: "function_call_output",
                  name: "bootstrap",
                  namespace: "context",
                  output: "New context.",
                },
                {
                  type: "message",
                  role: "developer",
                  content: [{ type: "input_text", text: "Keep the scope." }],
                },
              ];
              const continuation = fixture.client.prompt(
                "thread",
                input,
                undefined,
                undefined,
                undefined,
                undefined,
                history,
              );
              const duplicate = repeat
                ? fixture.client.prompt(
                    "thread",
                    input,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    history,
                  )
                : undefined;
              if (duplicate !== undefined) void duplicate.catch(() => undefined);
              fixture.steers[0]?.resolve({ turnId: "turn" });
              await nextTick();
              if (lateRpc) {
                secondRpc = fixture.tool("second");
                await nextTick();
              }
              assert.equal(fixture.contexts.length, 1, label);
              fixture.contexts[0]?.resolve({});
              await Promise.all([firstRpc, secondRpc]);
              fixture.finish(status, "turn", "thread", usageFirst);
              const result = await continuation;
              assert.equal(result.status, status, label);
              assert.equal(result.toolCalls, undefined, label);
              if (duplicate !== undefined) assert.equal(await duplicate, result, label);
              const contexts = fixture.requests.filter(
                (request) => request.method === "thread/inject_items",
              );
              assert.equal(contexts.length, 1, label);
              assert.deepEqual(
                (contexts[0]?.params as { items: unknown[] } | undefined)?.items,
                history.slice(2),
                label,
              );
            } finally {
              await fixture.client.close();
            }
          });
        }

for (const terminalBeforeAck of [false, true])
  for (const status of ["completed", "failed", "interrupted"])
    for (const usageFirst of [false, true])
      for (const repeat of [false, true]) {
        const label = JSON.stringify({ terminalBeforeAck, status, usageFirst, repeat });
        test(`caller terminal during steer product ${label}`, { timeout: 2000 }, async () => {
          const fixture = await createFixture(true);
          try {
            const initial = fixture.client.prompt("thread", [{ type: "text", text: "Inspect." }]);
            fixture.starts[0]?.resolve({ turn: { id: "turn" } });
            await nextTick();
            fixture.call("call");
            fixture.boundary();
            const rpc = fixture.tool("call").catch(() => undefined);
            await initial;
            const input = [{ type: "text" as const, text: "Follow up." }];
            const continuation = fixture.client.prompt(
              "thread",
              input,
              undefined,
              undefined,
              undefined,
              undefined,
              [resultFor("call")],
            );
            const duplicate = repeat
              ? fixture.client.prompt("thread", input, undefined, undefined, undefined, undefined, [
                  resultFor("call"),
                ])
              : undefined;
            if (duplicate !== undefined) void duplicate.catch(() => undefined);
            if (terminalBeforeAck) fixture.finish(status, "turn", "thread", usageFirst);
            fixture.steers[0]?.resolve({ turnId: "turn" });
            await nextTick();
            if (!terminalBeforeAck) fixture.finish(status, "turn", "thread", usageFirst);
            const result = await continuation;
            assert.equal(result.status, status, label);
            if (duplicate !== undefined) assert.equal(await duplicate, result, label);
            await rpc;
          } finally {
            await fixture.client.close();
          }
        });
      }

// Before-start cancellation has no native ACK, RPC, batch, steer, or terminal axes.
test("does not submit native work for an already cancelled request", async () => {
  const fixture = await createFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      fixture.client.prompt("thread", [{ type: "text", text: "Inspect." }], controller.signal),
      { name: "AbortError" },
    );
    assert.equal(fixture.starts.length, 0);
  } finally {
    await fixture.client.close();
  }
});

// Before-ACK cancellation has no resumed batch, steer, or repeated result yet.
for (const boundaryFirst of [false, true])
  for (const parallel of [false, true])
    for (const callCount of [1, 2])
      for (const status of ["completed", "failed", "interrupted"])
        for (const usageFirst of [false, true]) {
          const label = JSON.stringify({ boundaryFirst, parallel, callCount, status, usageFirst });
          test(`caller cancellation before ACK product ${label}`, { timeout: 2000 }, async () => {
            const fixture = await createFixture();
            try {
              const controller = new AbortController();
              const initial = observe(
                fixture.client.prompt(
                  "thread",
                  [{ type: "text", text: "Inspect." }],
                  controller.signal,
                ),
              );
              const callIds = Array.from(
                { length: callCount },
                (_unused, index) => `call-${index}`,
              );
              if (boundaryFirst) fixture.boundary();
              callIds.forEach((callId) => {
                fixture.call(callId);
              });
              if (!boundaryFirst) fixture.boundary();
              const replies = parallel
                ? callIds.map((callId) => observe(fixture.tool(callId)))
                : [observe(fixture.tool(callIds[0] as string))];
              controller.abort();
              await nextTick();
              assert.equal(initial.status, "rejected", label);
              fixture.starts[0]?.resolve({ turn: { id: "turn" } });
              await nextTick();
              fixture.finish(status, "turn", "thread", usageFirst);
              await nextTick();
              assert.ok(
                replies.every((reply) => reply.status === "rejected"),
                label,
              );
              assert.equal(
                fixture.requests.filter((request) => request.method === "turn/interrupt").length,
                1,
                label,
              );
              const independent = fixture.client.prompt("independent", [
                { type: "text", text: "Continue." },
              ]);
              fixture.starts[1]?.resolve({ turn: { id: "independent-turn" } });
              await nextTick();
              fixture.finish("completed", "independent-turn", "independent", usageFirst);
              assert.equal((await independent).status, "completed", label);
            } finally {
              await fixture.client.close();
            }
          });
        }

for (const earlyAck of [false, true])
  for (const boundaryFirst of [false, true])
    for (const parallel of [false, true])
      for (const callCount of [1, 2])
        for (const batchCount of [1, 2])
          for (const steer of [false, true])
            for (const repeat of [false, true])
              for (const status of ["completed", "failed", "interrupted"])
                for (const usageFirst of [false, true])
                  for (const abortWindow of [
                    "beforeResume",
                    "duringContext",
                    "afterResults",
                    ...(steer ? ["duringSteer"] : []),
                  ]) {
                    // duringSteer does not exist when the caller adds no user input.
                    const label = JSON.stringify({
                      earlyAck,
                      boundaryFirst,
                      parallel,
                      callCount,
                      batchCount,
                      steer,
                      repeat,
                      status,
                      usageFirst,
                      abortWindow,
                    });
                    test(`caller cancellation product ${label}`, { timeout: 2000 }, async () => {
                      const fixture = await createFixture(
                        abortWindow === "duringSteer",
                        abortWindow === "duringContext",
                      );
                      try {
                        const initialController = new AbortController();
                        let current = fixture.client.prompt(
                          "thread",
                          [{ type: "text", text: "Inspect." }],
                          initialController.signal,
                        );
                        if (earlyAck) {
                          fixture.starts[0]?.resolve({ turn: { id: "turn" } });
                          await nextTick();
                        }
                        for (let batch = 0; batch < batchCount; batch += 1) {
                          const callIds = Array.from(
                            { length: callCount },
                            (_unused, index) => `call-${batch}-${index}`,
                          );
                          if (boundaryFirst) fixture.boundary();
                          callIds.forEach((callId) => {
                            fixture.call(callId);
                          });
                          if (!boundaryFirst) fixture.boundary();
                          const replies = parallel
                            ? callIds.map((callId) => fixture.tool(callId))
                            : [
                                callIds.reduce<Promise<unknown>>(async (previous, callId) => {
                                  await previous;
                                  return fixture.tool(callId);
                                }, Promise.resolve()),
                              ];
                          replies.forEach((reply) => {
                            void reply.catch(() => undefined);
                          });
                          if (batch === 0 && !earlyAck)
                            fixture.starts[0]?.resolve({ turn: { id: "turn" } });
                          await current;
                          // Closing the preceding HTTP response must not cancel yielded native tool work.
                          initialController.abort();
                          if (batch < batchCount - 1) {
                            current = fixture.client.prompt(
                              "thread",
                              [],
                              undefined,
                              undefined,
                              undefined,
                              undefined,
                              callIds.map(resultFor),
                            );
                            await Promise.all(replies);
                            continue;
                          }
                          const controller = new AbortController();
                          if (abortWindow === "beforeResume") controller.abort();
                          const input = steer
                            ? [{ type: "text" as const, text: "Follow up." }]
                            : [];
                          const history: Record<string, unknown>[] = callIds.map(resultFor);
                          if (abortWindow === "duringContext")
                            history.push({
                              type: "message",
                              role: "developer",
                              content: [{ type: "input_text", text: "Keep the scope." }],
                            });
                          const continuation = observe(
                            fixture.client.prompt(
                              "thread",
                              input,
                              controller.signal,
                              undefined,
                              undefined,
                              undefined,
                              history,
                            ),
                          );
                          const duplicate = repeat
                            ? observe(
                                fixture.client.prompt(
                                  "thread",
                                  input,
                                  controller.signal,
                                  undefined,
                                  undefined,
                                  undefined,
                                  history,
                                ),
                              )
                            : undefined;
                          await nextTick();
                          if (abortWindow === "afterResults") await Promise.all(replies);
                          controller.abort();
                          await nextTick();
                          fixture.steers.forEach((pending) => {
                            pending.resolve({ turnId: "turn" });
                          });
                          fixture.contexts.forEach((pending) => {
                            pending.resolve({});
                          });
                          fixture.finish(status, "turn", "thread", usageFirst);
                          await nextTick();
                          assert.equal(continuation.status, "rejected", label);
                          if (duplicate !== undefined)
                            assert.equal(duplicate.status, "rejected", label);
                          assert.equal(
                            fixture.requests.filter(
                              (request) => request.method === "turn/interrupt",
                            ).length,
                            1,
                            label,
                          );
                          await Promise.allSettled(replies);
                        }
                      } finally {
                        await fixture.client.close();
                      }
                    });
                  }

for (const invalid of [
  [{ type: "function_call_output", call_id: "orphan", output: "result" }],
  [{ type: "custom_tool_call_output", output: "result" }],
  [{ type: "function_call_output", name: " ", output: "result" }],
  [
    { ...resultFor("call"), output: "first" },
    { ...resultFor("call"), output: "different" },
  ],
]) {
  test(`rejects unmatched or conflicting caller results ${JSON.stringify(invalid)}`, async () => {
    const fixture = await createFixture();
    try {
      await assert.rejects(
        fixture.client.prompt("thread", [], undefined, undefined, undefined, undefined, invalid),
        /caller|Caller|Standalone|Conflicting/u,
      );
      assert.equal(fixture.starts.length, 0);
    } finally {
      await fixture.client.close();
    }
  });
}

for (const pendingCount of [1, 33])
  for (const injectionWindow of ["duringInjection", "whileStarting"])
    for (const earlyAck of [false, true]) {
      test(`ignores injected history turn IDs while registering live turns ${JSON.stringify({ pendingCount, injectionWindow, earlyAck })}`, {
        timeout: 2000,
      }, async () => {
        const fixture = await createFixture(false, true);
        try {
          const results = Array.from({ length: pendingCount }, (_unused, index) =>
            observe(
              fixture.client.prompt(
                `thread-${index}`,
                [{ type: "text", text: "Inspect." }],
                undefined,
                undefined,
                undefined,
                undefined,
                [
                  {
                    type: "message",
                    role: "user",
                    content: [{ type: "input_text", text: "Previous context." }],
                  },
                ],
              ),
            ),
          );
          if (injectionWindow === "whileStarting") {
            fixture.contexts.forEach((pending) => {
              pending.resolve({});
            });
            await nextTick();
          }
          for (let index = 0; index < pendingCount; index += 1) {
            for (let historical = 0; historical < 3; historical += 1)
              fixture.notify("rawResponseItem/completed", {
                threadId: `thread-${index}`,
                turnId: `restored-history-${index}-${historical}`,
                item: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "Previous context." }],
                },
              });
          }
          if (injectionWindow === "duringInjection") {
            fixture.contexts.forEach((pending) => {
              pending.resolve({});
            });
            await nextTick();
          }
          if (earlyAck) {
            fixture.starts.forEach((pending, index) => {
              pending.resolve({ turn: { id: `turn-${index}` } });
            });
            await nextTick();
          }
          for (let index = 0; index < pendingCount; index += 1)
            fixture.finish("completed", `turn-${index}`, `thread-${index}`);
          if (!earlyAck)
            fixture.starts.forEach((pending, index) => {
              pending.resolve({ turn: { id: `turn-${index}` } });
            });
          await nextTick();
          assert.equal(
            results.filter((result) => result.status === "resolved").length,
            pendingCount,
          );
          assert.equal(
            fixture.requests.filter((request) => request.method === "turn/interrupt").length,
            0,
          );
        } finally {
          await fixture.client.close();
        }
      });
    }

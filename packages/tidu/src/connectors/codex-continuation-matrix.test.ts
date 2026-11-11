import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCodexHostModelProvider } from "../providers/codex-host.js";
import { startLocalRuntime } from "../runtime/index.js";

const imageUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNwaDiAFTEMLQkAYvNgAXSglMMAAAAASUVORK5CYII=";

test("official host and HTTP continuation cover the complete request combination matrix", {
  skip: !process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND,
  timeout: 180_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-continuation-matrix-"));
  const fixtureErrors: string[] = [];
  const scenarios = new Map<
    string,
    {
      kind: string;
      batch: number;
      bootstrap: boolean;
      guidance: boolean;
      discoveredKind?: string;
      modelRequests: number;
      completed: number;
    }
  >();
  const modelServer = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as {
        input: Record<string, unknown>[];
      };
      const serialized = JSON.stringify(body.input);
      const label = /matrix-scenario:(\d+)/u.exec(serialized)?.[1];
      const scenario = label === undefined ? undefined : scenarios.get(label);
      assert.ok(scenario, "The host must preserve the scenario's real user input.");
      scenario.modelRequests += 1;
      const outputs = body.input.filter(
        (item) => item.type === "function_call_output" && typeof item.call_id === "string",
      );
      const complete = outputs.length >= scenario.batch + (scenario.discoveredKind ? 1 : 0);
      if (complete) {
        assert.equal(
          outputs.length,
          scenario.batch + (scenario.discoveredKind ? 1 : 0),
          `${label}: every tool result occurs once`,
        );
        assert.equal(
          body.input.filter(
            (item) =>
              item.role === "user" &&
              JSON.stringify(item.content).includes(`Inspect matrix-scenario:${label}.`),
          ).length,
          1,
          `${label}: the original user is retained once`,
        );
        assert.equal(
          body.input.filter(
            (item) =>
              item.role === "user" &&
              JSON.stringify(item.content).includes(`Explain matrix-scenario:${label}.`),
          ).length,
          scenario.guidance ? 1 : 0,
          `${label}: appended guidance is retained once`,
        );
        const images = body.input
          .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
          .filter(
            (part) => typeof part === "object" && part !== null && part.type === "input_image",
          );
        assert.equal(
          images.length,
          scenario.guidance ? 1 : 0,
          `${label}: appended image is retained once`,
        );
        if (scenario.bootstrap) {
          for (const name of ["initial_context", "updated_context"]) {
            const context = body.input.filter(
              (item) => item.type === "function_call_output" && item.name === name,
            );
            assert.equal(context.length, 1, `${label}: ${name} is retained once`);
            assert.equal(context[0]?.namespace, "context");
          }
        }
        scenario.completed += 1;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const items = complete
        ? [
            {
              type: "message",
              id: `answer_${label}`,
              role: "assistant",
              phase: "final_answer",
              content: [
                {
                  type: "output_text",
                  text: `Complete matrix-scenario:${label}.`,
                  annotations: [],
                },
              ],
            },
          ]
        : Array.from({ length: outputs.length > 0 ? 1 : scenario.batch }, (_unused, index) => ({
            type: "function_call",
            id: `item_${label}_${index}`,
            call_id: outputs.length > 0 ? `discovered_${label}` : `native_${label}_${index}`,
            name: outputs.length > 0 ? "tidu_caller_tool_1" : "tidu_caller_tool_0",
            arguments: JSON.stringify(
              (outputs.length > 0 ? scenario.discoveredKind : scenario.kind) === "custom"
                ? { input: `inspect ${label}` }
                : { query: `inspect ${label}` },
            ),
          }));
      const send = (type: string, payload: Record<string, unknown>) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      send("response.created", {
        response: { id: `response_${label}`, status: "in_progress", output: [] },
      });
      items.forEach((item, outputIndex) => {
        send("response.output_item.added", { output_index: outputIndex, item });
        send("response.output_item.done", { output_index: outputIndex, item });
      });
      send("response.completed", {
        response: {
          id: `response_${label}`,
          status: "completed",
          output: items,
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        },
      });
      response.end();
    } catch (error) {
      fixtureErrors.push((error as Error).message);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: (error as Error).message } }));
    }
  });
  await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
  const address = modelServer.address();
  assert.ok(address !== null && typeof address !== "string");
  const wrapper = join(directory, "fixture-host");
  const tracePath = join(directory, "native-events.jsonl");
  await writeFile(
    wrapper,
    `#!${process.execPath}
const {spawn}=require("node:child_process");
const {appendFileSync}=require("node:fs");
const {createInterface}=require("node:readline");
if(process.argv[2]==="login"){console.log("Logged in to fixture");process.exit(0)}
const child=spawn(${JSON.stringify(process.env.TIDU_CODEX_PROTOCOL_TEST_COMMAND)},process.argv.slice(2),{stdio:["pipe","pipe","inherit"]});
const forward=(direction,line,target)=>{const message=JSON.parse(line);appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({direction,id:message.id,method:message.method,errorCode:message.error?.code,turnId:message.params?.turnId??message.result?.turn?.id,inputTypes:message.params?.input?.map(item=>item.type)})+'\\n');target.write(line+'\\n');};
createInterface({input:process.stdin}).on("line",line=>forward("client",line,child.stdin));
createInterface({input:child.stdout}).on("line",line=>forward("server",line,process.stdout));
process.on("SIGTERM",()=>child.kill("SIGTERM"));child.on("exit",code=>process.exit(code??1));
`,
    { mode: 0o700 },
  );
  await writeFile(
    join(directory, "config.toml"),
    [
      "[model_providers.fixture]",
      'name="fixture"',
      `base_url="http://127.0.0.1:${address.port}/v1"`,
      'wire_api="responses"',
      "requires_openai_auth=false",
      "supports_websockets=false",
    ].join("\n"),
  );
  const provider = await createCodexHostModelProvider("gpt-5.1-codex", {
    command: wrapper,
    codexHomeDirectory: directory,
    modelProvider: "fixture",
  });
  assert.ok(provider);
  const runtime = await startLocalRuntime({ databasePath: ":memory:", port: 0, provider });
  const invoke = async (body: Record<string, unknown>) => {
    const response = await fetch(`${runtime.origin}/v1/hosts/codex/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "ai-tidu9-config", ...body }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    if (!body.stream) return JSON.parse(text) as { output: Record<string, unknown>[] };
    const terminal = text
      .split(/\r?\n\r?\n/u)
      .flatMap((event) => {
        const data = event
          .split(/\r?\n/u)
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        return data === undefined || data === "[DONE]"
          ? []
          : [JSON.parse(data) as Record<string, unknown>];
      })
      .find((event) => event.type === "response.completed");
    assert.ok(terminal, text);
    return terminal.response as { output: Record<string, unknown>[] };
  };
  try {
    let tested = 0;
    for (const stream of [false, true])
      for (const kind of ["function", "custom", "tool_search"])
        for (const batch of [1, 2])
          for (const guidance of [false, true])
            for (const fullHistory of [false, true])
              for (const bootstrap of [false, true])
                for (const concurrent of [false, true]) {
                  const label = String(++tested);
                  const combination = JSON.stringify({
                    stream,
                    kind,
                    batch,
                    guidance,
                    fullHistory,
                    bootstrap,
                    concurrent,
                  });
                  scenarios.set(label, {
                    kind,
                    batch,
                    bootstrap,
                    guidance,
                    modelRequests: 0,
                    completed: 0,
                  });
                  try {
                    const tools =
                      kind === "tool_search"
                        ? [{ type: "tool_search", execution: "client" }]
                        : [
                            {
                              type: kind,
                              name: "inspect",
                              parameters: { type: "object", properties: {} },
                            },
                          ];
                    const user = { role: "user", content: `Inspect matrix-scenario:${label}.` };
                    const initialContext = {
                      type: "function_call_output",
                      name: "initial_context",
                      namespace: "context",
                      output: "Initial context.",
                    };
                    const initialInput = [user, ...(bootstrap ? [initialContext] : [])];
                    const initial = await invoke({ stream, tools, input: initialInput });
                    const calls = initial.output.filter((item) =>
                      ["function_call", "custom_tool_call", "tool_search_call"].includes(
                        String(item.type),
                      ),
                    );
                    assert.equal(calls.length, batch, combination);
                    assert.equal(
                      initial.output.length,
                      batch,
                      `${combination}: no synthetic process items`,
                    );
                    const results = calls.map((call) =>
                      kind === "tool_search"
                        ? { type: "tool_search_output", call_id: call.call_id, tools: [] }
                        : {
                            type:
                              kind === "custom"
                                ? "custom_tool_call_output"
                                : "function_call_output",
                            call_id: call.call_id,
                            output: `Saved result ${label}.`,
                          },
                    );
                    const input = [
                      ...(fullHistory ? [...initialInput, ...initial.output] : []),
                      ...results,
                      ...(bootstrap
                        ? [
                            {
                              type: "function_call_output",
                              name: "updated_context",
                              namespace: "context",
                              output: "Updated context.",
                            },
                          ]
                        : []),
                      ...(guidance
                        ? [
                            {
                              role: "user",
                              content: [
                                { type: "input_text", text: `Explain matrix-scenario:${label}.` },
                                { type: "input_image", image_url: imageUrl },
                              ],
                            },
                          ]
                        : []),
                    ];
                    const body = { stream, tools, input };
                    const completions = await Promise.all(
                      Array.from({ length: concurrent ? 2 : 1 }, () => invoke(body)),
                    );
                    for (const completion of completions) {
                      assert.equal(
                        completion.output.length,
                        1,
                        `${combination}: no synthetic final items`,
                      );
                      assert.match(
                        JSON.stringify(completion),
                        new RegExp(`Complete matrix-scenario:${label}`, "u"),
                      );
                      assert.match(
                        JSON.stringify(completion),
                        new RegExp(
                          `Total: input ${guidance ? 5 : 10} · output ${guidance ? 2 : 4} · total ${guidance ? 7 : 14}`,
                          "u",
                        ),
                      );
                      assert.ok(
                        completion.output.every(
                          (item) =>
                            !["function_call", "custom_tool_call", "tool_search_call"].includes(
                              String(item.type),
                            ),
                        ),
                      );
                    }
                    assert.equal(
                      scenarios.get(label)?.modelRequests,
                      2,
                      `${combination}: inference must not restart`,
                    );
                    assert.equal(
                      scenarios.get(label)?.completed,
                      1,
                      `${combination}: one native continuation`,
                    );
                  } catch (error) {
                    const trace = (await readFile(tracePath, "utf8"))
                      .trim()
                      .split("\n")
                      .slice(-16)
                      .join("\n");
                    throw new Error(
                      `Combination ${label}: ${combination}; modelRequests=${scenarios.get(label)?.modelRequests}; fixtureErrors=${JSON.stringify(fixtureErrors.slice(-3))}\n${trace}`,
                      { cause: error },
                    );
                  }
                }
    assert.equal(tested, 192);
    let discoveryCases = 0;
    for (const stream of [false, true])
      for (const discoveredKind of ["function", "custom"])
        for (const fullHistory of [false, true]) {
          const label = String(192 + ++discoveryCases);
          const combination = JSON.stringify({ stream, discoveredKind, fullHistory });
          scenarios.set(label, {
            kind: "tool_search",
            batch: 1,
            bootstrap: false,
            guidance: false,
            discoveredKind,
            modelRequests: 0,
            completed: 0,
          });
          try {
            const search = { type: "tool_search", execution: "client" };
            const discovered = {
              type: discoveredKind,
              name: "discovered_inspect",
              parameters: { type: "object", properties: {} },
            };
            const original = [{ role: "user", content: `Inspect matrix-scenario:${label}.` }];
            const first = await invoke({ stream, tools: [search], input: original });
            const call = first.output.find((item) => item.type === "tool_search_call");
            assert.ok(call);
            const searchResult = {
              type: "tool_search_output",
              call_id: call.call_id,
              tools: [discovered],
            };
            const history = [...original, ...first.output, searchResult];
            const second = await invoke({
              stream,
              tools: [search, discovered],
              input: fullHistory ? history : [searchResult],
            });
            const discoveredCall = second.output.find(
              (item) =>
                item.type === (discoveredKind === "custom" ? "custom_tool_call" : "function_call"),
            );
            assert.ok(discoveredCall, JSON.stringify(second));
            assert.equal(discoveredCall.name, "discovered_inspect");
            const result = {
              type:
                discoveredKind === "custom" ? "custom_tool_call_output" : "function_call_output",
              call_id: discoveredCall.call_id,
              output: `Discovered result ${label}.`,
            };
            const final = await invoke({
              stream,
              tools: [search, discovered],
              input: fullHistory ? [...history, ...second.output, result] : [result],
            });
            assert.match(
              JSON.stringify(final),
              new RegExp(`Complete matrix-scenario:${label}`, "u"),
            );
            assert.match(JSON.stringify(final), /Total: input 15 · output 6 · total 21/u);
            assert.equal(scenarios.get(label)?.modelRequests, 3, combination);
            assert.equal(scenarios.get(label)?.completed, 1, combination);
          } catch (error) {
            throw new Error(`Discovery combination ${label}: ${combination}`, { cause: error });
          }
        }
    assert.equal(discoveryCases, 8);
  } finally {
    await runtime.close();
    modelServer.closeAllConnections();
    await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

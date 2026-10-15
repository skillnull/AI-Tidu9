import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { setupConnectors } from "./setup.js";

test("setup uses one absolute MCP launch for detected hosts", () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-setup-"));
  const binaryDirectory = join(root, "bin");
  const codexState = join(root, "codex-state");
  const codex = join(binaryDirectory, "codex");
  const cursor = join(binaryDirectory, "cursor");
  try {
    mkdirSync(binaryDirectory, { recursive: true });
    writeFileSync(
      codex,
      `#!/bin/sh\nif [ "$2" = "get" ]; then [ -f ${JSON.stringify(codexState)} ]; exit $?; fi\nif [ "$2" = "add" ]; then touch ${JSON.stringify(codexState)}; exit 0; fi\nif [ "$2" = "remove" ]; then rm -f ${JSON.stringify(codexState)}; exit 0; fi\nexit 1\n`,
    );
    writeFileSync(cursor, "#!/bin/sh\nexit 0\n");
    chmodSync(codex, 0o700);
    chmodSync(cursor, 0o700);
    const report = setupConnectors({
      action: "install",
      cliEntry: "/opt/tidu/dist/cli/index.js",
      nodeExecutable: "/opt/node/bin/node",
      homeDirectory: root,
      executablePath: binaryDirectory,
    });
    assert.equal(report.healthy, true);
    const cursorConfiguration = JSON.parse(
      readFileSync(join(root, ".cursor/mcp.json"), "utf8"),
    ) as {
      mcpServers: { "ai-tidu9": { command: string; args: string[] } };
    };
    assert.equal(cursorConfiguration.mcpServers["ai-tidu9"].command, "/opt/node/bin/node");
    assert.deepEqual(cursorConfiguration.mcpServers["ai-tidu9"].args.slice(0, 2), [
      "/opt/tidu/dist/cli/index.js",
      "mcp",
    ]);
    assert.equal(
      setupConnectors({
        action: "verify",
        cliEntry: "/opt/tidu/dist/cli/index.js",
        nodeExecutable: "/opt/node/bin/node",
        homeDirectory: root,
        executablePath: binaryDirectory,
      }).healthy,
      true,
    );
    for (const action of ["repair", "update"] as const) {
      assert.equal(
        setupConnectors({
          action,
          cliEntry: "/opt/tidu/dist/cli/index.js",
          nodeExecutable: "/opt/node/bin/node",
          homeDirectory: root,
          executablePath: binaryDirectory,
        }).healthy,
        true,
      );
    }
    assert.equal(
      setupConnectors({
        action: "uninstall",
        cliEntry: "/opt/tidu/dist/cli/index.js",
        nodeExecutable: "/opt/node/bin/node",
        homeDirectory: root,
        executablePath: binaryDirectory,
      }).healthy,
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup can register only the Codex connector without changing Cursor", () => {
  const root = mkdtempSync(join(tmpdir(), "tidu-codex-only-"));
  const binaryDirectory = join(root, "bin");
  const codex = join(binaryDirectory, "codex");
  try {
    mkdirSync(binaryDirectory, { recursive: true });
    writeFileSync(
      codex,
      '#!/bin/sh\nif [ "$2" = "get" ]; then exit 1; fi\nif [ "$2" = "add" ]; then exit 0; fi\nexit 1\n',
    );
    chmodSync(codex, 0o700);
    const report = setupConnectors({
      action: "install",
      cliEntry: "/opt/tidu/dist/cli/index.js",
      nodeExecutable: "/opt/node/bin/node",
      homeDirectory: root,
      executablePath: binaryDirectory,
      targets: ["codex"],
    });

    assert.equal(report.healthy, true);
    assert.deepEqual(
      report.connectors.map((connector) => connector.id),
      ["codex"],
    );
    assert.equal(existsSync(join(root, ".cursor/mcp.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

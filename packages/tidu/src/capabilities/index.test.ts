import assert from "node:assert/strict";
import test from "node:test";

import { createCapabilityRegistry } from "./index.js";

test("assembles Agent, Skill, MCP, tool, and knowledge assets by capability", () => {
  const registry = createCapabilityRegistry([
    {
      id: "company-knowledge",
      kind: "knowledge",
      description: "Private product knowledge",
      capabilities: ["product-context"],
      enabled: true,
      privacy: "private",
      cost: 0,
    },
    {
      id: "delivery-skill",
      kind: "skill",
      description: "Delivery workflow",
      capabilities: ["delivery", "verification"],
      enabled: true,
      privacy: "local",
      cost: 0,
    },
    {
      id: "external-search",
      kind: "mcp",
      description: "External search server",
      capabilities: ["research"],
      enabled: true,
      privacy: "external",
      cost: 1,
    },
  ]);

  const assembly = registry.assemble({
    requiredCapabilities: ["product-context", "verification"],
    privacy: "private",
  });
  assert.deepEqual(
    assembly.assets.map((asset) => asset.id),
    ["company-knowledge", "delivery-skill"],
  );
  assert.deepEqual(assembly.missingCapabilities, []);
});

test("reports missing capabilities without crossing the requested privacy boundary", () => {
  const registry = createCapabilityRegistry([
    {
      id: "external-agent",
      kind: "agent",
      description: "External research Agent",
      capabilities: ["research"],
      enabled: true,
      privacy: "external",
      cost: 0,
    },
  ]);

  const assembly = registry.assemble({
    requiredCapabilities: ["research"],
    privacy: "local",
  });
  assert.deepEqual(assembly.assets, []);
  assert.deepEqual(assembly.missingCapabilities, ["research"]);
});

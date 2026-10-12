import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultConfiguration } from "../config/index.js";
import { PRODUCT } from "../core/index.js";
import { createConfigCenterBootstrap } from "./index.js";

test("creates a configuration-center bootstrap with isolated drafts", async () => {
  const managedConfiguration = createDefaultConfiguration("managed");
  const expertConfiguration = createDefaultConfiguration("expert");
  const bootstrap = await createConfigCenterBootstrap({
    configurationStore: {
      activateDraft: async () => {
        throw new Error("not used");
      },
      loadWorkspace: async () => ({
        active: { configuration: managedConfiguration, revision: 1, updatedAt: "test" },
        drafts: {
          managed: {
            configuration: managedConfiguration,
            mode: "managed",
            revision: 1,
            updatedAt: "test",
          },
          expert: {
            configuration: expertConfiguration,
            mode: "expert",
            revision: 1,
            updatedAt: "test",
          },
        },
      }),
      saveDraft: async () => {
        throw new Error("not used");
      },
    },
    provider: "sqlite",
    schemaVersion: "2",
  });

  assert.equal(bootstrap.product.name, PRODUCT.name);
  assert.equal(bootstrap.runtime.status, "ok");
  assert.equal(bootstrap.storage.provider, "sqlite");
  assert.equal(bootstrap.configuration.workspace.active.configuration.activeMode, "managed");
  assert.equal(bootstrap.configuration.workspace.drafts.expert.mode, "expert");
  assert.equal(bootstrap.configuration.editable, true);
});

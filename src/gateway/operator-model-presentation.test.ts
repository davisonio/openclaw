import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { modelSelectionPoliciesMatch } from "./operator-model-presentation.js";

const loadManifestMetadataSnapshot = vi.hoisted(() => vi.fn());
vi.mock("../plugins/manifest-contract-eligibility.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/manifest-contract-eligibility.js")>();
  loadManifestMetadataSnapshot.mockImplementation(actual.loadManifestMetadataSnapshot);
  return { ...actual, loadManifestMetadataSnapshot };
});

const configWithPrimary = (primary: string): OpenClawConfig => ({
  agents: { defaults: { model: { primary } } },
  models: {
    providers: {
      vllm: {
        baseUrl: "http://127.0.0.1:1/v1",
        api: "openai-completions",
        models: [
          { id: "model-a", name: "model-a" },
          { id: "model-b", name: "model-b" },
        ],
      },
    },
  },
});

describe("modelSelectionPoliciesMatch", () => {
  it("compares config commits against the published plugin inventory", () => {
    setGatewayPluginMetadataSnapshot(createPluginMetadataSnapshotFixture());

    // Reload commits run in an operation cache, where a metadata load rescans plugin files.
    const matches = withPluginCache(createPluginCache(), () =>
      modelSelectionPoliciesMatch(configWithPrimary("model-a"), configWithPrimary("model-b")),
    );

    expect(matches).toBe(true);
    expect(loadManifestMetadataSnapshot).not.toHaveBeenCalled();
  });
});

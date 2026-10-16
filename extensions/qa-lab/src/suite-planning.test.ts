import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readQaScenarioById } from "./scenario-catalog.js";
import { requireFlowScenario } from "./scenario-catalog.test-utils.js";
import {
  applyQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayRuntimeOptions,
  collectQaSuitePluginIds,
  collectQaSuiteTransportPolicy,
  normalizeQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannels,
  resolveQaSuiteOutputDir,
  scenarioRequiresIsolatedQaSuiteWorker,
  selectQaFlowSuiteScenarios,
  shouldUseIsolatedQaSuiteScenarioWorkers,
} from "./suite-planning.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

function makePlaywrightQaSuiteTestScenario(id: string): ReturnType<typeof makeQaSuiteTestScenario> {
  return {
    ...makeQaSuiteTestScenario(id),
    execution: {
      kind: "playwright",
      path: `ui/src/e2e/${id}.e2e.test.ts`,
    },
  };
}

const roots: string[] = [];
async function makeRoot(prefix: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Scenario = ReturnType<typeof makeQaSuiteTestScenario>;
const channelParams = (scenarios: Scenario[], explicitChannel?: string) => ({
  defaultChannel: "telegram",
  scenarios,
  explicitChannel,
});
const resolveChannel = (scenarios: Scenario[], explicitChannel?: string) =>
  resolveQaSuiteScenarioChannel(channelParams(scenarios, explicitChannel));

describe("qa suite planning helpers", () => {
  it("normalizes blank scenario channels as unpinned", () => {
    expect(
      normalizeQaSuiteScenarioChannel(makeQaSuiteTestScenario("blank-channel", { channel: "   " })),
    ).toBeUndefined();
    expect(
      normalizeQaSuiteScenarioChannel(
        makeQaSuiteTestScenario("matrix-channel", { channel: " Matrix " }),
      ),
    ).toBe("matrix");
  });

  it("keeps programmatic suite output dirs within the repo root", async () => {
    const repoRoot = await makeRoot("qa-suite-existing-root-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "custom");
    await expect(resolveQaSuiteOutputDir(repoRoot, outputDir)).resolves.toBe(outputDir);
    expect((await lstat(outputDir)).isDirectory()).toBe(true);
    await expect(resolveQaSuiteOutputDir(repoRoot, "/tmp/outside")).rejects.toThrow(
      "QA suite outputDir must stay within the repo root.",
    );
  });

  it("rejects symlinked suite output dirs that escape the repo root", async () => {
    const repoRoot = await makeRoot("qa-suite-root-");
    const outsideRoot = await makeRoot("qa-suite-outside-");
    await mkdir(path.join(repoRoot, ".artifacts"), { recursive: true });
    await symlink(outsideRoot, path.join(repoRoot, ".artifacts", "qa-e2e"), "dir");

    await expect(resolveQaSuiteOutputDir(repoRoot, ".artifacts/qa-e2e/custom")).rejects.toThrow(
      "QA suite outputDir must not traverse symlinks.",
    );
  });

  it("preserves ordered independent flow instances for repeated requested IDs", () => {
    const scenarios = [makeQaSuiteTestScenario("first"), makeQaSuiteTestScenario("second")];
    const selected = selectQaFlowSuiteScenarios({
      scenarios,
      scenarioIds: ["first", "second", "first"],
      providerMode: "mock-openai",
      primaryModel: "mock-openai/test-model",
    });
    expect(selected.map((scenario) => scenario.id)).toEqual(["first", "second", "first"]);
    expect(new Set(selected).size).toBe(3);
    expect(selected[0]).toEqual(scenarios[0]);
    expect(selected[0]).not.toBe(scenarios[0]);
    expect(selected[2]).not.toBe(selected[0]);
  });

  it("applies the same lane contract to explicit and implicit selection", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic"),
      makeQaSuiteTestScenario("openai-only", {
        config: { requiredProvider: "openai", requiredModel: "gpt-5.6-luna" },
      }),
      makeQaSuiteTestScenario("anthropic-only", {
        config: { requiredProvider: "anthropic", requiredModel: "claude-opus-4-8" },
      }),
    ];
    const lane = {
      scenarios,
      providerMode: "live-frontier" as const,
      primaryModel: "openai/gpt-5.6-luna",
    };

    expect(selectQaFlowSuiteScenarios(lane).map((scenario) => scenario.id)).toEqual([
      "generic",
      "openai-only",
    ]);
    expect(
      selectQaFlowSuiteScenarios({ ...lane, scenarioIds: ["openai-only"] }).map(
        (scenario) => scenario.id,
      ),
    ).toEqual(["openai-only"]);
    expect(() => selectQaFlowSuiteScenarios({ ...lane, scenarioIds: ["anthropic-only"] })).toThrow(
      "selected QA scenario(s) do not match the current QA lane: anthropic-only (provider=anthropic, model=claude-opus-4-8)",
    );
  });

  it("resolves driver channels from scenario execution with explicit and default fallbacks", () => {
    const plain = makeQaSuiteTestScenario("plain");
    const slack = makeQaSuiteTestScenario("slack-flow", { channel: "slack" });
    const telegram = makeQaSuiteTestScenario("telegram-flow", { channel: "telegram" });
    expect(resolveChannel([plain])).toBe("telegram");
    expect(resolveChannel([plain, slack])).toBe("slack");
    expect(resolveChannel([slack], "slack")).toBe("slack");
    expect(() => resolveChannel([slack], "telegram")).toThrow(
      "--channel telegram conflicts with selected scenario execution.channel slack.",
    );
    expect(() => resolveChannel([slack, telegram])).toThrow(
      "Selected QA scenarios require multiple channels",
    );
    expect(
      resolveQaSuiteScenarioChannels(
        channelParams([
          plain,
          makeQaSuiteTestScenario("matrix-flow", { channel: "matrix" }),
          slack,
        ]),
      ),
    ).toEqual(["telegram", "matrix", "slack"]);
  });

  it("isolates Matrix reaction flows that require a fresh native canary", () => {
    const scenarioIds = [
      "matrix-reaction-notification",
      "matrix-reaction-threaded",
      "matrix-reaction-not-a-reply",
      "matrix-reaction-redaction-observed",
    ];

    for (const scenarioId of scenarioIds) {
      const scenario = requireFlowScenario(readQaScenarioById(scenarioId));
      expect(scenario.execution.suiteIsolation, scenarioId).toBe("isolated");
      expect(scenario.execution.isolationReason, scenarioId).toContain("fresh canary reply");
      expect(scenarioRequiresIsolatedQaSuiteWorker(scenario), scenarioId).toBe(true);
    }
  });

  it("isolates and collects scenario-declared transport policy", () => {
    const scenario = makeQaSuiteTestScenario("sender-policy", {
      transportPolicy: {
        directMessageOnly: true,
        requireGroupMention: true,
        senderAllowlist: ["driver"],
      },
    });

    expect(scenarioRequiresIsolatedQaSuiteWorker(scenario)).toBe(true);
    expect(collectQaSuiteTransportPolicy([scenario])).toEqual({
      directMessageOnly: true,
      requireGroupMention: true,
      senderAllowlist: ["driver"],
    });
  });

  it("collects unique scenario-declared bundled plugins in encounter order", () => {
    const scenarios = [
      makeQaSuiteTestScenario("generic", { plugins: ["active-memory", "memory-wiki"] }),
      makeQaSuiteTestScenario("other", { plugins: ["memory-wiki", "openai"] }),
      makeQaSuiteTestScenario("plain"),
    ];

    expect(collectQaSuitePluginIds(scenarios)).toEqual(["active-memory", "memory-wiki", "openai"]);
  });

  it("ignores prototype-mutating keys in scenario startup config patches", () => {
    const scenarios = [
      makeQaSuiteTestScenario("polluted", {
        gatewayConfigPatch: JSON.parse(
          `{"plugins":{"entries":{}},"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`,
        ) as Record<string, unknown>,
      }),
    ];

    const patch = applyQaSuiteGatewayConfigPatches(
      {},
      collectQaSuiteGatewayConfigPatches(scenarios),
    );

    expect(patch).toEqual({ plugins: { entries: {} } });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("keeps a scenario deletion from resurrecting baseline siblings", () => {
    const scenarios = [
      makeQaSuiteTestScenario("drops-tools", { gatewayConfigPatch: { tools: null } }),
      makeQaSuiteTestScenario("adds-web-search", {
        gatewayConfigPatch: { tools: { web: { search: { enabled: true } } } },
      }),
    ];
    const baseline = { tools: { profile: "coding", deny: ["shell"] } };

    expect(
      applyQaSuiteGatewayConfigPatches(baseline, collectQaSuiteGatewayConfigPatches(scenarios)),
    ).toEqual({ tools: { web: { search: { enabled: true } } } });
  });

  it("targets the selected adapter account in scenario startup config patches", () => {
    const scenarios = [readQaScenarioById("whatsapp-access-control-dm-open")];

    expect(
      applyQaSuiteGatewayConfigPatches(
        {},
        collectQaSuiteGatewayConfigPatches(scenarios, "whatsapp-alt"),
      ),
    ).toEqual({
      channels: {
        whatsapp: {
          accounts: {
            "whatsapp-alt": {
              dmPolicy: "open",
            },
          },
        },
      },
    });
  });

  it("collects gateway runtime options across selected scenarios", () => {
    const scenarios = [
      makeQaSuiteTestScenario("plain"),
      makeQaSuiteTestScenario("browser-ui", {
        plugins: ["browser"],
        gatewayRuntime: { forwardHostHome: true },
      }),
      makeQaSuiteTestScenario("otel-stdout", {
        plugins: ["diagnostics-otel"],
        gatewayRuntime: { preserveDebugArtifacts: true },
      }),
      makeQaSuiteTestScenario("blocked-channel", {
        gatewayRuntime: { allowUnhealthyStartup: true },
      }),
    ];

    expect(collectQaSuiteGatewayRuntimeOptions(scenarios)).toEqual({
      allowUnhealthyStartup: true,
      forwardHostHome: true,
      preserveDebugArtifacts: true,
    });
  });

  it.each([
    {
      reason: "explicit scenario isolation",
      makeScenario: () => makeQaSuiteTestScenario("isolated", { suiteIsolation: "isolated" }),
    },
    {
      reason: "scenario-owned plugins",
      makeScenario: () => makeQaSuiteTestScenario("plugin", { plugins: ["diagnostics-otel"] }),
    },
    {
      reason: "state-mutating flow calls",
      makeScenario: () => readQaScenarioById("plugin-lifecycle-hot-reload"),
    },
  ])("isolates serial runs for $reason", ({ makeScenario }) => {
    const scenario = makeScenario();

    expect(scenarioRequiresIsolatedQaSuiteWorker(scenario)).toBe(true);
    expect(
      shouldUseIsolatedQaSuiteScenarioWorkers({
        scenarios: [makeQaSuiteTestScenario("baseline"), scenario],
        concurrency: 1,
      }),
    ).toBe(true);
  });

  it("rejects explicit Playwright scenarios in the flow suite selector", () => {
    const scenarios = [
      makeQaSuiteTestScenario("flow"),
      makePlaywrightQaSuiteTestScenario("playwright"),
    ];

    expect(() =>
      selectQaFlowSuiteScenarios({
        scenarios,
        scenarioIds: ["playwright"],
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
      }),
    ).toThrow(
      "suite execution requires flow scenarios; unsupported scenario(s): playwright (playwright)",
    );
  });
});

import "./suite-run-isolated.test-mocks.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectQaEvidenceScenarioOutcomes,
  type QaEvidenceSummaryV3Json as Evidence,
} from "./evidence-summary.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import type { QaTransportAdapterFactory } from "./qa-transport-registry.js";
import * as scenarioCatalog from "./scenario-catalog.js";
import { createQaSuiteEvidenceInvocation } from "./suite-evidence.js";
import { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import {
  createCleanupTestLab,
  createCleanupTestContext,
  mocks,
} from "./suite-run-isolated.test-support.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { runQaFlowSuiteFromRuntime } from "./suite-run.runtime.js";
import {
  makeQaSuiteTestScenario as makeScenario,
  recordQaSuiteTestResults,
} from "./suite-test-helpers.js";
import type {
  QaSuiteRunner as SuiteRunner,
  QaSuiteRunParams as RunParams,
  QaSuiteScenarioRunner as ScenarioRunner,
  QaSuiteScenarioResult as ScenarioResult,
} from "./suite-types.js";
import * as suite from "./suite.js";

const {
  writeQaSuiteArtifacts: writeArtifacts,
  disposeRegisteredAgentHarnesses: disposeHarnesses,
  captureTransportArtifacts: captureArtifacts,
} = mocks;
const leasedId = "leased-channel-scenario";
const nestedIds = ["first-crabline-scenario", "second-crabline-scenario"];
let lab: QaLabServerHandle;
let context: ReturnType<typeof createCleanupTestContext>;
beforeEach(() => {
  lab = createCleanupTestLab();
  context = createCleanupTestContext();
});
const artifacts = {
  evidencePath: "/qa-output/qa-evidence.json",
  report: "",
  reportPath: "/qa-output/qa-suite-report.md",
  summaryPath: "/qa-output/qa-suite-summary.json",
};
const childAssertions = [
  { id: "child-result", meaning: "the child owns its result", coverage: [] },
];

function childResult(
  params: Parameters<SuiteRunner>[0],
  scenario = makeScenario(context.selectedScenarios[0]!.id),
  result: Partial<ScenarioResult> = {},
) {
  return {
    ...artifacts,
    outputDir: params!.outputDir!,
    ...recordQaSuiteTestResults(
      params,
      [scenario],
      [{ name: scenario.id, status: "pass", steps: [], ...result }],
    ),
    startedScenarioIds: [scenario.id],
    watchUrl: lab.baseUrl,
  };
}

function runIsolated(params: RunParams, child: SuiteRunner) {
  return runQaFlowSuiteIsolated(params, context, child);
}
const logText = (writer: { mock: { calls: unknown[][] } }) => writer.mock.calls.flat().join("");
const logLines = (writer: Parameters<typeof logText>[0], prefix: string) =>
  logText(writer)
    .split("\n")
    .filter((line) => line.startsWith(prefix));

const entryStatuses = (evidence: Evidence) => evidence.entries.map(({ result }) => result.status);
const outcomeStatuses = (evidence: Evidence) =>
  projectQaEvidenceScenarioOutcomes(evidence).map(({ status }) => status);
const latestProgress = () => vi.mocked(lab.setScenarioRun).mock.calls.at(-1)?.[0];

function standardChild(runScenario: ScenarioRunner, startedAt = context.startedAt): SuiteRunner {
  return async (params) => {
    assert.ok(params?.outputDir, "expected owned child output");
    return runQaFlowSuiteStandard(
      params,
      { ...context, startedAt, outputDir: params.outputDir },
      runScenario,
    );
  };
}

function expectNotCleaned() {
  expect(disposeHarnesses).not.toHaveBeenCalled();
  expect(lab.stop).not.toHaveBeenCalled();
}

describe("isolated QA suite transport cleanup", () => {
  it.each(["missing child result", "rejected progress"] as const)(
    "records a parent failure after a pass: %s",
    async (failure) => {
      context.selectedScenarios[0]!.assertions = childAssertions;
      const snapshots: Evidence[] = [];
      const publicationError = new Error("progress publication rejected");
      if (failure === "rejected progress") {
        vi.mocked(lab.setScenarioRun).mockImplementation((next) => {
          if (next?.scenarios[0]?.status === "pass") {
            throw publicationError;
          }
        });
      }
      const runChild = vi.fn<SuiteRunner>(async (params) => {
        if (failure === "rejected progress") {
          return childResult(params, undefined, { name: "worker result" });
        }
        const child = await createQaSuiteEvidenceInvocation(params, {
          ...context,
          outputDir: params!.outputDir!,
        });
        await child.record(0, child.invocation.begin(0), {
          name: "child passed",
          status: "pass",
          steps: [],
        });
        return {
          ...artifacts,
          outputDir: params!.outputDir!,
          evidence: child.snapshot(),
          scenarios: [],
          startedScenarioIds: [context.selectedScenarios[0]!.id],
          watchUrl: lab.baseUrl,
        };
      });
      const result = await runIsolated(
        { lab, startLab: async () => lab, onEvidence: (summary) => snapshots.push(summary) },
        runChild,
      );
      expect(result.scenarios[0]?.status).toBe("fail");
      const final = snapshots.at(-1)!;
      const childId = final.entries[0]!.binding.occurrenceId;
      for (const occurrence of final.occurrences) {
        expect(occurrence.assertions).toEqual(
          failure === "missing child result" && occurrence.id === childId ? childAssertions : null,
        );
      }
      if (failure === "rejected progress") {
        expect(result.scenarios).toMatchObject([
          { status: "fail", details: publicationError.message },
        ]);
        expect(runChild).toHaveBeenCalledOnce();
        expect(disposeHarnesses).toHaveBeenCalledOnce();
      } else {
        expect(entryStatuses(final)).toEqual(["pass", "fail"]);
        expect(final.entries[1]?.coverage).toEqual([]);
        expect(projectQaEvidenceScenarioOutcomes(final)[0]).toMatchObject({
          status: "fail",
          occurrenceId: result.scenarios[0]!.evidenceOccurrenceId,
        });
        const childReceipt = final.occurrences
          .flatMap((occurrence) => occurrence.receipts)
          .find((receipt) => receipt.artifact.path.startsWith("scenarios/"));
        expect(childReceipt?.artifact.path).toContain(
          `scenarios/${final.occurrences[0]!.id}/artifacts/occurrences/`,
        );
      }
    },
  );

  it.each(["caught write failure", "queue rejection"] as const)(
    "drains siblings and queued artifacts after publication failure (%s)",
    async (partialOutcome) => {
      context.channelDriver = undefined;
      context.progressEnabled = true;
      context.concurrency = 3;
      context.selectedScenarios = ["completed", "failing", "inflight"].map((id) =>
        makeScenario(id),
      );
      const publicationError = new Error("evidence publication failed");
      const writeError = new Error("partial artifact write failed");
      const queueError = new Error("partial progress publication failed");
      const partialStarted = createDeferred<void>();
      const partialWrite = createDeferred<void>();
      const failWorker = createDeferred<void>();
      const failureSeen = createDeferred<void>();
      const sibling = createDeferred<void>();
      const siblingRecorded = createDeferred<void>();
      const allStarted = createDeferred<void>();
      const order: string[] = [];
      let latest: Evidence | undefined;
      let publicationFailed = false;
      const createTransport = suite.createQaSuiteTransportAdapter;
      vi.spyOn(suite, "createQaSuiteTransportAdapter").mockImplementation(async (params) => {
        const transport = await createTransport(params);
        return {
          ...transport,
          cleanupWithoutGateway: async () => {
            order.push("transport cleanup");
            await transport.cleanupWithoutGateway();
          },
        };
      });
      writeArtifacts.mockImplementationOnce(async () => {
        partialStarted.resolve();
        await partialWrite.promise;
        order.push("partial write settled");
        throw writeError;
      });
      let progressFailureReported = false;
      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        if (
          partialOutcome === "queue rejection" &&
          !progressFailureReported &&
          String(chunk).includes(writeError.message)
        ) {
          progressFailureReported = true;
          throw queueError;
        }
        return true;
      });
      disposeHarnesses.mockImplementationOnce(async () => {
        order.push("harness cleanup");
      });
      vi.mocked(lab.stop).mockImplementation(async () => {
        order.push("lab cleanup");
      });
      const runChild = vi.fn<SuiteRunner>(async (params) => {
        const id = params!.scenarioIds![0]!;
        if (runChild.mock.calls.length === 3) {
          allStarted.resolve();
        }
        if (id === "failing") {
          await failWorker.promise;
        }
        if (id === "inflight") {
          await sibling.promise;
          order.push("sibling settled");
        }
        return childResult(params, makeScenario(id));
      });
      let settled = false;
      const run = runIsolated(
        {
          startLab: async () => lab,
          workerStartStaggerMs: 0,
          onEvidence: (summary) => {
            latest = structuredClone(summary);
            if (
              !publicationFailed &&
              summary.entries.some((entry) => entry.test.id === "failing")
            ) {
              publicationFailed = true;
              failureSeen.resolve();
              throw publicationError;
            }
            if (summary.entries.some((entry) => entry.test.id === "inflight")) {
              siblingRecorded.resolve();
            }
          },
        },
        runChild,
      ).catch((error: unknown) => {
        settled = true;
        return error;
      });
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        await allStarted.promise;
        await partialStarted.promise;
        const firstReceipt = latest!.occurrences.flatMap((entry) => entry.receipts)[0]!;
        const artifactPath = path.join(context.outputDir, firstReceipt.artifact.path);
        const originalBytes = await fs.readFile(artifactPath);
        failWorker.resolve();
        await failureSeen.promise;
        await tick();
        expect(settled).toBe(false);
        expectNotCleaned();
        if (partialOutcome === "queue rejection") {
          // Reject while the sibling still runs, before finally can await the queue.
          partialWrite.resolve();
          await tick();
          expect(order).toEqual(["partial write settled"]);
          expect(settled).toBe(false);
          expectNotCleaned();
          expect(unhandled).not.toHaveBeenCalled();
        }
        sibling.resolve();
        await siblingRecorded.promise;
        if (partialOutcome !== "queue rejection") {
          await tick();
          expect(settled).toBe(false);
          expectNotCleaned();
          partialWrite.resolve();
        }
        const error = await run;
        if (partialOutcome === "queue rejection") {
          expect(error).toBeInstanceOf(AggregateError);
          expect((error as AggregateError).errors).toEqual([publicationError, queueError]);
          expect((error as AggregateError).cause).toBe(publicationError);
          expect((error as Error).message).toContain("partial artifacts");
        } else {
          expect(error).toBe(publicationError);
        }
        expect(logText(stderrWrite)).toContain(writeError.message);
        expect(order).toEqual([
          ...(partialOutcome === "queue rejection"
            ? ["partial write settled", "sibling settled"]
            : ["sibling settled", "partial write settled"]),
          "transport cleanup",
          "harness cleanup",
          "lab cleanup",
        ]);
        expect(writeArtifacts).toHaveBeenCalledTimes(partialOutcome === "queue rejection" ? 1 : 2);
        expect(entryStatuses(latest!)).toEqual(["pass", "pass", "pass"]);
        expect(new Set(latest!.entries.map((entry) => entry.binding.occurrenceId)).size).toBe(3);
        expect(outcomeStatuses(latest!)).toEqual(["pass", "pass", "pass"]);
        expect(await fs.readFile(artifactPath)).toEqual(originalBytes);
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    },
  );

  it("keeps out-of-order progress times while draining partial artifacts before cleanup", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = (second: number) => new Date(Date.UTC(2026, 7, 4, 0, 0, second));
    vi.setSystemTime(at(0));
    context.concurrency = 2;
    context.selectedScenarios = ["first", "second"].map((id) => {
      const scenario = makeScenario(id);
      scenario.title = `Catalog ${id}`;
      return scenario;
    });
    const snapshots: Parameters<QaLabServerHandle["setScenarioRun"]>[0][] = [];
    const completed = [createDeferred<void>(), createDeferred<void>()];
    vi.mocked(lab.setScenarioRun).mockImplementation((next) => {
      snapshots.push(structuredClone(next));
      next?.scenarios.forEach((scenario, index) => {
        if (scenario.status === "pass") {
          completed[index]!.resolve();
        }
      });
    });
    const workers = [
      createDeferred<Awaited<ReturnType<SuiteRunner>>>(),
      createDeferred<Awaited<ReturnType<SuiteRunner>>>(),
    ];
    const allStarted = createDeferred<void>();
    const runChild = vi.fn<SuiteRunner>(() => {
      if (runChild.mock.calls.length === 2) {
        allStarted.resolve();
      }
      return workers[runChild.mock.calls.length - 1]!.promise;
    });
    const partialWrite = createDeferred<void>();
    writeArtifacts.mockImplementationOnce(async (params) => {
      await partialWrite.promise;
      return { ...artifacts, evidence: params.recordedEvidence };
    });
    disposeHarnesses.mockImplementationOnce(async () => {
      expect(writeArtifacts).toHaveBeenCalledTimes(2);
      expect(snapshots.at(-1)?.status).toBe("running");
      vi.setSystemTime(at(10));
    });
    const results: ScenarioResult[] = [
      { name: "result first", status: "pass", steps: [] },
      {
        name: "result second",
        status: "pass",
        details: "",
        steps: [{ name: "check", status: "pass" }],
      },
    ];
    const run = runIsolated({ lab, startLab: async () => lab, workerStartStaggerMs: 0 }, runChild);
    await allStarted.promise;
    for (const index of [1, 0]) {
      vi.setSystemTime(at(2 - index));
      workers[index]!.resolve(
        childResult(
          runChild.mock.calls[index]![0],
          context.selectedScenarios[index]!,
          results[index]!,
        ),
      );
      await completed[index]!.promise;
    }
    expect(writeArtifacts).toHaveBeenCalledOnce();
    expect(disposeHarnesses).not.toHaveBeenCalled();
    partialWrite.resolve();
    const result = await run;

    const recordedResults = results.map((scenarioResult) => ({
      ...scenarioResult,
      evidenceOccurrenceId: expect.any(String),
    }));
    expect(result.scenarios).toEqual(recordedResults);
    expect(
      snapshots.map((snapshot) => snapshot?.scenarios.map((scenario) => scenario.status)),
    ).toEqual([
      ["pending", "pending"],
      ["running", "pending"],
      ["running", "running"],
      ["running", "pass"],
      ["pass", "pass"],
      ["pass", "pass"],
    ]);
    expect(snapshots.at(-1)).toStrictEqual({
      kind: "suite",
      status: "completed",
      startedAt: at(0).toISOString(),
      finishedAt: at(10).toISOString(),
      scenarios: context.selectedScenarios.map((scenario, index) => ({
        id: scenario.id,
        name: scenario.title,
        status: "pass",
        details: results[index]!.details,
        steps: results[index]!.steps,
        startedAt: at(0).toISOString(),
        finishedAt: at(2 - index).toISOString(),
      })),
    });
    expect(writeArtifacts.mock.calls.map(([params]) => [params.status, params.scenarios])).toEqual([
      ["running", [recordedResults[1]]],
      ["running", recordedResults],
      [undefined, recordedResults],
    ]);
    expect(disposeHarnesses.mock.invocationCallOrder[0]).toBeLessThan(
      writeArtifacts.mock.invocationCallOrder[2]!,
    );
    expect(vi.mocked(lab.setLatestReport).mock.invocationCallOrder.at(-1)!).toBeLessThan(
      vi.mocked(lab.setScenarioRun).mock.invocationCallOrder.at(-1)!,
    );
  });

  it("records a rejected dispatched worker and leaves the fail-fast tail unstarted", async () => {
    context.progressEnabled = true;
    context.selectedScenarios.push(makeScenario("never-started"));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runChild = vi
      .fn<SuiteRunner>()
      .mockRejectedValueOnce(new Error("isolated worker gateway failed"));

    const result = await runIsolated({ failFast: true, lab, startLab: async () => lab }, runChild);
    expect(logText(stderrWrite)).toContain(
      "scenario fail (1/2): leased-channel-scenario — isolated scenario worker: isolated worker gateway failed",
    );

    expect(runChild).toHaveBeenCalledOnce();
    expect(result.startedScenarioIds).toEqual([leasedId]);
    expect(result.scenarios).toMatchObject([
      {
        name: leasedId,
        status: "fail",
        details: "isolated worker gateway failed",
      },
    ]);
    expect(latestProgress()).toMatchObject({
      status: "completed",
      scenarios: [
        { id: leasedId, status: "fail" },
        { id: "never-started", status: "pending" },
      ],
    });
    expect(writeArtifacts).toHaveBeenLastCalledWith(
      expect.objectContaining({ scenarios: result.scenarios }),
    );
  });

  it("leaves only running progress when parent cleanup fails after worker completion", async () => {
    const release = vi.fn(async () => {});
    const factory: QaTransportAdapterFactory = {
      id: "leased",
      matches: ({ channelId, driver }) => channelId === "leased" && driver === "live",
      async create() {
        return {
          id: "leased",
          label: "Leased channel",
          accountId: "sut",
          requiredPluginIds: [],
          supportedActions: [],
          sendInbound: async (input) => lab.state.addInboundMessage(input),
          createGatewayConfig: () => ({}),
          async waitReady() {},
          buildAgentDelivery: ({ target }) => ({
            channel: "leased",
            to: target,
            replyChannel: "leased",
            replyTo: target,
          }),
          async handleAction() {},
          createReportNotes: () => [],
          cleanup: release,
        };
      },
    };
    const cleanupError = new Error("agent harness disposal failed");
    disposeHarnesses.mockRejectedValueOnce(cleanupError);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runChild = vi.fn<SuiteRunner>(async (params) => childResult(params));
    context.progressEnabled = true;

    const thrown = await runIsolated(
      {
        adapterFactories: [factory],
        channelDriver: "live",
        channelId: "leased",
        startLab: async () => lab,
      },
      runChild,
    ).catch((error: unknown) => error);

    expect(release).toHaveBeenCalledOnce();
    expect(disposeHarnesses).toHaveBeenCalledOnce();
    expect(lab.stop).toHaveBeenCalledOnce();
    expect(lab.setLatestReport).toHaveBeenCalledWith(
      expect.objectContaining({ outputPath: "/qa-output/qa-suite-report.md" }),
    );
    expect(writeArtifacts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ status: "running", writeEvidenceFile: false }),
    );
    expect(lab.setScenarioRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "completed" }),
    );
    expect((thrown as Error).message.split("\n")[0]).toBe(
      "QA scenarios passed, but cleanup failed",
    );
    expect((thrown as Error).message).toContain(
      "failed cleanup phases: agent harnesses: agent harness disposal failed",
    );
    expect((thrown as Error).cause).toBe(cleanupError);
    expect(logText(stderrWrite)).not.toContain("run complete");
  });

  it("preserves nested publication ownership through concurrent worker runtime preparation", async () => {
    vi.stubEnv("OPENCLAW_QA_SUITE_PROGRESS", "1");
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    const bothWorkersStarted = createDeferred<void>();
    const firstScenarioStarted = createDeferred<void>();
    const bothScenarioExecutionsStarted = createDeferred<void>();
    context.channelDriver = "crabline";
    context.concurrency = 2;
    context.progressEnabled = true;
    context.selectedScenarios = nestedIds.map((id) => makeScenario(id));
    const runScenario = vi.fn<ScenarioRunner>(async (_env, scenario) => {
      if (scenario.id === nestedIds[0]) {
        firstScenarioStarted.resolve();
        await bothScenarioExecutionsStarted.promise;
      } else {
        bothScenarioExecutionsStarted.resolve();
      }
      return { name: scenario.title, status: "pass", steps: [] };
    });
    vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
      agentIdentityMarkdown: "test",
      kickoffTask: "test",
      scenarios: context.selectedScenarios,
    });
    vi.spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime").mockImplementation(runScenario);
    const runChild = vi.fn<SuiteRunner>(async (params) => {
      if (!params) {
        throw new Error("expected nested standard run params");
      }
      activeWorkers += 1;
      maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
      if (activeWorkers === 2) {
        bothWorkersStarted.resolve();
      }
      await bothWorkersStarted.promise;
      const scenarioId = params.scenarioIds?.[0] ?? "missing-scenario";
      if (scenarioId === nestedIds[1]) {
        await firstScenarioStarted.promise;
      }
      try {
        return await runQaFlowSuiteFromRuntime(params);
      } finally {
        activeWorkers -= 1;
      }
    });

    const result = await runIsolated(
      {
        channelDriver: "crabline",
        channelId: "telegram",
        lab,
        startLab: async () => createCleanupTestLab(),
      },
      runChild,
    );

    expect(maxActiveWorkers).toBe(2);
    expect(result.scenarios).toMatchObject(nestedIds.map((name) => ({ name, status: "pass" })));
    expect(runScenario).toHaveBeenCalledTimes(2);
    expect(logLines(stderrWrite, "[qa-suite] run complete")).toEqual(["[qa-suite] run complete"]);
    expect(captureArtifacts).toHaveBeenCalledOnce();
    const finalArtifacts = writeArtifacts.mock.calls.at(-1)?.[0];
    expect(finalArtifacts).toMatchObject({
      channel: "telegram",
      channelDriver: "crabline",
      transportArtifacts: {
        artifacts: [
          { kind: "channel-capability-matrix", path: "capabilities.json" },
          { kind: "channel-driver-smoke", path: "readiness.json" },
        ],
      },
    });
    for (const [nonFinalArtifacts] of writeArtifacts.mock.calls.slice(0, -1)) {
      expect(nonFinalArtifacts.transportArtifacts).toBeUndefined();
    }
  });
});

describe("isolated QA suite nested publication", () => {
  it("retains a failed parent history when the continued isolated child is skipped", async () => {
    context.channelDriver = undefined;
    const scenario = context.selectedScenarios[0]!;
    assert.ok(scenario.execution.kind === "flow");
    scenario.execution.retryCount = 0;
    scenario.assertions = [
      {
        id: "child-result",
        meaning: "the child owns this scenario assertion",
        coverage: [{ id: "qa.coverage", role: "primary" }],
      },
    ];
    writeArtifacts.mockImplementation(async (params) => ({
      evidence: params.recordedEvidence,
      evidencePath: path.join(params.outputDir, "qa-evidence.json"),
      summaryPath: path.join(params.outputDir, "qa-suite-summary.json"),
      reportPath: path.join(params.outputDir, "qa-suite-report.md"),
      report: "",
    }));
    let nextStatus: "pass" | "fail" | "skip" = "fail";
    const runScenario = vi.fn<ScenarioRunner>().mockImplementation(async () => ({
      name: context.selectedScenarios[0]!.title,
      status: nextStatus,
      steps: [],
      details: nextStatus === "fail" ? "original child failure" : "later child result",
    }));
    const runChild = standardChild(runScenario);
    const params = { evidenceMode: "slim" as const, startLab: async () => createCleanupTestLab() };
    const first = await runIsolated(params, runChild);
    assert.equal(first.evidence.schemaVersion, 3);
    const original = structuredClone(first.evidence);
    const observations = original.occurrences.filter(
      (item) => item.scenario?.kind === "observation",
    );
    expect(observations).toHaveLength(2);
    expect(observations.every((item) => item.terminalStatus === "fail")).toBe(true);
    for (const observation of observations) {
      const isChild = first.evidence.entries.some(
        (entry) => entry.binding.occurrenceId === observation.id,
      );
      expect(observation.assertions).toEqual(isChild ? scenario.assertions : null);
    }
    const retainedArtifacts = await Promise.all(
      observations.flatMap((item) =>
        item.receipts.map(async ({ artifact }) => ({
          artifact,
          bytes: await fs.readFile(path.resolve(context.outputDir, artifact.path)),
        })),
      ),
    );
    nextStatus = "skip";
    const continued = await runIsolated(
      {
        ...params,
        evidenceAnchors: original.occurrences.filter((item) => item.scenario?.kind === "instance"),
        evidenceContinuation: original,
      },
      runChild,
    );
    assert.equal(continued.evidence.schemaVersion, 3);
    expect(runScenario).toHaveBeenCalledTimes(2);
    expect(continued.scenarios[0]?.status).toBe("fail");
    expect(projectQaEvidenceScenarioOutcomes(continued.evidence)[0]?.status).toBe("fail");
    expect(continued.scenarios[0]).toEqual(first.scenarios[0]);
    for (const occurrence of observations) {
      expect(continued.evidence.occurrences.find((item) => item.id === occurrence.id)).toEqual(
        occurrence,
      );
    }
    for (const { artifact, bytes } of retainedArtifacts) {
      expect(await fs.readFile(path.resolve(context.outputDir, artifact.path))).toEqual(bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
    }
    expect(first.evidence).toEqual(original);
  });

  it("preserves repeated isolated starts and independent progress slots", async () => {
    context.concurrency = 1;
    context.selectedScenarios = [makeScenario("same"), makeScenario("same")];
    let calls = 0;
    const runChild = vi.fn<SuiteRunner>(async (params) => {
      calls += 1;
      return childResult(params, makeScenario("same"), { status: calls === 1 ? "fail" : "pass" });
    });
    const result = await runIsolated(
      { lab, startLab: async () => createCleanupTestLab() },
      runChild,
    );
    expect(new Set(runChild.mock.calls.map(([params]) => params?.outputDir)).size).toBe(2);
    expect(result.startedScenarioIds).toEqual(["same", "same"]);
    expect(result.scenarios.map((item) => item.status)).toEqual(["fail", "pass"]);
    expect(latestProgress()?.scenarios.map((item) => item.status)).toEqual(["fail", "pass"]);
  });

  it("prints bounded and redacted nested failure progress before artifacts", async () => {
    const labs = [lab, createCleanupTestLab()];
    let nextLab = 0;
    const startLab = vi.fn(async () => labs[nextLab++]!);
    context.channelDriver = undefined;
    context.progressEnabled = true;
    const scenario = context.selectedScenarios[0]!;
    if (scenario.execution.kind === "flow") {
      scenario.execution.retryCount = 0;
    }
    const scenarioStatus = "fail";
    const secret = "synthetic-secret-".repeat(60);
    const details = `verification refused\napiKey="${secret}"\r::error::fixture\n${"🦞".repeat(400)}`;
    const scenarioResult = {
      name: leasedId,
      status: scenarioStatus,
      details: "unrelated scenario metadata",
      steps: [{ name: "Verify\nrequest", status: "fail", details }],
    } satisfies ScenarioResult;
    const runScenario = vi.fn<ScenarioRunner>().mockResolvedValue(scenarioResult);
    const runChild = standardChild(runScenario, new Date("2026-08-04T00:00:01.000Z"));
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const assertScenarioProgress = (expectedCount: number) => {
      const lines = logLines(stderrWrite, `[qa-suite] scenario ${scenarioStatus} (`);
      expect(lines).toHaveLength(expectedCount);
      for (const line of lines) {
        const prefix = `[qa-suite] scenario ${scenarioStatus} (1/1): leased-channel-scenario`;
        expect(line).toContain("Verify request: verification refused");
        expect(line).toContain("apiKey=<redacted>");
        expect(line).toContain(": :error::fixture");
        expect(line).not.toContain("synthetic-secret");
        expect(line).not.toContain("unrelated scenario metadata");
        expect(line).not.toMatch(/[\r\n]/u);
        expect(line.slice(prefix.length)).toMatch(/^ — /u);
        expect(line.slice(prefix.length + " — ".length).length).toBeLessThanOrEqual(512);
        expect(line.endsWith("…")).toBe(true);
        expect(Buffer.from(line).toString("utf8")).toBe(line);
      }
    };
    writeArtifacts.mockImplementationOnce(async (params) => {
      assertScenarioProgress(1);
      return { ...artifacts, evidence: params.recordedEvidence };
    });

    const result = await runIsolated({ startLab }, runChild);
    assertScenarioProgress(2);
    expect(result.scenarios).toEqual([
      { ...scenarioResult, evidenceOccurrenceId: expect.any(String) },
    ]);

    const completionLines = logLines(stderrWrite, "[qa-suite] run complete");
    expect(completionLines).toEqual(["[qa-suite] run complete"]);
    expect(runScenario).toHaveBeenCalledOnce();
    for (const nestedLab of labs) {
      expect(nestedLab.stop).toHaveBeenCalledOnce();
    }
  });
});

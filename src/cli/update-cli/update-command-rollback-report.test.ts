import { confirm as clackConfirm, isCancel } from "@clack/prompts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTriageTerminal } from "../../commands/triage.test-support.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import {
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
  UpdateCommandPendingRecoveryFailure,
} from "./update-command-result.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

const mocks = vi.hoisted(() => ({
  select: vi.fn<(options: unknown) => Promise<string | symbol>>(),
  confirm: vi.fn<() => Promise<boolean | symbol>>(),
  prepare:
    vi.fn<typeof import("../../infra/update-failure-report.js").prepareUpdateFailureReport>(),
  submit: vi.fn<typeof import("../../infra/update-failure-report.js").submitUpdateFailureReport>(),
  triage: vi.fn(),
}));

vi.mock("../../commands/configure.shared.js", () => ({
  select: mocks.select,
  confirm: mocks.confirm,
}));
vi.mock("../../infra/update-failure-report.js", () => ({
  prepareUpdateFailureReport: mocks.prepare,
  submitUpdateFailureReport: mocks.submit,
}));
vi.mock("../../infra/update-triage.js", () => ({
  prepareUpdateFailureTriage: async () => mocks.triage,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runId = "b89e301f-2df4-4dd8-a7ea-4f4b4e10b6f3";

function setup() {
  const stateDir = tempDirs.make("openclaw-rollback-report-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const failure = new UpdateCommandFailure({
    runId,
    status: "error",
    mode: "npm",
    reason: "restart-unhealthy",
    steps: [],
    durationMs: 1,
    recovery: {
      serviceRestartSafe: true,
      packageRollbackVerified: true,
      service: "healthy",
    },
  });
  const result = failure.result;
  const prepared = {
    attemptId: runId,
    body: "Sanitized failure and rollback details",
    previewDigest: "a".repeat(64),
    marker: `openclaw-report:${"b".repeat(64)}`,
    browserFallback: {
      status: "available" as const,
      url: "https://github.com/openclaw/openclaw/issues/new",
    },
    savedReportPath: `${stateDir}/report.md`,
    title: "Update failed: restart-unhealthy",
  };
  mocks.prepare.mockResolvedValue(prepared);
  mocks.submit.mockResolvedValue({
    savedReportPath: prepared.savedReportPath,
    status: "created",
    url: "https://github.com/openclaw/openclaw/issues/123",
  });
  const opts = { run: { runId, env } };
  const target = { env };
  const run = (Failure?: new (result: UpdateRunResult) => UpdateCommandFailure) =>
    withTriageTerminal(true, async () => {
      await expect(
        withUpdateFailureTriage(opts, target, async () => {
          throw Failure ? new Failure(result) : failure;
        }),
      ).rejects.toMatchObject({ code: 1 });
    });
  return { env, opts, prepared, result, run, target };
}

function expectUnused(...actions: (keyof typeof mocks)[]) {
  for (const action of actions) {
    expect(mocks[action]).not.toHaveBeenCalled();
  }
}

let f: ReturnType<typeof setup>;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.select.mockResolvedValue("dismiss");
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => undefined);
  f = setup();
});

afterEach(() => vi.restoreAllMocks());

it("offers an optional report, previews it, and submits once only after confirmation", async () => {
  mocks.select.mockImplementation(async () => {
    expectUnused("prepare", "submit");
    return "report";
  });
  mocks.confirm.mockImplementation(async () => {
    expect(defaultRuntime.log).toHaveBeenCalledWith(f.prepared.body);
    expect(mocks.submit).not.toHaveBeenCalled();
    return true;
  });

  await f.run();

  expect(mocks.select).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      message: expect.stringContaining("rollback completed"),
      initialValue: "dismiss",
      options: [
        { value: "triage", label: "Diagnose update failure" },
        { value: "report", label: "Report update failure" },
        { value: "dismiss", label: "Exit" },
      ],
    }),
  );
  expect(mocks.prepare).toHaveBeenCalledExactlyOnceWith(
    { attemptId: runId, action: "cli", result: f.result, recordedRun: undefined },
    { env: f.env, stateDir: f.env.OPENCLAW_STATE_DIR },
  );
  expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ initialValue: false }),
  );
  expect(mocks.submit).toHaveBeenCalledExactlyOnceWith(f.prepared, f.prepared.previewDigest, {
    env: f.env,
    stateDir: f.env.OPENCLAW_STATE_DIR,
    allowBrowserFallback: false,
  });
  expect(mocks.triage).not.toHaveBeenCalled();
  expect(f.result.status).toBe("error");
  expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
});

it("does not submit when confirmation is cancelled", async () => {
  mocks.select.mockResolvedValue("report");
  const cancelled = await clackConfirm({
    message: "Cancelled fixture",
    signal: AbortSignal.abort(),
  });
  expect(isCancel(cancelled)).toBe(true);
  mocks.confirm.mockResolvedValue(cancelled);

  await f.run();

  expect(defaultRuntime.log).toHaveBeenCalledWith(f.prepared.body);
  expect(defaultRuntime.log).toHaveBeenCalledWith("Update failure report cancelled.");
  expectUnused("submit", "triage");
});

it("diagnoses the original failure only when selected", async () => {
  mocks.select.mockResolvedValue("triage");

  await f.run();

  expect(mocks.triage).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ failure: { result: f.result }, target: f.target }),
  );
  expectUnused("prepare", "submit");
});

it("keeps signal-cancelled rollback quiet", async () => {
  f.result.steps.push({
    name: "update",
    command: "synthetic-update",
    cwd: "/synthetic",
    durationMs: 1,
    exitCode: 130,
    termination: "signal",
  });
  await f.run();
  expectUnused("select", "prepare", "submit", "triage");
});

it("keeps ordinary failure actions for an unverified service", async () => {
  f.result.recovery = { ...f.result.recovery, service: undefined };
  await f.run();
  expect(mocks.select).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: "Choose the next action for this failed update" }),
  );
  expect(mocks.select.mock.calls[0]?.[0]).not.toHaveProperty("initialValue", "dismiss");
});

it.each([UpdateCommandPendingRecoveryFailure, UpdateCommandFinalizedRecoveryFailure])(
  "preserves the legacy recovery marker exit without a menu (%s)",
  async (Failure) => {
    await f.run(Failure);

    expectUnused("select", "triage");
  },
);

it("does not prompt after a successful update", async () => {
  await withTriageTerminal(true, async () => {
    await withUpdateFailureTriage(f.opts, f.target, async () => {});
  });

  expectUnused("select", "triage");
});

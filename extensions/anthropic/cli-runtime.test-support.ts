import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionCapability,
  CliBackendLiveSessionHandle,
  CliBackendPreparedExecution,
} from "openclaw/plugin-sdk/cli-backend";
import { expect, vi } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import type { ClaudeCliSecretInput } from "./cli-process.js";
import { executeClaudeCli } from "./cli.runtime.js";

export async function collectClaudeCli(
  context: CliBackendExecuteContext,
  secretInput?: Parameters<typeof executeClaudeCli>[1],
  execute = executeClaudeCli,
) {
  const records: Record<string, unknown>[] = [];
  for await (const record of execute(context, secretInput)) {
    records.push(record);
  }
  return records;
}

export function createCliTestHarness(prefix = "openclaw-claude-stderr-") {
  const roots: string[] = [];
  const handles = new Set<CliBackendLiveSessionHandle>();
  return {
    async context(
      source: string,
      overrides: Partial<CliBackendExecuteContext> = {},
      env: Record<string, string> = {},
    ): Promise<CliBackendExecuteContext> {
      const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
      roots.push(root);
      const command = path.join(root, "claude.mjs");
      await writeFile(command, source);
      return {
        command: process.execPath,
        args: [command],
        cwd: root,
        env: { PATH: process.env.PATH ?? "", HOME: root, CLAUDE_CONFIG_DIR: root, ...env },
        prompt: "Synthetic subprocess diagnostic probe.",
        systemPrompt: "Synthetic subprocess diagnostic probe.",
        modelId: "claude-sonnet-4-6",
        useResume: false,
        timeoutMs: 10_000,
        abortSignal: AbortSignal.timeout(10_000),
        requestToolPermission: async () => ({
          behavior: "deny",
          message: "No tools in this probe.",
        }),
        requestUserInput: async () => ({ status: "cancelled", message: "No input in this probe." }),
        ...overrides,
      };
    },
    liveSession(cleanup?: () => Promise<void>): CliBackendLiveSessionCapability {
      let current: CliBackendLiveSessionHandle | undefined;
      let retiredCleanup: Promise<void> | undefined;
      return {
        fingerprint: "synthetic-process-policy",
        current: () => current,
        restart: async () => {
          const previous = current;
          previous?.close("restart");
          await previous?.waitForExit();
          await retiredCleanup;
        },
        register: (handle) => {
          if (retiredCleanup) {
            throw new Error("Previous CLI live session cleanup has not settled.");
          }
          current = handle;
          handles.add(handle);
        },
        activate: () => {},
        remove: (handle) => {
          if (current !== handle) {
            return;
          }
          current = undefined;
          if (cleanup) {
            retiredCleanup = handle
              .waitForExit()
              .then(cleanup)
              .then(() => {
                retiredCleanup = undefined;
              });
          }
        },
      };
    },
    async cleanup() {
      for (const handle of handles) {
        handle.close("restart");
        await handle.waitForExit();
      }
      handles.clear();
      await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
    },
  };
}

export async function prepareClaudeCli(
  context: CliBackendExecuteContext,
  authCredential: { type: "token"; token: string } | { type: "api_key"; key: string },
  backend = buildAnthropicCliBackend(),
) {
  const prepared = (await backend.prepareExecution?.({
    workspaceDir: context.cwd,
    provider: "claude-cli",
    modelId: context.modelId,
    executionMode: "agent",
    authCredential,
  } as Parameters<NonNullable<typeof backend.prepareExecution>>[0])) as
    | (CliBackendPreparedExecution & { secretInput?: ClaudeCliSecretInput })
    | undefined;
  if (!prepared?.execute || !prepared.secretInput || !prepared.cleanup) {
    throw new Error("Expected provider-owned credential execution.");
  }
  return {
    ...prepared,
    execute: prepared.execute,
    secretInput: prepared.secretInput,
    cleanup: prepared.cleanup,
  };
}

export function recordCredentialBuffers(input: ClaudeCliSecretInput) {
  const buffers: Buffer[] = [];
  const createData = input.createData;
  vi.spyOn(input, "createData").mockImplementation(() => {
    const bytes = createData();
    buffers.push(bytes);
    return bytes;
  });
  return buffers;
}

// The transport joins its root and signal dispatch, not foreign descendant extinction.
export async function waitForProcessExit(pids: number[], signal: AbortSignal): Promise<void> {
  try {
    for (;;) {
      if (
        pids.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        })
      ) {
        return;
      }
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (cause) {
    throw new Error(`Claude process tree ${pids.join(", ")} did not exit before the test aborted`, {
      cause,
    });
  }
}

export function resultDetail(records: Record<string, unknown>[]): Record<string, unknown> {
  const result = records.findLast((record) => record.type === "result");
  expect(result).toMatchObject({ subtype: "success", result: expect.any(String) });
  return JSON.parse(String(result?.result)) as Record<string, unknown>;
}

export const CLAUDE_PROTOCOL_FIXTURE = String.raw`
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
writeFileSync("fixture.pid", String(process.pid));
const scenario = process.env.CLAUDE_FIXTURE_SCENARIO;
const replayReceipts = process.env.CLAUDE_FIXTURE_REPLAY_RECEIPTS !== "0";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const request = (id, request) => send({ type: "control_request", request_id: id, request });
const system = (subtype, detail = {}) => send({ type: "system", subtype, ...detail });
const lifecycle = (state, command_uuid) => send({ type: "command_lifecycle", state, command_uuid });
const tasks = (tasks) => system("background_tasks_changed", { tasks });
const ready = (name) => {
  writeFileSync(name, "ready");
  sendReceipt(path.join(process.cwd(), name), "ready");
};
const promptHook = (id, prompt) => request(id, {
  subtype: "hook_callback", callback_id: hooks.UserPromptSubmit[0].hookCallbackIds[0],
  input: { hook_event_name: "UserPromptSubmit", prompt },
});
let hooks;
let initialize;
let turn = 0;
let user;
let privateContext;
let lateDecision;
let pendingInputUuid;
let firstInputUuid;
let injectedContext;
let injectedRerunContext;
const priorResponses = {};
let credentialProof;
let shutdownDescendant;
if (scenario === "shutdown-ignore" || scenario === "shutdown-eof") {
  if (scenario === "shutdown-ignore") {
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  } else {
    process.stdin.once("end", () => process.exit(0));
  }
  const descendant = spawn(process.execPath, ["-e",
    'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); process.stdout.write("ready");'],
    { stdio: ["ignore", "pipe", "ignore"] });
  await once(descendant.stdout, "data");
  descendant.stdout.destroy();
  descendant.unref();
  shutdownDescendant = descendant.pid;
}
if (scenario === "credential-tree") {
  const descriptor = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR ?? process.env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR;
  const bytes = readFileSync(process.platform === "win32" ? 3 : process.platform === "darwin" ? "/dev/fd/3" : "/proc/self/fd/3");
  assert.equal(readFileSync(3).length, 0);
  const text = bytes.toString("utf8");
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  credentialProof = { descriptor, digest: createHash("sha256").update(bytes).digest("hex"),
    credentialInArgs: process.argv.some((arg) => arg.includes(text)),
    credentialInEnv: Object.values(process.env).includes(text), descendantPid: descendant.pid };
  bytes.fill(0);
}
const questionInput = { questions: [{
  header: "Approach", question: "Which path should Claude take?",
  options: [{ label: "Shared flow", description: "Use the existing behavior." },
    { label: "Separate flow", description: "Use a different behavior." }],
  multiSelect: false,
}] };
const firstSeenBackground = scenario === "background-bash-first-seen";
const explicitBackground = process.env.CLAUDE_FIXTURE_EXPLICIT_BACKGROUND === "1";
const nativeToolName = scenario === "user-question" ? "AskUserQuestion" : scenario === "mcp-hook" ? "mcp__openclaw__message" : firstSeenBackground ? "Bash" : "Read";
const nativeToolInput = scenario === "user-question" ? questionInput : firstSeenBackground ? { command: "synthetic long command", run_in_background: explicitBackground } : { file_path: "fixture.txt" };
const result = (detail = {}) => send({
  type: "result", subtype: "success", is_error: false,
  result: JSON.stringify({ pid: process.pid, turn, user, privateContext, injectedRerunContext, initialize, argv: process.argv.slice(2), ...detail }),
  session_id: "fixture-session",
  ...(detail.injectedContext ? { user_message_uuid: pendingInputUuid } : {}),
  ...((!replayReceipts || scenario === "background-bash-overlap") && detail.finalBackgroundAnswer ? {
    origin: { kind: "task-notification", producer: "session-task" }, num_turns: 1, stop_reason: "end_turn",
  } : {}),
});
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "initialize") {
    initialize = message.request;
    hooks = initialize.hooks;
    if (scenario === "revoked-initialize") {
      ready("initialize.ready");
      while (!existsSync("initialize.release")) await delay(5);
    }
    assert.ok(hooks.PreToolUse[0].hookCallbackIds[0]);
    assert.ok(hooks.UserPromptSubmit[0].hookCallbackIds[0]);
    send({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { commands: [], models: [] },
    } });
  } else if (message.type === "user") {
    assert.ok(hooks);
    turn++;
    user = message.message.content;
    writeFileSync("user.received", user);
    if (scenario === "credential-tree") {
      system("fixture_credential", { pid: process.pid, ...credentialProof });
      continue;
    }
    if (scenario === "shutdown-ignore" || scenario === "shutdown-eof") {
      system("fixture_shutdown", { pid: process.pid, descendantPid: shutdownDescendant });
      continue;
    }
    if (scenario === "mcp-elicitation") {
      request("elicitation", { subtype: "elicitation", mcp_server_name: "fixture",
        message: "Choose a fixture option", requested_schema: { type: "object" } });
      continue;
    }
    if (scenario?.startsWith("steer-")) {
      if (turn === 1) {
        firstInputUuid = message.uuid;
        lifecycle("started", message.uuid);
        system("init", { capabilities: ["msg_lifecycle_v1"] });
        if (scenario === "steer-prompt-pending") continue;
        promptHook("admitted-context", user);
        continue;
      }
      pendingInputUuid = message.uuid;
      if (scenario === "steer-after-result") {
        result({ interim: true });
        lifecycle("completed", firstInputUuid);
      }
      if (scenario !== "steer-refused") lifecycle("queued", message.uuid);
      if (scenario === "steer-exit") {
        process.exit(1);
      }
      if (["steer-cancelled", "steer-discarded", "steer-refused", "steer-completed"].includes(scenario)) {
        // Terminal receipts may omit started; only completed proves consumption.
        result();
        lifecycle("completed", firstInputUuid);
        lifecycle(scenario.slice("steer-".length), message.uuid);
        continue;
      }
      promptHook("injected-context", user);
      continue;
    }
    if (scenario === "input-lifecycle") {
      if (turn > 1) {
        pendingInputUuid = message.uuid;
        send({ type: "result", subtype: "success", user_message_uuid: "prior-turn", result: "stale replay", session_id: "fixture-session" });
        lifecycle("started", "unrelated-uuid");
        send({ type: "stream_event", user_message_uuid: "prior-turn", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "stale text" } } });
        send({ type: "assistant", user_message_uuid: "prior-turn", message: { role: "assistant", content: [{ type: "text", text: "stale text" }] } });
        request("prior-pre", { subtype: "hook_callback", callback_id: hooks.PreToolUse[0].hookCallbackIds[0],
          input: { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "prior-turn.txt" } },
          tool_use_id: "prior-tool" });
        request("prior-permission", { subtype: "can_use_tool", tool_name: "Read",
          input: { file_path: "prior-turn.txt" }, tool_use_id: "prior-tool" });
        promptHook("prior-context", "prior user input");
      } else {
        lifecycle("started", message.uuid);
        system("init", { capabilities: ["msg_lifecycle_v1"] });
        result({ matchedInputUuid: message.uuid });
      }
      continue;
    }
    if (scenario === "background-bash-late-approval" && turn > 1) {
      system("fixture_second_turn");
      if (lateDecision) result({ lateDecision });
      continue;
    }
    if (scenario === "missing-result") {
      process.stderr.write("PermissionError: fixture cannot read its input\n", () => process.exit(1));
      continue;
    }
    if (scenario === "background-success" || scenario === "background-agent-subagent-bash") {
      const subagentBash = scenario === "background-agent-subagent-bash";
      tasks([{ task_id: "background-agent", task_type: "local_agent" }]);
      send({ type: "result", subtype: "success", is_error: false, result: "", session_id: "fixture-session" });
      // Claude Code 2.1.289: the agent's own Bash reports on the main stream, owner field only on its start.
      if (subagentBash) system("task_started", { task_id: "subagent-bash", task_type: "local_bash", is_backgrounded: false, owned_by_subagent: true, tool_use_id: "tool-subagent-bash" });
      request("background-release", { subtype: "can_use_tool", tool_name: "Read",
        input: { file_path: "fixture.txt" }, tool_use_id: "background-release" });
      continue;
    }
    if (["background-bash-success", "background-bash-batched", "background-bash-early", "background-bash-inline", "background-bash-overlap", "background-bash-late-approval"].includes(scenario) && (replayReceipts || turn === 1)) {
      const batched = scenario === "background-bash-batched";
      const overlap = scenario === "background-bash-overlap";
      const inline = scenario === "background-bash-inline";
      const early = inline || scenario === "background-bash-early";
      const taskIds = overlap ? ["background-bash", "second-bash"] : batched ? ["background-bash", "explicit-background"] : ["background-bash"];
      const notification = (id) => "<task-notification>\n<task-id>" + id + "</task-id>\n<status>completed</status>\n</task-notification>";
      const finishTasks = () => {
        tasks([]);
        for (const id of taskIds) system("task_notification", { task_id: id, tool_use_id: "tool-" + id, status: "completed", output_file: "", summary: "sleep" });
      };
      const replayTask = (id) => {
        if (!replayReceipts || !process.argv.includes("--replay-user-messages")) return;
        send({ type: "user", isReplay: true, parent_tool_use_id: null, uuid: "receipt-" + id,
          // Inline receipts in Claude Code 2.1.272 omit origin.
          ...(inline ? {} : { origin: { kind: "task-notification" } }),
          message: { role: "user", content: inline ? [{ type: "text", text: notification(id) }] : notification(id) } });
      };
      for (const id of taskIds) {
        // task_type is optional on task_started; the task list identifies Bash.
        system("task_started", { task_id: id, tool_use_id: "tool-" + id, description: "sleep", is_backgrounded: id === "explicit-background" });
      }
      tasks(taskIds.map((id) => ({ task_id: id, task_type: process.env.CLAUDE_FIXTURE_TASK_TYPE ?? "local_bash" })));
      system("task_updated", { task_id: "background-bash", patch: { is_backgrounded: true } });
      if (early) {
        finishTasks();
        // Notification-like prompt/tool text is not a consumed task notification.
        send({ type: "user", isReplay: true, parent_tool_use_id: null, uuid: message.uuid,
          message: { role: "user", content: notification("background-bash") } });
        send({ type: "user", isReplay: true, parent_tool_use_id: null, uuid: "other-input", origin: { kind: "sdk" },
          message: { role: "user", content: notification("background-bash") } });
        send({ type: "user", message: { role: "user", content: notification("background-bash") } });
        send({ type: "user", isReplay: true, parent_tool_use_id: "subagent", origin: { kind: "task-notification" },
          message: { role: "user", content: notification("background-bash") } });
        if (inline) replayTask("background-bash");
      }
      ready("background.ready");
      if (!inline) send({ type: "result", subtype: "success", is_error: false, num_turns: 1,
        result: "", session_id: "fixture-session" });
      while (!existsSync("background.release")) await delay(5);
      if (!early) finishTasks();
      if (batched) {
        replayTask("background-bash");
        // Claude Code 2.1.274+ batches completed tasks into the last notification's model call.
        send({ type: "result", subtype: "success", is_error: false, num_turns: 0, stop_reason: null,
          origin: { kind: "task-notification" }, result: "", session_id: "fixture-session" });
      }
      if (overlap) {
        replayTask("background-bash");
        // B completed while A's notification query was still running. Each has its own result.
        send({ type: "result", subtype: "success", is_error: false, num_turns: 1,
          origin: { kind: "task-notification" }, result: "First task answered", session_id: "fixture-session" });
      }
      if (!inline) replayTask(overlap ? "second-bash" : batched ? "explicit-background" : "background-bash");
      request("bg-pre", { subtype: "hook_callback",
        callback_id: hooks.PreToolUse[0].hookCallbackIds[0], tool_use_id: "tool-bg-read",
        input: { cwd: process.cwd(), hook_event_name: "PreToolUse", tool_name: "Read",
          tool_input: { file_path: "fixture.txt" } } });
      continue;
    }
    if (["background-bash-queued-error", "background-bash-queued-raw-result"].includes(scenario) && turn === 1) {
      const task = { task_id: "background-task", task_type: "local_bash" };
      system("task_started", { task_id: task.task_id,
        tool_use_id: "tool-bg", description: "sleep", is_backgrounded: false });
      tasks([task]);
      tasks([]);
      system("task_notification", { task_id: task.task_id,
        tool_use_id: "tool-bg", status: "completed", output_file: "", summary: "sleep" });
      send({ ...(scenario.endsWith("-error")
        ? { type: "result", subtype: "error_during_execution", is_error: true,
            errors: ["fixture background turn failed"], session_id: "fixture-session" }
        : { type: "result", subtype: "success", is_error: false,
            result: '<invoke name="Read">\n<parameter name="file_path">fixture.txt</parameter>\n</invoke>',
            session_id: "fixture-session" }),
        origin: { kind: "task-notification" },
      });
      continue;
    }
    if (scenario === "large-split-record") {
      const record = JSON.stringify({ type: "assistant", message: { role: "assistant",
        content: [{ type: "text", text: "🦞" + "x".repeat(300_000) + "🦞" }] } });
      const bytes = Buffer.from(record + "\n");
      const crab = bytes.indexOf(Buffer.from("🦞"));
      process.stdout.write(bytes.subarray(0, crab + 1));
      await new Promise((resolve) => setImmediate(resolve));
      process.stdout.write(bytes.subarray(crab + 1, crab + 3));
      await new Promise((resolve) => setImmediate(resolve));
      process.stdout.write(bytes.subarray(crab + 3));
      result();
      continue;
    }
    promptHook("prompt-" + turn, user);
  } else if (message.type === "control_response") {
    assert.equal(message.response.subtype, "success");
    const { request_id: id, response } = message.response;
    if (id === "admitted-context") {
      privateContext = response.hookSpecificOutput?.additionalContext;
      if (scenario.startsWith("steer-hook-")) {
        promptHook("admitted-rerun", user + " rewritten");
        continue;
      }
      ready("turn.ready");
    } else if (id === "admitted-rerun") {
      assert.equal(response.hookSpecificOutput?.additionalContext, privateContext);
      ready("turn.ready");
    } else if (id === "injected-context" || id === "injected-rerun") {
      if (id === "injected-context") {
        injectedContext = response;
        if (scenario.startsWith("steer-hook-")) {
          promptHook("injected-rerun", scenario === "steer-hook-rewrite" ? user + " rewritten" : user);
          continue;
        }
      } else {
        injectedRerunContext = response;
      }
      lifecycle("started", pendingInputUuid);
      if (scenario === "steer-after-result") {
        system("init", { capabilities: ["msg_lifecycle_v1"] });
      }
      send({ type: "stream_event", user_message_uuid: pendingInputUuid, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "steered" } } });
      send({ type: "assistant", user_message_uuid: pendingInputUuid, message: { role: "assistant", content: [{ type: "text", text: "steered" }] } });
      if (scenario.includes("notification-replay")) {
        tasks([{ task_id: "background-agent", task_type: "local_agent" }]);
        tasks([]);
        system("task_notification", { task_id: "background-agent", status: "completed" });
        const completedFirst = scenario === "steer-completed-notification-replay";
        if (completedFirst) lifecycle("completed", pendingInputUuid);
        // Native replays host input without origin; notification-looking text is still user input.
        send({ type: "user", isReplay: true, parent_tool_use_id: null, uuid: pendingInputUuid,
          message: { role: "user", content: user } });
        result({ injectedContext });
        if (!completedFirst) lifecycle("completed", pendingInputUuid);
        send({ type: "user", isReplay: true, parent_tool_use_id: null, uuid: "real-background-receipt",
          origin: { kind: "task-notification" }, message: { role: "user", content: user } });
        result({ injectedContext, finalBackgroundAnswer: true });
      } else if (scenario === "steer-merged") {
        lifecycle("completed", pendingInputUuid);
        result({ injectedContext });
        lifecycle("completed", firstInputUuid);
      } else {
        result({ injectedContext });
        if (scenario === "steer-idle-trailer") {
          system("session_state_changed", { state: "idle" });
        }
        lifecycle("completed", pendingInputUuid);
      }
    } else if (id === "background-release") {
      if (scenario === "background-agent-subagent-bash") system("task_notification", { task_id: "subagent-bash", tool_use_id: "tool-subagent-bash", status: "completed", output_file: "", summary: "sleep" });
      tasks([]);
      system("task_notification", { task_id: "background-agent", status: "completed", output_file: "", summary: "agent finished" });
      send({ type: "result", subtype: "success", is_error: false,
        origin: { kind: "task-notification" }, result: JSON.stringify({ finalBackgroundAnswer: true }),
        session_id: "fixture-session" });
    } else if (id === "elicitation") {
      result({ elicitation: response });
    } else if (id.startsWith("prior-")) {
      priorResponses[id] = response;
      if (Object.keys(priorResponses).length === 3) {
        lifecycle("started", pendingInputUuid);
        result({ matchedInputUuid: pendingInputUuid, priorResponses });
      }
    } else if (id === "late-approval") {
      lateDecision = response;
      if (turn === 2) result({ lateDecision });
    } else if (id === "prompt-" + turn) {
      privateContext = response.hookSpecificOutput?.additionalContext;
      request("pre-" + turn, { subtype: "hook_callback",
        callback_id: hooks.PreToolUse[0].hookCallbackIds[0], tool_use_id: "tool-" + turn,
        input: { cwd: process.cwd(), hook_event_name: "PreToolUse", tool_name: nativeToolName,
          tool_input: nativeToolInput,
          tool_use_id: "tool-" + turn } });
    } else if (id === "bg-pre") {
      if (scenario === "background-bash-late-approval") {
        request("late-approval", { subtype: "can_use_tool", tool_name: "Bash",
          input: { command: "echo late" }, tool_use_id: "late-tool" });
      }
      tasks([]);
      result({ finalBackgroundAnswer: true, notificationDecision: response });
    } else if (id === "pre-" + turn) {
      if (scenario === "revoked-approval" || scenario === "mcp-hook") {
        result({ hookDecision: response });
        continue;
      }
      assert.equal(response.hookSpecificOutput.permissionDecision, scenario === "user-question" || firstSeenBackground ? "allow" : "deny");
      request("permission-" + turn, { subtype: "can_use_tool",
        tool_name: nativeToolName,
        input: nativeToolInput,
        tool_use_id: "tool-" + turn });
    } else if (id === "permission-" + turn) {
      assert.equal(response.behavior, scenario === "user-question" || firstSeenBackground ? "allow" : "deny");
      if (firstSeenBackground) {
        const task = { task_id: "first-seen-" + turn, task_type: "local_bash" };
        // Native can first publish an automatic timeout as already backgrounded.
        tasks([task]);
        system("task_started", { ...task, tool_use_id: "tool-" + turn, is_backgrounded: true });
        result({ firstSeenBackground: true });
        if (!explicitBackground) {
          tasks([]);
          system("task_notification", { task_id: task.task_id, status: "completed" });
          send({ type: "result", subtype: "success", is_error: false, origin: { kind: "task-notification" },
            num_turns: 1, result: JSON.stringify({ pid: process.pid, turn, finalBackgroundAnswer: true }), session_id: "fixture-session" });
        }
        continue;
      }
      if (scenario === "cancel-permission") {
        request("cancel-me", { subtype: "can_use_tool", tool_name: "Read",
          input: { file_path: "cancel.txt" }, tool_use_id: "cancel-tool" });
        setTimeout(() => send({ type: "control_cancel_request", request_id: "cancel-me" }), 20);
      } else result({ permission: response });
    } else if (id === "cancel-me") {
      assert.equal(response.behavior, "deny");
      result({ cancelledDecision: response });
    } else throw new Error("Unexpected fixture response: " + id);
  } else throw new Error("Unexpected fixture message: " + message.type);
}
`;

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ModelsAuthLoginFlowOptions } from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type {
  getSessionEntryAsync,
  prepareSessionEntryPatch,
  SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  observeHostDataSql,
  useSessionStoreTempDirs,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createLoginResult,
  createOwnerLoginConfig,
  exerciseDeferredModelAccess,
  prepareTelegramLoginSessionStore,
  registerLoginCommand,
  type TelegramLoginFlow,
} from "./bot-native-command-login.test-support.js";
import { createTelegramGroupCommandContext } from "./bot-native-commands.fixture-test-support.js";
import {
  deliverReplies,
  createPrivateCommandContext,
  resetNativeCommandMenuMocks,
} from "./bot-native-commands.menu-test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "telegram-login-worker-");
const completed = "OpenAI login complete. Try your request again now.";
const kept =
  "OpenAI login complete. This chat kept its previous account. Send /models to review the available models.";
const failed =
  "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.";
const ownerContext = (match = "codex", chatId = 100, userId = 200) =>
  createPrivateCommandContext({ match, chatId, userId });
const messages = (send: Awaited<ReturnType<typeof registerLoginCommand>>["sendMessage"]) =>
  send.mock.calls.map((call) => String(call[1]));
function expectKept(send: Awaited<ReturnType<typeof registerLoginCommand>>["sendMessage"]) {
  expect(send).toHaveBeenCalledWith(100, kept, {});
  expect(send).not.toHaveBeenCalledWith(100, completed, expect.any(Object));
}
type SessionRead = Parameters<typeof getSessionEntryAsync>[0];
type SessionWrite = Parameters<typeof prepareSessionEntryPatch>[0];
const sessionEntry = (overrides: Partial<SessionEntry> = {}): SessionEntry => ({
  sessionId: "sess-main",
  updatedAt: 1,
  ...overrides,
});
function pendingLogin(
  code: string,
  profileId = "openai:codex",
  title = "OpenAI Codex device code",
) {
  const finish = createDeferred<void>();
  const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
    await params.prompter.deviceCode?.({ title, code });
    await finish.promise;
    return createLoginResult(profileId);
  });
  return { finish, loginFlow };
}
const registerOwnedLogin = (
  loginFlow: TelegramLoginFlow,
  overrides: Partial<Parameters<typeof registerLoginCommand>[0]> = {},
) => registerLoginCommand({ cfg: createOwnerLoginConfig(), loginFlow, ...overrides });

const loginSessionMocks = vi.hoisted(() => ({
  getSessionEntry: vi.fn<typeof getSessionEntryAsync>(),
  loadSessionStore: vi.fn(),
  resolveStorePath: vi.fn(),
  prepareSessionEntryPatch: vi.fn(),
  recordDeliveredCommandExchange: vi.fn(async () => ({
    ok: true,
    target: { sessionId: "login-session" },
  })),
}));

// mock-isolation: Keep session database startup outside the command fixture.
vi.mock("./bot-native-commands.runtime.js", () => ({
  ensureConfiguredBindingRouteReady: vi.fn(async () => ({ ok: true })),
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
  getAgentScopedMediaLocalRoots: vi.fn(() => []),
  getSessionEntryAsync: async (params: SessionRead) => loginSessionMocks.getSessionEntry(params),
  resolveStorePath: loginSessionMocks.resolveStorePath,
  recordDeliveredCommandExchange: loginSessionMocks.recordDeliveredCommandExchange,
  resolveChunkMode: vi.fn(() => "length"),
  resolveThreadSessionKeys: vi.fn(
    ({
      baseSessionKey,
      parentSessionKey,
    }: {
      baseSessionKey: string;
      parentSessionKey?: string;
    }) => ({ sessionKey: baseSessionKey, parentSessionKey }),
  ),
}));
vi.mock("openclaw/plugin-sdk/session-store-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/session-store-runtime")>(
    "openclaw/plugin-sdk/session-store-runtime",
  );
  return {
    ...actual,
    getSessionEntryAsync: async (params: SessionRead) => loginSessionMocks.getSessionEntry(params),
    resolveStorePath: loginSessionMocks.resolveStorePath,
    prepareSessionEntryPatch: loginSessionMocks.prepareSessionEntryPatch,
  };
});

function resetLoginCommandMocks() {
  resetNativeCommandMenuMocks();
  loginSessionMocks.recordDeliveredCommandExchange.mockClear();
  loginSessionMocks.loadSessionStore.mockReset().mockReturnValue({});
  loginSessionMocks.getSessionEntry
    .mockReset()
    .mockImplementation(
      async ({ storePath, sessionKey }) =>
        loginSessionMocks.loadSessionStore(storePath)[sessionKey],
    );
  loginSessionMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
  loginSessionMocks.prepareSessionEntryPatch.mockReset().mockImplementation(async (params) => {
    const current = loginSessionMocks.loadSessionStore(params.storePath)[params.sessionKey];
    if (!current) {
      return null;
    }
    const patch = await params.prepare({ ...current });
    if (params.authority?.kind === "host") {
      params.authority.assertCurrent();
    }
    return patch ? { ...current, ...patch } : current;
  });
}

describe("registerTelegramNativeCommands /login", () => {
  beforeEach(resetLoginCommandMocks);

  it("delivers the core provider menu and its method continuation without starting login", async () => {
    const loginFlow = vi.fn();
    const { handler, nativeCommandCallbackDispatcher } = await registerLoginCommand({
      cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
      loginFlow,
    });
    await handler(ownerContext(""));
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: expect.stringContaining("Choose a provider") })],
      }),
    );
    expect(loginFlow).not.toHaveBeenCalled();
    await nativeCommandCallbackDispatcher?.({
      botUser: telegramBotInfoForTest,
      callbackQuery: {
        id: "provider-selection",
        from: { id: 200, is_bot: false, first_name: "Owner" },
        chat_instance: "private-chat",
        message: {
          message_id: 101,
          date: 1,
          chat: { id: 100, type: "private", first_name: "Owner" },
        },
      },
      commandText: "/login oauth/openai/openai",
    });
    expect(deliverReplies).toHaveBeenLastCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({ text: expect.stringContaining("Choose how to connect") }),
        ],
      }),
    );
    expect(loginFlow).not.toHaveBeenCalled();
  });

  it("releases the chat lane only after structured device-code delivery", async () => {
    const allowDeviceCode = createDeferred<void>();
    const finishLogin = createDeferred<void>();
    let loginCompleted = false;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.note("Preparing Codex login…");
      await allowDeviceCode.promise;
      if (!params.prompter.deviceCode) {
        throw new Error("expected structured device-code delivery");
      }
      await params.prompter.deviceCode({
        title: "OpenAI Codex device code",
        code: "PENDING-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      loginCompleted = true;
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow);

    let handlerReturned = false;
    const handlerTask = handler(ownerContext()).then(() => {
      handlerReturned = true;
    });
    await vi.waitFor(() => expect(messages(sendMessage)).toContain("Preparing Codex login…"));
    expect(handlerReturned).toBe(false);

    allowDeviceCode.resolve();
    await handlerTask;

    expect(loginCompleted).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Code: <code>PENDING-CODE</code>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(messages(sendMessage)).not.toContain(completed);

    finishLogin.resolve();
    await vi.waitFor(() => expect(loginCompleted).toBe(true));
    await vi.waitFor(() => expect(messages(sendMessage)).toContain(completed));
  });

  it("routes the login button through the non-blocking native login flow", async () => {
    const finishLogin = createDeferred<void>();
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "BUTTON-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await finishLogin.promise;
      return createLoginResult("openai:codex");
    });
    const { nativeCommandCallbackDispatcher, sendMessage } = await registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });
    if (!nativeCommandCallbackDispatcher) {
      throw new Error("expected login callback dispatcher to be registered");
    }
    const callbackQuery = {
      id: "login-button",
      chat_instance: "login-button-chat",
      data: "tgcmd:/login codex",
      from: { id: 200, is_bot: false, first_name: "Bob", username: "bob" },
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 100, type: "private" as const, first_name: "Owner" },
        reply_markup: {
          inline_keyboard: [[{ text: "Log in to Codex", callback_data: "tgcmd:/login codex" }]],
        },
      },
    };

    await expect(
      nativeCommandCallbackDispatcher({
        commandText: "/login codex",
        botUser: telegramBotInfoForTest,
        callbackQuery,
      }),
    ).resolves.toEqual({ handled: true, clearButtons: true });

    expect(loginFlow).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("Code: <code>BUTTON-CODE</code>"),
      expect.objectContaining({ parse_mode: "HTML" }),
    );
    expect(sendMessage.mock.calls.map((call) => String(call[1]))).not.toContain(
      "OpenAI login complete. Try your request again now.",
    );

    finishLogin.resolve();
    await vi.waitFor(() =>
      expect(sendMessage.mock.calls.map((call) => String(call[1]))).toContain(
        "OpenAI login complete. Try your request again now.",
      ),
    );
  });

  it.each(["all"] as const)(
    "delivers both long-provider controls and completes deferred %s consent through a fresh dispatcher",
    exerciseDeferredModelAccess,
  );

  it("cancels saved-login consent and rejects its old choice", async () => {
    await exerciseDeferredModelAccess("cancel");
  });

  it("rejects group /login codex without sending the device code publicly", async () => {
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.note("URL: https://auth.openai.com/codex/device\nCode: SECRET");
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow, { allowFrom: ["200"] });

    await handler(createTelegramGroupCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).not.toHaveBeenCalled();
    const texts = messages(sendMessage);
    expect(texts).toContain(
      "Provider login requires a private chat or Control UI session. Open a private chat with OpenClaw and send `/login` there.",
    );
    expect(texts.join("\n")).not.toContain("SECRET");
    expect(texts.join("\n")).not.toContain("https://auth.openai.com/codex/device");
  });

  it("rejects /login for authorized senders who are not owners", async () => {
    const loginFlow = vi.fn<TelegramLoginFlow>(async () => ({
      ...createLoginResult("openai:codex"),
      profiles: [],
    }));
    const { handler, sendMessage } = await registerLoginCommand({
      cfg: {
        commands: {
          native: true,
          allowFrom: { telegram: ["200"] },
          ownerAllowFrom: ["999"],
        },
      } as OpenClawConfig,
      loginFlow,
    });

    await handler(ownerContext());

    expect(loginFlow).not.toHaveBeenCalled();
    expect(messages(sendMessage)).toContain(
      "Only an OpenClaw owner can sign in here. Ask the owner to connect this provider or grant you owner access.",
    );
  });

  it("names the active provider when another provider is requested in the same Telegram thread", async () => {
    const deferred = createDeferred<void>();
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({
        title: "OpenAI Codex device code",
        code: "FIRST-CODE",
        expiresInMinutes: 15,
        message: "URL: https://auth.openai.com/codex/device",
      });
      await deferred.promise;
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow);

    await handler(ownerContext());
    await handler(ownerContext("openrouter/openrouter-oauth"));
    deferred.resolve();
    await vi.waitFor(() => expect(messages(sendMessage)).toContain(completed));

    expect(loginFlow).toHaveBeenCalledTimes(1);
    expect(messages(sendMessage)).toContain(
      "OpenAI sign-in is already in progress. Finish it, or send /login cancel to cancel.",
    );
  });

  it("cancels only the owner's private chat after browser-link delivery", async () => {
    const finish = createDeferred<void>();
    const signals: AbortSignal[] = [];
    let settled = 0;
    const loginFlow = vi.fn<TelegramLoginFlow>(async (params) => {
      if (!params.signal) {
        throw new Error("Expected login cancellation signal.");
      }
      signals.push(params.signal);
      try {
        await params.openUrl?.("https://openrouter.ai/auth?code_challenge=fixture");
        await finish.promise;
        params.signal.throwIfAborted();
        return {
          providerId: "openrouter",
          methodId: "oauth",
          authRefresh: "refreshed",
          profiles: [{ profileId: "openrouter:default", provider: "openrouter", mode: "api_key" }],
        };
      } finally {
        settled += 1;
      }
    });
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow, {
      allowFrom: ["200", "201"],
    });
    const command = (match: string, chatId = 100, userId = 200) =>
      handler(createPrivateCommandContext({ match, chatId, userId }));
    try {
      await command("openrouter/openrouter-oauth");
      await command("openrouter/openrouter-oauth", 101);
      expect(signals).toHaveLength(2);
      await command("cancel", 100, 201);
      expect(signals.every((signal) => !signal.aborted)).toBe(true);
      await command("cancel");
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      expect(sendMessage).toHaveBeenCalledWith(100, "Provider login cancelled for this chat.", {});
      await command("cancel");
      expect(sendMessage).toHaveBeenCalledWith(
        100,
        "No provider login is active in this chat.",
        {},
      );
    } finally {
      await command("cancel");
      await command("cancel", 101);
      finish.resolve();
      await vi.waitFor(() => expect(settled).toBe(signals.length));
    }
    expect(loginSessionMocks.prepareSessionEntryPatch).not.toHaveBeenCalled();
  });

  it("rejects credential persistence after the command owner is removed", async () => {
    const deferred = createDeferred<void>();
    const commands = { native: true, ownerAllowFrom: ["200"] };
    const cfg: OpenClawConfig = {
      commands,
      agents: { entries: { main: {} } },
    };
    let currentConfig = cfg;
    const persist = vi.fn();
    const loginFlow = vi.fn<TelegramLoginFlow>(async (opts) => {
      await opts.prompter.deviceCode?.({ title: "Sign in", code: "OWNER-CODE" });
      await deferred.promise;
      opts.assertCurrent?.();
      persist();
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = await registerLoginCommand({
      cfg,
      loginFlow,
      getRuntimeConfig: () => currentConfig,
    });

    await handler(ownerContext());
    currentConfig = { ...cfg, commands: { native: true, ownerAllowFrom: ["999"] } };
    deferred.resolve();
    await vi.waitFor(() => expect(messages(sendMessage)).toContain(failed));
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps the prior Telegram pin when the owner is revoked after patch preparation", async () => {
    const commands = { native: true, ownerAllowFrom: ["200"] };
    const previous = sessionEntry({
      sessionId: "revoked-telegram-owner-session",
      authProfileOverride: "openai:prior",
      authProfileOverrideSource: "user",
    });
    const store = { "agent:main:main": previous };
    loginSessionMocks.loadSessionStore.mockReturnValue(store);
    loginSessionMocks.prepareSessionEntryPatch.mockImplementationOnce(
      async (write: SessionWrite) => {
        const patch = await write.prepare({ ...previous }, { existingEntry: previous });
        commands.ownerAllowFrom = ["999"];
        if (write.authority?.kind === "host") {
          write.authority.assertCurrent();
        }
        store["agent:main:main"] = patch ? { ...previous, ...patch } : previous;
        return store["agent:main:main"];
      },
    );
    const loginFlow = vi.fn<TelegramLoginFlow>(async () => createLoginResult("openai:saved"));
    const { handler, sendMessage } = await registerLoginCommand({ cfg: { commands }, loginFlow });

    await handler(ownerContext());

    expect(store["agent:main:main"]).toBe(previous);
    expect(messages(sendMessage)).toContain(kept);
  });

  it("releases a failed flow before any device code is delivered", async () => {
    const loginFlow = vi.fn(async () => {
      throw new Error("device-code request failed");
    });
    const { handler, sendMessage } = await registerLoginCommand({
      cfg: createOwnerLoginConfig(),
      loginFlow,
    });

    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));
    await handler(createPrivateCommandContext({ match: "codex", userId: 200 }));

    expect(loginFlow).toHaveBeenCalledTimes(2);
    expect(
      sendMessage.mock.calls.filter(
        (call) =>
          call[1] ===
          "OpenAI login did not complete. Send `/login openai/openai-device-code` to try again.",
      ),
    ).toHaveLength(2);
  });

  it("does not report auth failure when only the terminal notification fails", async () => {
    const runtime: RuntimeEnv = { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "SUCCESS-CODE" });
      return createLoginResult("openai:codex");
    });
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow, { runtime });
    sendMessage.mockResolvedValueOnce({ message_id: 999 });
    sendMessage.mockRejectedValueOnce(new Error("Telegram unavailable"));

    await handler(ownerContext());
    await vi.waitFor(() =>
      expect(runtime.error).toHaveBeenCalledWith(
        expect.stringContaining("result notification failed"),
      ),
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(messages(sendMessage)).not.toContain(failed);
  });

  it("blocks provider prompts and terminal messages after Telegram stops", async () => {
    const shutdown = new AbortController();
    let loginSettled = false;
    const loginFlow = vi.fn(async (params: ModelsAuthLoginFlowOptions) => {
      await params.prompter.deviceCode?.({ title: "Codex login", code: "ABORT-CODE" });
      if (!params.signal) {
        throw new Error("expected login owner signal");
      }
      const signal = params.signal;
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                signal.reason instanceof Error ? signal.reason : new Error("Telegram stopped"),
              ),
            { once: true },
          );
        });
        throw new Error("unreachable");
      } catch {
        await params.prompter.note("Trouble with device code login?", "OAuth help");
        throw new Error("Telegram stopped");
      } finally {
        loginSettled = true;
      }
    });
    const { handler, sendMessage } = await registerOwnedLogin(loginFlow, {
      abortSignal: shutdown.signal,
    });

    await handler(ownerContext());
    shutdown.abort(new Error("Telegram stopped"));
    await vi.waitFor(() => expect(loginSettled).toBe(true));

    expect(messages(sendMessage)).toHaveLength(1);
    expect(sendMessage.mock.calls[0]?.[1]).toContain("ABORT-CODE");
  });

  it("delivers pending login results through the account sender instead of the retired bot", async () => {
    const { finish: finishLogin, loginFlow } = pendingLogin(
      "RESTART-CODE",
      "openai:codex",
      "Codex login",
    );
    const { accountId, handler, sendMessage, sendMessageTelegram } =
      await registerOwnedLogin(loginFlow);

    await handler(ownerContext());
    sendMessage.mockRejectedValue(new Error("retired polling bot"));
    sendMessageTelegram.mockResolvedValueOnce({ messageId: "1000", chatId: "100" });

    finishLogin.resolve();
    await vi.waitFor(() =>
      expect(sendMessageTelegram).toHaveBeenCalledWith(
        "telegram:100",
        completed,
        expect.objectContaining({ accountId, token: "token" }),
      ),
    );
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
  it("persists the Telegram login account without caller-thread entry SQL", async () => {
    const { store, scope } = await prepareTelegramLoginSessionStore(
      sessionDirs.make(),
      loginSessionMocks,
    );
    const { handler } = await registerLoginCommand({
      accountId: "default",
      cfg: createOwnerLoginConfig(),
      loginFlow: vi.fn<TelegramLoginFlow>(async () => createLoginResult("openai:saved")),
    });
    const sql = observeHostDataSql();
    try {
      await handler(ownerContext());
    } finally {
      sql.restore();
    }
    expect(loginSessionMocks.prepareSessionEntryPatch).toHaveBeenCalledOnce();
    expect(loginSessionMocks.prepareSessionEntryPatch).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: scope.sessionKey, storePath: scope.storePath }),
    );
    expect(store.getSessionEntry(scope)?.authProfileOverride).toBe("openai:saved");
    expect(
      sql.queries.filter((query) =>
        /\b(?:session_nodes|session_entry_snapshots|session_windows)\b/i.test(query),
      ),
    ).toEqual([]);
  });

  it("moves a session created while Telegram login is pending to the returned profile", async () => {
    const { finish: finishLogin, loginFlow: runModelsAuthLoginFlow } = pendingLogin(
      "NEW-SESSION",
      "openai:new-owner@example.com",
    );
    let sessionStore: Record<string, SessionEntry> = {};
    loginSessionMocks.loadSessionStore.mockImplementation(() => sessionStore);
    const { handler, sendMessage } = await registerOwnedLogin(runModelsAuthLoginFlow, {
      accountId: "default",
      cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
    });

    await handler(ownerContext());
    sessionStore = {
      "agent:main:main": sessionEntry({ sessionId: "sess-created-during-login", updatedAt: 2 }),
    };
    finishLogin.resolve();

    await vi.waitFor(() =>
      expect(loginSessionMocks.prepareSessionEntryPatch).toHaveBeenCalledTimes(1),
    );
    const update = (
      loginSessionMocks.prepareSessionEntryPatch.mock.calls[0]?.[0] as {
        prepare?: (entry: SessionEntry) => Partial<SessionEntry> | null;
      }
    )?.prepare;
    expect(
      update?.(sessionEntry({ sessionId: "sess-created-during-login", updatedAt: 2 })),
    ).toEqual({
      authProfileOverride: "openai:new-owner@example.com",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: undefined,
    });
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(100, completed, {}));
  });

  it("preserves a later user-selected profile on a session created during Telegram login", async () => {
    const { finish: finishLogin, loginFlow: runModelsAuthLoginFlow } = pendingLogin(
      "LATER-USER-SELECTION",
      "openai:login-profile",
    );
    let sessionStore: Record<string, SessionEntry> = {};
    loginSessionMocks.loadSessionStore.mockImplementation(() => sessionStore);
    const { handler, sendMessage } = await registerOwnedLogin(runModelsAuthLoginFlow, {
      accountId: "default",
      cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
    });

    await handler(ownerContext());
    sessionStore = {
      "agent:main:main": {
        authProfileOverride: "openai:later-user-profile",
        authProfileOverrideSource: "user",
        sessionId: "sess-created-during-login",
        updatedAt: 2,
      },
    };
    finishLogin.resolve();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledWith(100, kept, {}));
    expect(sendMessage).not.toHaveBeenCalledWith(100, completed, expect.any(Object));
  });

  it("preserves refreshed auth when Telegram cannot persist the returned session profile", async () => {
    const message =
      'OpenAI login complete. This chat kept its previous account. To use the new sign-in, send `/model "openai/test-model"@"openai:new-owner@example.com" -s`.';
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": {
        authProfileOverride: "openai:old-owner@example.com",
        modelOverride: "test-model",
        sessionId: "sess-main",
        updatedAt: 1,
      },
    });
    loginSessionMocks.prepareSessionEntryPatch.mockRejectedValueOnce(new Error("write failed"));
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () =>
      createLoginResult("openai:new-owner@example.com"),
    );
    const { handler, sendMessage } = await registerLoginCommand({
      accountId: "default",
      cfg: {
        commands: { native: true, ownerAllowFrom: ["200"] },
      } as OpenClawConfig,
      allowFrom: ["200"],
      loginFlow: runModelsAuthLoginFlow,
    });

    await handler(ownerContext());

    expect(sendMessage).toHaveBeenCalledWith(100, message, {});
    expect(sendMessage).toHaveBeenCalledWith(
      100,
      expect.stringContaining("kept its previous account"),
      {},
    );
    expect(sendMessage).not.toHaveBeenCalledWith(100, completed, expect.any(Object));
  });

  it("revalidates an unchanged Telegram profile after device login", async () => {
    const previousEntry = sessionEntry({
      authProfileOverride: "openai:owner@example.com",
      authProfileOverrideSource: "user",
    });
    loginSessionMocks.loadSessionStore.mockReturnValue({
      "agent:main:main": previousEntry,
    });
    loginSessionMocks.prepareSessionEntryPatch.mockImplementationOnce(async (params) => {
      const concurrentEntry = {
        ...previousEntry,
        authProfileOverride: "openai:concurrent-owner@example.com",
        updatedAt: 2,
      };
      const patch = await params.prepare({ ...concurrentEntry });
      if (params.authority?.kind === "host") {
        params.authority.assertCurrent();
      }
      return patch ? { ...concurrentEntry, ...patch } : concurrentEntry;
    });
    const runModelsAuthLoginFlow = vi.fn<TelegramLoginFlow>(async () =>
      createLoginResult("openai:owner@example.com"),
    );
    const { handler, sendMessage } = await registerOwnedLogin(runModelsAuthLoginFlow, {
      accountId: "default",
      cfg: { commands: { native: true, ownerAllowFrom: ["200"] } },
    });

    await handler(ownerContext());

    expectKept(sendMessage);
  });
});

import type { ImageGenerationProviderConfiguredContext } from "openclaw/plugin-sdk/image-generation";
import {
  isProviderApiKeyConfiguredAsync,
  listProfilesForProvider,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import {
  createChatGPTAccessToken,
  createCodexApiKeyAuthStore,
  createCodexOAuthAuthStore,
  openAIImageConfig,
} from "./image-generation-provider.test-support.js";

let authStore: AuthProfileStore = { version: 1, profiles: {} };
let authConfigured = false;
const ensureAuthProfileStoreAsyncMock = vi.fn(async () => authStore);
const isProviderApiKeyConfiguredAsyncMock = vi.fn<typeof isProviderApiKeyConfiguredAsync>(
  async () => authConfigured,
);
const provider = buildOpenAIImageGenerationProvider({
  ensureAuthProfileStoreAsync: ensureAuthProfileStoreAsyncMock,
  listProfilesForProvider,
  isProviderApiKeyConfiguredAsync: isProviderApiKeyConfiguredAsyncMock,
});

async function expectConfigured(
  context: ImageGenerationProviderConfiguredContext,
  configured: boolean,
) {
  expect(await provider.isConfiguredAsync?.(context)).toBe(configured);
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "");
  authStore = { version: 1, profiles: {} };
  authConfigured = false;
  ensureAuthProfileStoreAsyncMock.mockImplementation(async () => authStore);
  isProviderApiKeyConfiguredAsyncMock.mockImplementation(async () => authConfigured);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("OpenAI image generation auth availability", () => {
  it("uses capability-aware credential availability before checking the image route", async () => {
    authConfigured = true;
    await expectConfigured({ agentDir: "/tmp/agent" }, true);
    const authInput = {
      provider: "openai",
      agentDir: "/tmp/agent",
      cfg: undefined,
      store: undefined,
      capability: "image-generation",
    };
    expect(isProviderApiKeyConfiguredAsyncMock).toHaveBeenCalledWith(authInput);

    authConfigured = false;
    await expectConfigured({ agentDir: "/tmp/agent" }, false);
  });

  it("reports configured from a config apiKey (gateway-routed openai) with no env/profile creds", async () => {
    isProviderApiKeyConfiguredAsyncMock.mockImplementation(isProviderApiKeyConfiguredAsync);

    await expectConfigured(
      {
        cfg: openAIImageConfig({
          baseUrl: "https://gateway.example.test/openai/v1",
          apiKey: "gateway-token",
        }),
      },
      true,
    );
    expect(ensureAuthProfileStoreAsyncMock).not.toHaveBeenCalled();
  });

  it("honors canonical auth rejection even when another Codex profile exists", async () => {
    authStore = createCodexOAuthAuthStore();
    await expectConfigured({ agentDir: "/tmp/agent" }, false);
  });

  it.each([["whitespace-only", "   "]])(
    "treats a %s config apiKey as not configured",
    async (_label, apiKey) => {
      // Blank placeholders resolve to no usable credential in the generate
      // path, so readiness must not count them either.
      await expectConfigured(
        {
          agentDir: "/tmp/agent",
          cfg: openAIImageConfig({
            baseUrl: "https://gateway.example.test/openai/v1",
            apiKey,
          }),
        },
        false,
      );
    },
  );

  it("reports ChatGPT OAuth image auth as configured for ChatGPT routes", async () => {
    authConfigured = true;
    authStore = createCodexOAuthAuthStore();

    await expectConfigured(
      {
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          baseUrl: "https://chatgpt.com/backend-api/codex",
        }),
      },
      true,
    );

    expect(ensureAuthProfileStoreAsyncMock).toHaveBeenCalledTimes(1);
    expect(isProviderApiKeyConfiguredAsyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ store: authStore }),
    );

    await expectConfigured(
      {
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          api: "openai-chatgpt-responses",
          baseUrl: "https://openai-compatible.example.test/v1",
        }),
      },
      true,
    );
  });

  it("does not report OpenAI OAuth image auth as configured for custom OpenAI endpoints", async () => {
    authConfigured = true;
    authStore = {
      version: 1,
      profiles: {
        "openai:chatgpt": {
          type: "oauth",
          provider: "openai",
          access: "chatgpt-access",
          refresh: "chatgpt-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };

    await expectConfigured(
      {
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          baseUrl: "https://openai-compatible.example.test/v1",
        }),
      },
      false,
    );
  });

  it("does not report Codex OAuth image auth as configured for non-exact public OpenAI URLs", async () => {
    authConfigured = true;
    authStore = createCodexOAuthAuthStore();

    await expectConfigured(
      {
        agentDir: "/tmp/agent",
        cfg: openAIImageConfig({
          baseUrl: "https://api.openai.com/v1?proxy=1",
        }),
      },
      false,
    );
  });

  describe("Free ChatGPT plans", () => {
    function freePlanStore(access = createChatGPTAccessToken("free")): AuthProfileStore {
      const store = createCodexOAuthAuthStore();
      store.profiles["openai:default"].access = access;
      return store;
    }

    it("does not report image generation when every ChatGPT profile is on the Free plan", async () => {
      authConfigured = true;
      authStore = freePlanStore();
      await expectConfigured({ agentDir: "/tmp/agent" }, false);

      authStore = {
        version: 1,
        profiles: {
          "openai:token": {
            type: "token",
            provider: "openai",
            token: createChatGPTAccessToken("free"),
          },
        },
      };
      await expectConfigured({ agentDir: "/tmp/agent" }, false);
    });

    it("falls back to the plan stored at login when the token has no plan claim", async () => {
      authConfigured = true;
      authStore = freePlanStore("opaque-access");
      authStore.profiles["openai:default"] = {
        ...authStore.profiles["openai:default"],
        chatgptPlanType: "free",
      } as AuthProfileStore["profiles"][string];
      await expectConfigured({ agentDir: "/tmp/agent" }, false);
    });

    it("prefers the refreshed token plan over the plan stored at login", async () => {
      authConfigured = true;
      authStore = freePlanStore(createChatGPTAccessToken("plus"));
      authStore.profiles["openai:default"] = {
        ...authStore.profiles["openai:default"],
        chatgptPlanType: "free",
      } as AuthProfileStore["profiles"][string];
      await expectConfigured({ agentDir: "/tmp/agent" }, true);
    });

    it.each(["plus", "pro", "team"])("keeps image generation for the %s plan", async (plan) => {
      authConfigured = true;
      authStore = freePlanStore(createChatGPTAccessToken(plan));
      await expectConfigured({ agentDir: "/tmp/agent" }, true);
    });

    it("keeps image generation when the plan is unknown", async () => {
      authConfigured = true;
      authStore = createCodexOAuthAuthStore();
      await expectConfigured({ agentDir: "/tmp/agent" }, true);
    });

    it("keeps image generation when an OpenAI API key is also available", async () => {
      authConfigured = true;
      authStore = {
        version: 1,
        profiles: { ...freePlanStore().profiles, ...createCodexApiKeyAuthStore().profiles },
      };
      await expectConfigured({ agentDir: "/tmp/agent" }, true);

      authStore = freePlanStore();
      await expectConfigured(
        {
          agentDir: "/tmp/agent",
          cfg: openAIImageConfig({ baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" }),
        },
        true,
      );
    });

    it("does not count OPENAI_API_KEY while ChatGPT sign-in keeps the Codex route", async () => {
      authConfigured = true;
      authStore = freePlanStore();
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      await expectConfigured({ agentDir: "/tmp/agent" }, false);
    });

    it("ignores Free Sign in with ChatGPT profiles that cannot reach the image routes", async () => {
      authConfigured = true;
      authStore = freePlanStore();
      authStore.profiles["openai:default"] = {
        ...authStore.profiles["openai:default"],
        authFlow: "chatgpt-token-sharing",
      } as AuthProfileStore["profiles"][string];
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      await expectConfigured({ agentDir: "/tmp/agent" }, true);
    });
  });
});

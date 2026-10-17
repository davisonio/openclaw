// Auth-profile checks that decide which OpenAI image route a request can use.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { resolveOpenAICodexAuthIdentity } from "openclaw/plugin-sdk/provider-oauth-runtime";
import { resolveModelAuthPolicy } from "./provider-policy-api.js";

export type OpenAIImageModelAuth = Pick<
  OpenClawPluginApi["runtime"]["modelAuth"],
  "ensureAuthProfileStoreAsync" | "listProfilesForProvider" | "isProviderApiKeyConfiguredAsync"
>;

export async function resolveRequestAuthStore(
  req: { authStore?: AuthProfileStore; agentDir?: string },
  modelAuth: OpenAIImageModelAuth,
): Promise<AuthProfileStore | undefined> {
  if (req.authStore) {
    return req.authStore;
  }
  const agentDir = req.agentDir?.trim();
  if (!agentDir) {
    return undefined;
  }
  return modelAuth.ensureAuthProfileStoreAsync(agentDir, {
    allowKeychainPrompt: false,
  });
}

export function hasOpenAIImageApiKeyProfile(
  store: AuthProfileStore | undefined,
  modelAuth: OpenAIImageModelAuth,
): boolean {
  if (!store) {
    return false;
  }
  const profileIds = modelAuth.listProfilesForProvider(store, "openai");
  if (profileIds.length === 0) {
    return false;
  }
  return profileIds.some((profileId) => store.profiles[profileId]?.type === "api_key");
}

export function hasCodexResponseTransportProfileConfigured(
  store: AuthProfileStore | undefined,
  modelAuth: OpenAIImageModelAuth,
): boolean {
  if (!store) {
    return false;
  }
  return modelAuth
    .listProfilesForProvider(store, "openai")
    .some((profileId) => isCodexImageSubscription(store.profiles[profileId]));
}

function isCodexImageSubscription(
  credential: AuthProfileStore["profiles"][string] | undefined,
): credential is Extract<AuthProfileStore["profiles"][string], { type: "oauth" | "token" }> {
  return (
    (credential?.type === "oauth" || credential?.type === "token") &&
    resolveModelAuthPolicy({
      provider: "openai",
      mode: credential.type,
      authFlow: credential.type === "oauth" ? credential.authFlow : undefined,
      capability: "image-generation",
    })?.compatible === true
  );
}

// Free ChatGPT plans cannot generate images through Codex sign-in, and the Codex client
// withholds its image tool from them (openai/codex#34850). The refreshed access token
// carries the current plan; the plan stored at login is the fallback. Unknown plans pass.
export function isFreeChatGPTPlan(access: unknown, storedPlanType?: string): boolean {
  const planType =
    (typeof access === "string"
      ? resolveOpenAICodexAuthIdentity({ access }).chatgptPlanType
      : undefined) ?? storedPlanType;
  return planType?.trim().toLowerCase() === "free";
}

export function hasOnlyFreeChatGPTPlanProfiles(
  store: AuthProfileStore | undefined,
  modelAuth: OpenAIImageModelAuth,
): boolean {
  if (!store) {
    return false;
  }
  const credentials = modelAuth
    .listProfilesForProvider(store, "openai")
    .map((profileId) => store.profiles[profileId]);
  if (credentials.some((credential) => credential?.type === "api_key")) {
    return false;
  }
  // Sign in with ChatGPT profiles never reach the image routes, so they cannot veto
  // another credential such as OPENAI_API_KEY.
  const subscriptions = credentials.filter(isCodexImageSubscription);
  return (
    subscriptions.length > 0 &&
    subscriptions.every((credential) =>
      credential.type === "oauth"
        ? isFreeChatGPTPlan(credential.access, credential.chatgptPlanType)
        : isFreeChatGPTPlan(credential.token),
    )
  );
}

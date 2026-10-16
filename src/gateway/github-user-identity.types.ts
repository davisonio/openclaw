import type { CachedGitHubIdentity } from "../state/user-profiles.types.js";

/** Connection-held identity synchronization contract, independent of its transport. */
export type AuthenticatedGitHubIdentitySync = () => Promise<CachedGitHubIdentity>;

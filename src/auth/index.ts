/**
 * Barrel re-exports for the OAuth backend-proxy subsystem.
 */

export { BackendAuthRequiredError } from "./backend/errors.js";
export { BackendTokenStore, type UpstreamTokenSet } from "./backend/token-store.js";
export {
  FileDcrStore,
  normalizeIssuer,
  resolveDcrStorePath,
  type DcrStore,
} from "./backend/dcr-store.js";
export {
  PendingFlowRegistry,
  type PendingFlow,
  type PendingFlowRegistryOptions,
} from "./backend/pending-flows.js";
export {
  makeOAuthClientProvider,
  type EmceepeeOAuthClientProvider,
  type MakeOAuthClientProviderOptions,
} from "./backend/oauth-provider.js";
export {
  buildAuthElicitation,
  URL_ELICITATION_ERROR_CODE,
  type ElicitationPayload,
  type UrlElicitationPayload,
  type FallbackElicitationPayload,
} from "./backend/elicitation.js";
export {
  classifyElicitation,
  type ElicitationMode,
} from "./client-facing/capabilities.js";
export {
  EphemeralCallbackListener,
  type EphemeralCallbackResult,
  type EphemeralCallbackListenerOptions,
} from "./backend/ephemeral-listener.js";
export {
  runStdioOAuthFlow,
  type StdioOAuthFlowOptions,
  type StdioOAuthFlowStarted,
  type StdioOAuthFlowResult,
} from "./backend/stdio-oauth-flow.js";

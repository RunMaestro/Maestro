/** Host-owned budget shared by plugin agents.send and desktop-backed CLI send. */
export const HEADLESS_RUN_TIMEOUT_MS = 60 * 60_000;

/** Keep run authority and the CLI reply wait alive through process completion. */
export const HEADLESS_RUN_COMPLETION_TIMEOUT_MS = HEADLESS_RUN_TIMEOUT_MS + 60_000;

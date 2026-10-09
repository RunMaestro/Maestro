/** Host-owned budget shared by plugin agents.send and desktop-backed CLI send. */
export const HEADLESS_RUN_TIMEOUT_MS = 60 * 60_000;

/** Keep run authority and the CLI reply wait alive through process completion. */
export const HEADLESS_RUN_COMPLETION_TIMEOUT_MS = HEADLESS_RUN_TIMEOUT_MS + 60_000;

/** Codex auth/startup must produce model activity before the long run budget. */
export const CODEX_STARTUP_TIMEOUT_MS = 120_000;

/** Bound SIGTERM teardown before forcing termination and releasing the caller. */
export const HEADLESS_PROCESS_KILL_GRACE_MS = 5_000;

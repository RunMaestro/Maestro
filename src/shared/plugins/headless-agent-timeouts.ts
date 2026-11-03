/** Absolute six-hour safety ceiling; semantic silence is supervised separately.
 * Host-owned budget shared by plugin agents.send and desktop-backed CLI send. */
export const HEADLESS_RUN_TIMEOUT_MS = 6 * 60 * 60_000;

/** Cleanup fits the stop grace, forced-close wait and final proof revocation. */
export const HEADLESS_RUN_CLEANUP_MARGIN_MS = 60_000;

/** Keep run authority and the CLI reply wait alive through process completion. */
export const HEADLESS_RUN_COMPLETION_TIMEOUT_MS =
	HEADLESS_RUN_TIMEOUT_MS + HEADLESS_RUN_CLEANUP_MARGIN_MS;

/**
 * Codex may compact a resumed conversation before exec emits any model output.
 * Healthy compactions have taken 152-159 seconds, exceeding the former 120s
 * bound. Allow five minutes while keeping blocked startup/authentication bounded.
 */
export const CODEX_STARTUP_TIMEOUT_MS = 5 * 60_000;

/** Bound the wait for close after force-killing a headless provider tree. */
export const HEADLESS_PROCESS_CLOSE_TIMEOUT_MS = 5_000;

/** Host-owned pilot configuration; never supplied by plugin params or CLI flags. */
export interface HeadlessIdleProfile {
	warnMs: number;
	idleMs: number;
	/** Nonrenewable opaque tool/wait allowance between real model progress. */
	toolMs: number;
}

export const HEADLESS_IDLE_PROFILE: Readonly<HeadlessIdleProfile> = Object.freeze({
	warnMs: 10 * 60_000,
	idleMs: 20 * 60_000,
	toolMs: 60 * 60_000,
});

/**
 * Cue active-state module.
 *
 * Holds a single boolean flag that the Cue subsystem consults before doing
 * any expensive background work (file walks, HTTP polls, dispatch). The
 * renderer flips it via `cue:setActive` IPC on visibility change so we
 * don't burn CPU running scanners while the app is hidden.
 *
 * Follows the visibility-aware pattern documented in
 * CLAUDE-PERFORMANCE.md§"Visibility-Aware Operations".
 *
 * The flag defaults to `true` so subsystems that haven't been wired through
 * the IPC bridge yet (e.g. CLI, tests, headless agents) keep their current
 * behavior.
 */

let cueActive = true;

/** Returns true when the Cue subsystem should be doing background work. */
export function isCueActive(): boolean {
	return cueActive;
}

/**
 * Flip the active flag. Called from the `cue:setActive` IPC handler in
 * response to renderer-side `visibilitychange` events.
 *
 * Setting it to `false` does NOT stop any in-flight work — scanners check
 * the flag at the start of each tick. This is intentional: stopping mid-tick
 * could leave partial state (open file handles, in-progress HTTP requests).
 */
export function setCueActive(active: boolean): void {
	cueActive = active;
}

/** Test-only — reset to the default. */
export function resetCueActiveForTests(): void {
	cueActive = true;
}

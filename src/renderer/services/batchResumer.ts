/**
 * The one way to un-park a paused Auto Run.
 *
 * A run that hits an agent error parks on an in-memory error-resolution
 * promise owned by the batch hooks; resolving it with `'resume'` is the only
 * thing that continues the loop, and the function that does that
 * (`resumeAfterError`) lives inside a React hook tree. Anything outside that
 * tree - the Agent Resilience retry timers, the auto-resume coordinator - has
 * to be handed the callback.
 *
 * It lives here rather than inside either caller because there is exactly one
 * resume action and it should have exactly one registry. It previously sat in
 * `retryStore`, which meant the second automatic resumer either had to import
 * the retry store for an unrelated reason or stand up a rival registration
 * App had to remember to feed. One registry, registered once by App.
 */

let batchResumer: ((sessionId: string) => void) | null = null;

/**
 * Wire the Auto Run resume callback. Called once by App with
 * `resumeAutoRunAfterError`, and with `null` on teardown.
 */
export function registerBatchResumer(fn: ((sessionId: string) => void) | null): void {
	batchResumer = fn;
}

/**
 * The registered resumer, or `null` when nothing is wired (tests, or before
 * App's effect runs). Callers must treat `null` as "fall back to the manual
 * error controls" rather than assuming a resume happened.
 */
export function getBatchResumer(): ((sessionId: string) => void) | null {
	return batchResumer;
}

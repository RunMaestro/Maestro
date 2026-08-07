/**
 * Wires the dispatch-callback registry to the rest of the main process:
 * Auto Run finality in, prompt delivery out.
 *
 * Delivery goes through the renderer's authoritative execution queue (the same
 * `enqueue_command` path `dispatch --queue` uses) rather than a raw send. That
 * is what makes a callback safe to deliver into a caller that is still busy:
 * it lands on the next idle turn instead of being rejected or interleaved. And
 * because it is a real turn in the caller's live tab, the orchestrator answers
 * with its accumulated context - unlike a Cue chain, which spawns a fresh
 * headless process.
 */

import { getAutoRunStateTracker } from '../autorun/autorun-state-tracker';
import { DispatchCallbackRegistry } from './dispatch-callback-registry';
import { renderCallbackPrompt } from './dispatch-callback-prompt';
import type { DispatchCallbackFire } from './types';

export interface DispatchCallbackServiceDeps {
	/**
	 * Enqueue a prompt into a caller agent's tab. Resolves the same shape the
	 * web server's enqueueCommand callback does.
	 */
	enqueue: (
		agentId: string,
		prompt: string,
		tabId?: string
	) => Promise<{ success: boolean; error?: string; reason?: string }>;
	/** Best-effort result text for the finished dispatch. */
	getTargetOutput?: (
		agentId: string,
		since: number
	) => Promise<string | undefined> | string | undefined;
	/** Display name lookup for {{DISPATCH_TARGET_NAME}} at fire time. */
	logger?: {
		info: (msg: string, context?: string) => void;
		warn: (msg: string, context?: string) => void;
	};
}

const LOG_CONTEXT = 'DispatchCallback';

let registry: DispatchCallbackRegistry | null = null;
let unsubscribeAutoRun: (() => void) | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** How often expired callbacks are swept. */
const SWEEP_INTERVAL_MS = 30_000;

/**
 * Initialise the process-wide registry. Idempotent: a second call replaces the
 * previous wiring (used by tests and by web-server restarts).
 */
export function initDispatchCallbacks(deps: DispatchCallbackServiceDeps): DispatchCallbackRegistry {
	disposeDispatchCallbacks();

	const tracker = getAutoRunStateTracker();

	registry = new DispatchCallbackRegistry({
		autoRunRunningSince: (agentId) => tracker.getRunningSince(agentId),
		onFire: (fire) => {
			void deliverCallback(fire, deps);
		},
		logger: deps.logger
			? {
					info: (msg) => deps.logger?.info(msg, LOG_CONTEXT),
					warn: (msg) => deps.logger?.warn(msg, LOG_CONTEXT),
				}
			: undefined,
	});

	unsubscribeAutoRun = tracker.onFinal((agentId, payload) => {
		registry?.noteAutoRunFinal(agentId, payload);
	});

	sweepTimer = setInterval(() => registry?.sweepExpired(), SWEEP_INTERVAL_MS);
	// Never hold the process open just to sweep callbacks.
	sweepTimer.unref?.();

	return registry;
}

/** The live registry, or null when dispatch callbacks are not wired yet. */
export function getDispatchCallbackRegistry(): DispatchCallbackRegistry | null {
	return registry;
}

export function disposeDispatchCallbacks(): void {
	unsubscribeAutoRun?.();
	unsubscribeAutoRun = null;
	if (sweepTimer) clearInterval(sweepTimer);
	sweepTimer = null;
	registry?.dispose();
	registry = null;
}

async function deliverCallback(
	fire: DispatchCallbackFire,
	deps: DispatchCallbackServiceDeps
): Promise<void> {
	const { entry } = fire;
	let output: string | undefined;
	try {
		output = await deps.getTargetOutput?.(entry.targetAgentId, entry.createdAt);
	} catch (error) {
		deps.logger?.warn(
			`Failed to read target output for ${entry.callbackId}: ${String(error)}`,
			LOG_CONTEXT
		);
	}

	const prompt = renderCallbackPrompt({ fire, output });

	try {
		let result = await deps.enqueue(entry.callerAgentId, prompt, entry.callerTabId);

		// The caller closed its `--callback-tab` while the dispatch was running, so
		// the wake has nowhere specific to land. Rather than drop it (the whole
		// class of failure V1/W1 document), retry once at agent level - the exact
		// path a `--notify-on-complete` without `--callback-tab` already takes, so
		// the notification lands in the caller's active tab where the user sees it.
		// Only this cause is retried: dropping the tab id fixes none of the others.
		if (!result.success && entry.callerTabId && result.reason === 'tab-not-found') {
			deps.logger?.info(
				`Callback ${entry.callbackId}: caller tab ${entry.callerTabId} no longer exists, delivering to ${entry.callerAgentId} at agent level instead`,
				LOG_CONTEXT
			);
			result = await deps.enqueue(entry.callerAgentId, prompt);
		}

		if (!result.success) {
			deps.logger?.warn(
				`Callback ${entry.callbackId} could not be delivered to ${entry.callerAgentId}: ${result.error ?? 'unknown error'}`,
				LOG_CONTEXT
			);
			return;
		}
		deps.logger?.info(
			`Callback ${entry.callbackId} delivered to ${entry.callerAgentId} (status=${fire.status})`,
			LOG_CONTEXT
		);
	} catch (error) {
		deps.logger?.warn(`Callback ${entry.callbackId} delivery threw: ${String(error)}`, LOG_CONTEXT);
	}
}

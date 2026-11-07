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
	/**
	 * Open a new background AI tab in the caller agent with the prompt as its
	 * first turn. Used when the callback has no tab of its own to return to.
	 */
	openTab: (agentId: string, prompt: string) => Promise<{ success: boolean; error?: string }>;
	/** Best-effort result text for the finished dispatch. */
	getTargetOutput?: (
		agentId: string,
		since: number
	) => Promise<string | undefined> | string | undefined;
	/** Called only after the parent queue/new-tab accepted delivery. */
	onDelivered?: (fire: DispatchCallbackFire) => void | Promise<void>;
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

	// A callback only ever lands in the conversation that asked for it. With no
	// such tab it opens a fresh one, never the caller's ACTIVE tab: that tab is
	// whatever the user happens to be reading when the dispatch finishes, so the
	// result arrived mid-thread in an unrelated conversation that then had to make
	// sense of a plan it never made. Two cases have no tab: the dispatch came from
	// a run with no tab at all (a Cue or bot run, which has exited by now), or the
	// `--callback-tab` was closed while the dispatch ran.
	const openTab = () => deps.openTab(entry.callerAgentId, prompt);
	try {
		let result: { success: boolean; error?: string; reason?: string };
		if (!entry.callerTabId) {
			deps.logger?.info(
				`Callback ${entry.callbackId}: no caller tab, delivering to a new tab in ${entry.callerAgentId}`,
				LOG_CONTEXT
			);
			result = await openTab();
		} else {
			result = await deps.enqueue(entry.callerAgentId, prompt, entry.callerTabId);
			// Only a closed tab is retried: a new tab fixes none of the other causes.
			if (!result.success && result.reason === 'tab-not-found') {
				deps.logger?.info(
					`Callback ${entry.callbackId}: caller tab ${entry.callerTabId} no longer exists, delivering to a new tab in ${entry.callerAgentId} instead`,
					LOG_CONTEXT
				);
				result = await openTab();
			}
		}

		if (!result.success) {
			deps.logger?.warn(
				`Callback ${entry.callbackId} could not be delivered to ${entry.callerAgentId}: ${result.error ?? 'unknown error'}`,
				LOG_CONTEXT
			);
			return;
		}
		await deps.onDelivered?.(fire);
		deps.logger?.info(
			`Callback ${entry.callbackId} delivered to ${entry.callerAgentId} (status=${fire.status})`,
			LOG_CONTEXT
		);
	} catch (error) {
		deps.logger?.warn(`Callback ${entry.callbackId} delivery threw: ${String(error)}`, LOG_CONTEXT);
	}
}

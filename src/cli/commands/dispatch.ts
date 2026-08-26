// Dispatch command - hand off a prompt to the Maestro desktop app and return
// addressable tab/session IDs so callers (Maestro-Discord, Cue) can address
// the same tab on follow-up calls without owning a persistent channel.

import { resolveAgentId, readSettingValue } from '../services/storage';
import { withMaestroClient, UnsupportedCommandError } from '../services/maestro-client';
import { getSettingDefault } from '../../shared/settingsMetadata';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';

export interface DispatchOptions {
	newTab?: boolean;
	/** Tab id within the target agent. Mutually exclusive with --new-tab. */
	tab?: string;
	force?: boolean;
	/** Explicitly ask for background placement of a `--new-tab` tab (the default). */
	background?: boolean;
	/** Commander sets this to `true` when `--focus` is passed. Unset/false is the
	 *  default and dispatches in the background: the desktop delivers the prompt
	 *  without switching to or focusing the target agent/tab. Only `focus === true`
	 *  brings the target to the foreground. */
	focus?: boolean;
	/** When true, queue the prompt into the target agent's execution queue if the
	 *  tab is busy (instead of rejecting). Idle target dispatches immediately.
	 *  Mutually exclusive with --new-tab and --force. */
	queue?: boolean;
	/** Alias for `queue`. */
	wait?: boolean;
	/**
	 * Agent to wake with a real turn when THIS dispatch finishes. The callback is
	 * correlated to (target agent, target tab) established at dispatch time, so
	 * other runs of the same agent do not trigger it. Requires --new-tab or --tab.
	 */
	notifyOnComplete?: string;
	/** Specific caller tab to wake. Defaults to the caller's active AI tab. */
	callbackTab?: string;
	/** Overrides the default callback prompt body ({{DISPATCH_*}} substituted). */
	callbackPrompt?: string;
	/** Give up and fire a `timeout` callback after this many seconds. */
	callbackTimeout?: string;
}

/** Hard cap mirrored from the main-process registry (24h). */
const MAX_CALLBACK_TIMEOUT_SECONDS = 24 * 60 * 60;

export interface DispatchResponse {
	success: boolean;
	agentId?: string;
	/** Tab id the prompt was delivered to. Identical to `tabId` - the duplicate
	 *  field is kept so polling consumers can use either name. */
	sessionId?: string | null;
	tabId?: string | null;
	error?: string;
	code?: string;
	/** True when the prompt was queued (target busy); false when dispatched now.
	 *  Only set for the --queue path. */
	queued?: boolean;
	/** 1-based position in the execution queue (only when queued). */
	queuePosition?: number;
	/** Id of the queued item (only when queued); usable with `queue remove`. */
	itemId?: string;
	/** Id of the armed dispatch callback (only with --notify-on-complete). */
	callbackId?: string;
	/** Caller agent that will be woken when this dispatch finishes. */
	notifyOnComplete?: string;
}

/**
 * Validate and normalize the `--notify-on-complete` family. Returns the fields
 * to merge into the outgoing websocket message, or an error response.
 *
 * The callback is bound to a specific tab, so an explicit target tab is
 * mandatory: without `--new-tab` or `--tab` the dispatch lands in whichever tab
 * happens to be active, and there is nothing stable to correlate a completion
 * against.
 */
function buildCallbackFields(
	options: DispatchOptions,
	targetAgentId: string
):
	| { ok: true; fields: Record<string, unknown>; callerAgentId?: string }
	| { ok: false; response: DispatchResponse } {
	const hasCallbackModifier =
		options.callbackTab !== undefined ||
		options.callbackPrompt !== undefined ||
		options.callbackTimeout !== undefined;

	if (!options.notifyOnComplete) {
		if (hasCallbackModifier) {
			return {
				ok: false,
				response: {
					success: false,
					error:
						'--callback-tab / --callback-prompt / --callback-timeout require --notify-on-complete',
					code: 'INVALID_OPTIONS',
				},
			};
		}
		return { ok: true, fields: {} };
	}

	if (!options.newTab && !options.tab) {
		return {
			ok: false,
			response: {
				success: false,
				error:
					'--notify-on-complete requires --new-tab or --tab (the callback is correlated to a specific tab)',
				code: 'INVALID_OPTIONS',
			},
		};
	}

	let callerAgentId: string;
	try {
		callerAgentId = resolveAgentId(options.notifyOnComplete);
	} catch (error) {
		const msg = error instanceof Error ? error.message : 'Unknown error';
		return { ok: false, response: { success: false, error: msg, code: 'AGENT_NOT_FOUND' } };
	}

	// A callback that wakes the tab it is waiting on never terminates.
	if (
		callerAgentId === targetAgentId &&
		(!options.callbackTab || (options.tab && options.callbackTab === options.tab))
	) {
		return {
			ok: false,
			response: {
				success: false,
				error:
					'--notify-on-complete cannot target the dispatch target itself (would wake the tab it waits on)',
				code: 'INVALID_OPTIONS',
			},
		};
	}

	let callbackTimeoutSeconds: number | undefined;
	if (options.callbackTimeout !== undefined) {
		const parsed = Number(options.callbackTimeout);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			return {
				ok: false,
				response: {
					success: false,
					error: '--callback-timeout must be a positive number of seconds',
					code: 'INVALID_OPTIONS',
				},
			};
		}
		callbackTimeoutSeconds = Math.min(Math.round(parsed), MAX_CALLBACK_TIMEOUT_SECONDS);
	}

	return {
		ok: true,
		callerAgentId,
		fields: {
			notifyOnComplete: callerAgentId,
			...(options.callbackTab ? { callbackTab: options.callbackTab } : {}),
			...(options.callbackPrompt ? { callbackPrompt: options.callbackPrompt } : {}),
			...(callbackTimeoutSeconds !== undefined ? { callbackTimeout: callbackTimeoutSeconds } : {}),
		},
	};
}

function emitErrorJson(error: string, code: string): void {
	console.log(JSON.stringify({ success: false, error, code }, null, 2));
}

/**
 * Map a thrown dispatch/enqueue error to the stable DispatchResponse error
 * codes downstream consumers (Maestro-Discord, Cue) rely on. Shared by the
 * send_command and enqueue_command paths so both surface "app down" vs
 * "session not found" vs "unsupported build" identically.
 */
/**
 * The prompt landed but the desktop never acked a callbackId - an older desktop
 * build that ignores `notifyOnComplete`, or an arming path that silently did
 * nothing. Reporting success here would leave the caller waiting forever for a
 * wake-up that nobody armed, so fail loudly with a dedicated code and hand back
 * the tab id so the caller can still poll or re-dispatch.
 */
function callbackNotArmedResponse(agentId: string, tabId: string | null): DispatchResponse {
	return {
		success: false,
		agentId,
		sessionId: tabId,
		tabId,
		error:
			'Prompt was dispatched but the desktop did not arm the completion callback (no callbackId acknowledged). No wake-up will arrive.',
		code: 'CALLBACK_NOT_ARMED',
	};
}

function mapDispatchError(error: unknown, agentId: string): DispatchResponse {
	if (error instanceof UnsupportedCommandError) {
		return { success: false, error: error.message, code: 'UNSUPPORTED' };
	}
	const msg = error instanceof Error ? error.message : String(error);
	const lowerMsg = msg.toLowerCase();
	if (
		lowerMsg.includes('econnrefused') ||
		lowerMsg.includes('connection refused') ||
		lowerMsg.includes('websocket') ||
		lowerMsg.includes('enotfound') ||
		lowerMsg.includes('etimedout') ||
		lowerMsg.includes('maestro desktop app is not running') ||
		lowerMsg.includes('discovery file is stale') ||
		lowerMsg.includes('not connected to maestro')
	) {
		return {
			success: false,
			error: 'Maestro desktop is not running or not reachable',
			code: 'MAESTRO_NOT_RUNNING',
		};
	}
	if (
		lowerMsg.includes('session not found') ||
		lowerMsg.includes('no such session') ||
		lowerMsg.includes('unknown session')
	) {
		return { success: false, error: `Session not found: ${agentId}`, code: 'SESSION_NOT_FOUND' };
	}
	if (msg.startsWith('NEW_TAB_NO_ID:')) {
		return {
			success: false,
			error:
				'Maestro desktop acknowledged --new-tab without returning a tab id (cannot chain dispatch)',
			code: 'NEW_TAB_NO_ID',
		};
	}
	return { success: false, error: `Command failed: ${msg}`, code: 'COMMAND_FAILED' };
}

/**
 * Run the dispatch flow. Exported separately from the CLI action so
 * programmatic callers (e.g., Maestro-Discord, Cue) and tests can invoke
 * dispatch logic without re-shelling out.
 */
export async function runDispatch(
	agentIdArg: string,
	message: string,
	options: DispatchOptions
): Promise<DispatchResponse> {
	if (options.newTab && options.tab) {
		return {
			success: false,
			error: '--new-tab cannot be combined with --tab',
			code: 'INVALID_OPTIONS',
		};
	}

	// `--new-tab --force` is meaningless - a freshly created tab can never be
	// busy, so the bypass-busy semantics of --force don't apply. Reject the
	// combo rather than silently ignoring --force, which would mismatch the
	// help text and confuse callers debugging why nothing is being bypassed.
	if (options.newTab && options.force) {
		return {
			success: false,
			error: '--new-tab cannot be combined with --force (a new tab is never busy)',
			code: 'INVALID_OPTIONS',
		};
	}

	// --queue is the safe counterpart to --force: instead of bypassing the busy
	// guard, it respects it by waiting in line. Combining the two is
	// contradictory. And a freshly created --new-tab is never busy, so there is
	// no line to join - reject both combos rather than silently ignoring --queue.
	const queue = options.queue === true || options.wait === true;
	if (queue && options.newTab) {
		return {
			success: false,
			error: '--queue cannot be combined with --new-tab (a fresh tab is never busy)',
			code: 'INVALID_OPTIONS',
		};
	}
	if (queue && options.force) {
		return {
			success: false,
			error:
				'--queue cannot be combined with --force (--queue waits for the busy guard; --force bypasses it)',
			code: 'INVALID_OPTIONS',
		};
	}

	// --force is gated by the `allowConcurrentSend` setting. It's off by default
	// because concurrent writes can interleave responses in the target tab.
	if (options.force) {
		const stored = readSettingValue('allowConcurrentSend');
		const allowConcurrentSend =
			stored === undefined ? (getSettingDefault('allowConcurrentSend') as boolean) : stored;
		if (allowConcurrentSend !== true) {
			return {
				success: false,
				error:
					'--force is disabled. Enable it with: maestro-cli settings set allowConcurrentSend true',
				code: 'FORCE_NOT_ALLOWED',
			};
		}
	}

	let agentId: string;
	try {
		agentId = resolveAgentId(agentIdArg);
	} catch (error) {
		const msg = error instanceof Error ? error.message : 'Unknown error';
		return { success: false, error: msg, code: 'AGENT_NOT_FOUND' };
	}

	// Dispatch runs in the background by default (no focus stealing); only an
	// explicit `--focus` (Commander: focus === true) tells the desktop to switch
	// to and focus the target agent/tab. The `background` bit is threaded to both
	// the new-tab and existing-tab command paths.
	const background = resolveBackgroundFlag(options, 'dispatch-new-tab');

	const callback = buildCallbackFields(options, agentId);
	if (!callback.ok) return callback.response;

	// --queue routes through the renderer's authoritative execution queue.
	if (queue) {
		return runQueueDispatch(agentId, message, options, background, callback.fields);
	}
	try {
		const dispatched = await withMaestroClient(async (client) => {
			if (options.newTab) {
				const result = await client.sendCommand<{ tabId?: string; callbackId?: string }>(
					{
						type: 'new_ai_tab_with_prompt',
						sessionId: agentId,
						prompt: message,
						// Background by default: a dispatched prompt is an agent talking to
						// an agent, and the tab id we return is how the caller follows it.
						...(background ? { background: true } : {}),
						...callback.fields,
					},
					'new_ai_tab_with_prompt_result'
				);
				// `--new-tab`'s sole purpose is to surface a fresh tab id for
				// chaining (`dispatch --tab <tabId>`). If the desktop acked
				// without one (older build / race), fail loudly with a dedicated
				// code so consumers (Maestro-Discord, Cue) can distinguish this
				// from a generic command failure instead of silently returning
				// `tabId: null` from a "successful" response.
				if (!result.tabId) {
					throw new Error('NEW_TAB_NO_ID: new_ai_tab_with_prompt acknowledged without a tabId');
				}
				return { tabId: result.tabId, callbackId: result.callbackId };
			}
			const result = await client.sendCommand<{ tabId?: string; callbackId?: string }>(
				{
					type: 'send_command',
					sessionId: agentId,
					command: message,
					inputMode: 'ai',
					...(options.tab ? { tabId: options.tab } : {}),
					...(options.force ? { force: true } : {}),
					...(background ? { background: true } : {}),
					...callback.fields,
				},
				'command_result'
			);
			return { tabId: result.tabId, callbackId: result.callbackId };
		});
		// `--tab <tabId>` is the authoritative target; the desktop handler
		// echoes it back when we pass one. If the desktop omitted it (older
		// build / no active tab known), fall back to the value the caller
		// supplied so callers can still chain dispatches deterministically.
		const resolvedTabId = dispatched.tabId ?? options.tab ?? null;
		if (callback.callerAgentId && !dispatched.callbackId) {
			return callbackNotArmedResponse(agentId, resolvedTabId);
		}
		return {
			success: true,
			agentId,
			sessionId: resolvedTabId,
			tabId: resolvedTabId,
			...(dispatched.callbackId ? { callbackId: dispatched.callbackId } : {}),
			...(callback.callerAgentId ? { notifyOnComplete: callback.callerAgentId } : {}),
		};
	} catch (error) {
		return mapDispatchError(error, agentId);
	}
}

/**
 * `dispatch --queue` path. Routes the prompt to the renderer's authoritative
 * execution queue via the enqueue_command round-trip. A busy target joins the
 * queue (FIFO by timestamp); an idle target dispatches immediately. Returns the
 * tab/session id plus queue position so scripts can track status. The queue
 * lives in the desktop renderer, so this fails with MAESTRO_NOT_RUNNING when the
 * app is down - exactly like every other dispatch mode.
 */
async function runQueueDispatch(
	agentId: string,
	message: string,
	options: DispatchOptions,
	background: boolean,
	callbackFields: Record<string, unknown>
): Promise<DispatchResponse> {
	try {
		const result = await withMaestroClient(async (client) =>
			client.sendCommand<{
				success?: boolean;
				tabId?: string;
				queued?: boolean;
				queuePosition?: number;
				queueLength?: number;
				itemId?: string;
				callbackId?: string;
				error?: string;
			}>(
				{
					type: 'enqueue_command',
					sessionId: agentId,
					command: message,
					inputMode: 'ai',
					...(options.tab ? { tabId: options.tab } : {}),
					...(background ? { background: true } : {}),
					...callbackFields,
				},
				'enqueue_command_result'
			)
		);

		if (result.success === false) {
			const err = result.error ?? 'Enqueue failed';
			const lower = err.toLowerCase();
			const code = lower.includes('session not found')
				? 'SESSION_NOT_FOUND'
				: lower.startsWith('tab not found')
					? 'TAB_NOT_FOUND'
					: 'ENQUEUE_FAILED';
			return { success: false, error: err, code };
		}

		const resolvedTabId = result.tabId ?? options.tab ?? null;
		if (typeof callbackFields.notifyOnComplete === 'string' && !result.callbackId) {
			return callbackNotArmedResponse(agentId, resolvedTabId);
		}
		return {
			success: true,
			agentId,
			sessionId: resolvedTabId,
			tabId: resolvedTabId,
			queued: result.queued === true,
			...(result.queuePosition !== undefined ? { queuePosition: result.queuePosition } : {}),
			...(result.itemId ? { itemId: result.itemId } : {}),
			...(result.callbackId ? { callbackId: result.callbackId } : {}),
			...(typeof callbackFields.notifyOnComplete === 'string'
				? { notifyOnComplete: callbackFields.notifyOnComplete }
				: {}),
		};
	} catch (error) {
		return mapDispatchError(error, agentId);
	}
}

export async function dispatch(
	agentIdArg: string,
	message: string,
	options: DispatchOptions
): Promise<void> {
	const result = await runDispatch(agentIdArg, message, options);

	if (!result.success) {
		emitErrorJson(result.error ?? 'Unknown error', result.code ?? 'UNKNOWN');
		process.exit(1);
		return;
	}

	console.log(
		JSON.stringify(
			{
				success: true,
				agentId: result.agentId,
				sessionId: result.sessionId,
				tabId: result.tabId,
				...(result.queued !== undefined ? { queued: result.queued } : {}),
				...(result.queuePosition !== undefined ? { queuePosition: result.queuePosition } : {}),
				...(result.itemId ? { itemId: result.itemId } : {}),
				...(result.callbackId ? { callbackId: result.callbackId } : {}),
				...(result.notifyOnComplete ? { notifyOnComplete: result.notifyOnComplete } : {}),
			},
			null,
			2
		)
	);
}

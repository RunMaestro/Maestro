// Dispatch command - hand off a prompt to the Maestro desktop app and return
// addressable tab/session IDs so callers (Maestro-Discord, Cue) can address
// the same tab on follow-up calls without owning a persistent channel.

import { resolveAgentId, readSettingValue } from '../services/storage';
import { withMaestroClient, UnsupportedCommandError } from '../services/maestro-client';
import { getSettingDefault } from '../../shared/settingsMetadata';

export interface DispatchOptions {
	newTab?: boolean;
	/** Tab id within the target agent. Mutually exclusive with --new-tab. */
	tab?: string;
	force?: boolean;
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
}

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
	const background = options.focus !== true;

	// --queue routes through the renderer's authoritative execution queue.
	if (queue) {
		return runQueueDispatch(agentId, message, options, background);
	}
	try {
		const tabId = await withMaestroClient(async (client) => {
			if (options.newTab) {
				const result = await client.sendCommand<{ tabId?: string }>(
					{
						type: 'new_ai_tab_with_prompt',
						sessionId: agentId,
						prompt: message,
						...(background ? { background: true } : {}),
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
				return result.tabId;
			}
			const result = await client.sendCommand<{ tabId?: string }>(
				{
					type: 'send_command',
					sessionId: agentId,
					command: message,
					inputMode: 'ai',
					...(options.tab ? { tabId: options.tab } : {}),
					...(options.force ? { force: true } : {}),
					...(background ? { background: true } : {}),
				},
				'command_result'
			);
			return result.tabId;
		});
		// `--tab <tabId>` is the authoritative target; the desktop handler
		// echoes it back when we pass one. If the desktop omitted it (older
		// build / no active tab known), fall back to the value the caller
		// supplied so callers can still chain dispatches deterministically.
		const resolvedTabId = tabId ?? options.tab ?? null;
		return {
			success: true,
			agentId,
			sessionId: resolvedTabId,
			tabId: resolvedTabId,
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
	background: boolean
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
				error?: string;
			}>(
				{
					type: 'enqueue_command',
					sessionId: agentId,
					command: message,
					inputMode: 'ai',
					...(options.tab ? { tabId: options.tab } : {}),
					...(background ? { background: true } : {}),
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
		return {
			success: true,
			agentId,
			sessionId: resolvedTabId,
			tabId: resolvedTabId,
			queued: result.queued === true,
			...(result.queuePosition !== undefined ? { queuePosition: result.queuePosition } : {}),
			...(result.itemId ? { itemId: result.itemId } : {}),
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
			},
			null,
			2
		)
	);
}

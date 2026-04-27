// Dispatch command — hand off a prompt to the Maestro desktop app and return
// addressable tab/session IDs. Splits the desktop-handoff half of `send --live`
// into a standalone verb so callers (Maestro-Discord, Cue) can address the same
// tab on follow-up calls without owning a persistent channel.

import { resolveAgentId, readSettingValue } from '../services/storage';
import { withMaestroClient } from '../services/maestro-client';
import { getSettingDefault } from '../../shared/settingsMetadata';

export interface DispatchOptions {
	newTab?: boolean;
	/** Tab id within the target agent. Mutually exclusive with --new-tab. */
	session?: string;
	force?: boolean;
}

export interface DispatchResponse {
	success: boolean;
	agentId?: string;
	/** Tab id the prompt was delivered to. Identical to `tabId` — the duplicate
	 *  field is kept so polling consumers can use either name. */
	sessionId?: string | null;
	tabId?: string | null;
	error?: string;
	code?: string;
}

function emitErrorJson(error: string, code: string): void {
	console.log(JSON.stringify({ success: false, error, code }, null, 2));
}

/**
 * Run the dispatch flow. Exported separately from the CLI action so
 * `send --live` can delegate here during the deprecation window without
 * duplicating logic or re-shelling out.
 */
export async function runDispatch(
	agentIdArg: string,
	message: string,
	options: DispatchOptions
): Promise<DispatchResponse> {
	if (options.newTab && options.session) {
		return {
			success: false,
			error: '--new-tab cannot be combined with --session',
			code: 'INVALID_OPTIONS',
		};
	}

	// `--new-tab --force` is meaningless — a freshly created tab can never be
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

	try {
		const tabId = await withMaestroClient(async (client) => {
			if (options.newTab) {
				const result = await client.sendCommand<{ tabId?: string }>(
					{ type: 'new_ai_tab_with_prompt', sessionId: agentId, prompt: message },
					'new_ai_tab_with_prompt_result'
				);
				// `--new-tab`'s sole purpose is to surface a fresh tab id for
				// chaining (`dispatch --session <tabId>`). If the desktop acked
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
					...(options.session ? { tabId: options.session } : {}),
					...(options.force ? { force: true } : {}),
				},
				'command_result'
			);
			return result.tabId;
		});
		// `--session <tabId>` is the authoritative target; the desktop handler
		// echoes it back when we pass one. If the desktop omitted it (older
		// build / no active tab known), fall back to the value the caller
		// supplied so callers can still chain dispatches deterministically.
		const resolvedTabId = tabId ?? options.session ?? null;
		return {
			success: true,
			agentId,
			sessionId: resolvedTabId,
			tabId: resolvedTabId,
		};
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		const lowerMsg = msg.toLowerCase();
		// Map MaestroClient's own throw messages alongside socket-level ones.
		// MaestroClient throws three distinct strings before any WebSocket
		// activity ("Maestro desktop app is not running", "Maestro discovery
		// file is stale (app may have crashed)", "Not connected to Maestro");
		// without these, those errors fall through to COMMAND_FAILED and break
		// the error-code contract downstream consumers (Maestro-Discord, Cue)
		// rely on to distinguish "app down" from "command rejected".
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
			return {
				success: false,
				error: `Session not found: ${agentId}`,
				code: 'SESSION_NOT_FOUND',
			};
		}
		if (msg.startsWith('NEW_TAB_NO_ID:')) {
			return {
				success: false,
				error:
					'Maestro desktop acknowledged --new-tab without returning a tab id (cannot chain dispatch)',
				code: 'NEW_TAB_NO_ID',
			};
		}
		return {
			success: false,
			error: `Command failed: ${msg}`,
			code: 'COMMAND_FAILED',
		};
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
			},
			null,
			2
		)
	);
}

/**
 * What the composer does with the client: send a message, stop the running
 * turn, and decide what `Ctrl-C` means. Pure of Ink and React; the App passes
 * in the client and shows the notices this returns.
 */

import type { ClientResult, MaestroClient } from '../../shared/maestro-lib';
import { isBlankComposer, type ComposerState } from './draft';

/** A second `Ctrl-C` within this long after the first quits the TUI. */
export const QUIT_WINDOW_MS = 1000;

export type CtrlCDecision =
	/** A second press inside the window. */
	| 'quit'
	/** A turn is running: stop it, and arm the window. */
	| 'interrupt'
	/** Nothing is running: say so, and arm the window. */
	| 'arm-quit';

export function decideCtrlC(input: {
	now: number;
	/** When the previous `Ctrl-C` was pressed, if one was. */
	lastAt: number | undefined;
	running: boolean;
}): CtrlCDecision {
	if (input.lastAt !== undefined && input.now - input.lastAt <= QUIT_WINDOW_MS) return 'quit';
	return input.running ? 'interrupt' : 'arm-quit';
}

export const INTERRUPT_NOTICE = 'Interrupting the turn. Press Ctrl-C again to quit.';
export const ARM_QUIT_NOTICE = 'Nothing is running. Press Ctrl-C again to quit.';

export type SendOutcome =
	| { status: 'empty' }
	| { status: 'sent'; queued: boolean; notice: string }
	| { status: 'failed'; message: string };

/**
 * Sends the draft to the tab (CH-2). The host runs it now when the agent is
 * idle and queues it behind the current turn when not (CH-4); the notice says
 * which. A blank draft sends nothing and makes no call.
 */
export async function submitDraft(
	client: MaestroClient,
	agentId: string,
	tabId: string,
	draft: ComposerState
): Promise<SendOutcome> {
	if (isBlankComposer(draft)) return { status: 'empty' };
	const result = await client.turns.send(agentId, tabId, { text: draft.text.trimEnd() });
	if (!result.ok) return { status: 'failed', message: result.error.message };
	if (result.value.status === 'queued') {
		const { position, queueLength } = result.value;
		return {
			status: 'sent',
			queued: true,
			notice: `Queued: ${position} of ${queueLength} waiting behind the running turn.`,
		};
	}
	return { status: 'sent', queued: false, notice: '' };
}

/** Stops the tab's running turn (CH-4). Returns the line for the status bar. */
export async function interruptTurn(
	client: MaestroClient,
	agentId: string,
	tabId: string
): Promise<ClientResult<string>> {
	const result = await client.turns.interrupt(agentId, tabId);
	if (!result.ok) return result;
	return {
		ok: true,
		value: result.value.stopped ? INTERRUPT_NOTICE : 'No turn is running on this tab.',
	};
}

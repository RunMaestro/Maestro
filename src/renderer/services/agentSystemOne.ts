/**
 * Switching System One off for one agent, from the renderer.
 *
 * One entry for the Models tab switch in Edit Agent, so the write goes through
 * the one validator (`parseSystemOneOptOutEdit`) and is FLUSHED. The flush is
 * the part that matters: the main process reads an agent's opt-out from its own
 * sessions store, both when it answers a `maestro-cli s1` request and when it
 * decides whether the agent's system prompt carries the System One section, and
 * the renderer's ordinary persistence is debounced by two seconds. A switch that
 * was only written to the renderer store would not be in force for a request
 * sent straight after it.
 *
 * `maestro-cli update-agent --system-one` reaches the same validator through
 * the `update_session_config` handler, which flushes the whole patch itself.
 */

import { parseSystemOneOptOutEdit } from '../../shared/local-models/system-one-agent';
import { updateSessionWith, useSessionStore } from '../stores/sessionStore';
import { flushAgentToStore } from './agentGateway';

export type SetAgentSystemOneOptOutResult =
	| { ok: true; optOut: boolean }
	| { ok: false; error: string };

/**
 * Store whether one agent is switched off System One. `true` switches it off;
 * `false` or `null` removes the field, so the agent follows "Let agents use
 * System One". Resolves once main holds the new value, so the next request and
 * the next spawn read it.
 */
export async function setAgentSystemOneOptOut(
	sessionId: string,
	value: unknown
): Promise<SetAgentSystemOneOptOutResult> {
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	if (!session) return { ok: false, error: 'Agent not found' };

	const edit = parseSystemOneOptOutEdit(value);
	if (!edit.ok) return edit;

	if (session.systemOneOptOut !== edit.optOut) {
		updateSessionWith(sessionId, (s) => ({ ...s, systemOneOptOut: edit.optOut }));
		await flushAgentToStore(sessionId);
	}
	return { ok: true, optOut: edit.optOut === true };
}

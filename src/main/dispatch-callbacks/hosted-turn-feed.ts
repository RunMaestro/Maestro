/**
 * `dispatch <hosted agent> --notify-on-complete`: the dispatched turn runs on the agent's
 * Federation host, so no process here spawns or exits for it. The peer mirror's turn events for
 * the hosted record's tab stand in for them, keyed by the same `{agentId}-ai-{tabId}` the registry
 * minted for the local record (`buildProcessSessionId()`): a turn that starts is the spawn, its
 * text is the output, and its outcome is the exit. A local or SSH agent's turn feeds the registry
 * from its process (`setupDispatchCallbackListener()`), so the callback fires the same way in every
 * mode.
 */

import { findLiftedAgent } from '../../shared/maestro-lib/agents/lift-pointer';
import type { MirrorPush } from '../../shared/maestro-lib/client/peer-mirror';
import { buildProcessSessionId, type DispatchCallbackRegistry } from './dispatch-callback-registry';

export type DispatchCallbackFeed = Pick<
	DispatchCallbackRegistry,
	'noteSpawn' | 'noteData' | 'noteExit'
>;

/** Feed one mirror push into the registry when it is a turn event of a hosted record's tab. */
export function feedHostedTurnToDispatchCallbacks(
	push: MirrorPush,
	readAgents: () => readonly { id: string; liftedTo?: unknown }[],
	registry: DispatchCallbackFeed | null
): void {
	if (!registry || push.event.type !== 'turn') return;
	const { agentId, tabId, event } = push.event;
	if (event.kind !== 'started' && event.kind !== 'text' && event.kind !== 'outcome') return;
	const local = findLiftedAgent(readAgents(), push.peerId, agentId);
	if (!local) return;
	const processSessionId = buildProcessSessionId(local.id, tabId);
	if (event.kind === 'started') registry.noteSpawn(processSessionId);
	else if (event.kind === 'text') registry.noteData(processSessionId, event.text);
	else registry.noteExit(processSessionId, event.exitCode ?? null);
}

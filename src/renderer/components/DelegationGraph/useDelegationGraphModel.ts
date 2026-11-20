/**
 * useDelegationGraphModel - the Delegation Graph of one scope, from the live
 * agent list.
 *
 * `buildDelegationGraph` resolves every agent's roster, so it must not run on
 * every render, and the session store replaces its `sessions` array on every
 * batch of streamed output. The subscription therefore compares only the
 * fields the graph is built from (`delegationRosterEquality`): the model is
 * rebuilt when an agent is added, removed, renamed, moved to another group, or
 * has a peer field edited, and at no other time.
 *
 * The group list is not an input. A group scope matches on `groupId`, which is
 * a field of the agent.
 *
 * `useAgentsOffDelegationGraph` is the other half of the same read: the agents
 * a model does NOT draw, which is what the canvas offers to add.
 */

import { useMemo } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import {
	agentsOffGraph,
	buildDelegationGraph,
	type DelegationGraphModel,
	type DelegationGraphScope,
	type DelegationOffGraphAgent,
} from '../../../shared/delegationGraph';
import { delegationRosterEquality } from '../../stores/sessionEquality';
import { useSessionStore } from '../../stores/sessionStore';
import type { Session } from '../../types';

/** No agent placed by hand. One array, so the model's memo deps stay stable. */
const NONE_PLACED: readonly string[] = Object.freeze([]);

/** The live agents, replaced only when a field the graph reads has changed. */
function useRosterSessions(): Session[] {
	return useStoreWithEqualityFn(
		useSessionStore,
		(store) => store.sessions,
		delegationRosterEquality
	);
}

/**
 * `placedIds` are the agents the user put on the canvas by hand (see
 * `DelegationGraphOptions.placedIds`). Pass a stable array: a new one on every
 * render rebuilds the model on every render.
 */
export function useDelegationGraphModel(
	scope: DelegationGraphScope,
	placedIds: readonly string[] = NONE_PLACED
): DelegationGraphModel {
	const sessions = useRosterSessions();
	// The scope is keyed by its one varying field, so a caller that builds a new
	// scope object on every render does not rebuild the model.
	const groupId = scope.kind === 'group' ? scope.groupId : undefined;
	const sessionId = scope.kind === 'agent' ? scope.sessionId : undefined;
	return useMemo(
		() =>
			buildDelegationGraph(
				sessionId !== undefined
					? { kind: 'agent', sessionId }
					: groupId === undefined
						? { kind: 'all' }
						: { kind: 'group', groupId },
				sessions,
				{ placedIds }
			),
		[groupId, sessionId, sessions, placedIds]
	);
}

/** Every live agent `model` has no node for, sorted by name. */
export function useAgentsOffDelegationGraph(
	model: DelegationGraphModel
): DelegationOffGraphAgent[] {
	const sessions = useRosterSessions();
	return useMemo(() => agentsOffGraph(model, sessions), [model, sessions]);
}

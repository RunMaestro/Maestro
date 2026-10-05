import {
	buildAgentTree,
	type AgentRecord,
	type ClientError,
	type GroupRecord,
	type HostInfo,
	type MaestroEvent,
} from '../../shared/maestro-lib';
import type { AgentData } from './loadAgentData';

/** What the host last told the client: the agents and groups the TUI draws. */
export interface LiveState {
	agents: AgentRecord[];
	groups: GroupRecord[];
}

/**
 * Folds one client event into the live state. Pure. Tab events are ignored on
 * purpose: a tab change always travels with an `agent.updated` that carries the
 * whole record (the client's mirror raises both), so applying the agent event
 * is what moves the tab strip. Anything not about agents or groups returns the
 * same object, so React skips the render.
 */
export function applyClientEvent(state: LiveState, event: MaestroEvent): LiveState {
	switch (event.type) {
		case 'snapshot':
			return { agents: event.agents, groups: event.groups };
		case 'agent.added':
		case 'agent.updated': {
			const index = state.agents.findIndex((agent) => agent.id === event.agent.id);
			const agents =
				index < 0
					? [...state.agents, event.agent]
					: state.agents.map((agent, at) => (at === index ? event.agent : agent));
			return { ...state, agents };
		}
		case 'agent.removed':
			return state.agents.some((agent) => agent.id === event.agentId)
				? { ...state, agents: state.agents.filter((agent) => agent.id !== event.agentId) }
				: state;
		case 'groups.changed':
			return { ...state, groups: event.groups };
		default:
			return state;
	}
}

/** The agent tree for a live state. There are no store files to complain about. */
export function liveAgentData(state: LiveState): AgentData {
	return {
		agents: state.agents,
		sections: buildAgentTree(state.agents, state.groups),
		problems: [],
	};
}

/** Where the TUI's data comes from right now. */
export type SourceConnection =
	/** A client exists and is looking for a desktop; the file readers fill the screen meanwhile. */
	| { mode: 'connecting' }
	/** The Phase 2 file readers. `reason` says why no desktop is attached. */
	| { mode: 'files'; reason?: ClientError['code'] }
	| { mode: 'desktop'; host: HostInfo }
	/** The desktop was attached and dropped; the last data stays on screen while the client retries. */
	| { mode: 'lost'; host: HostInfo };

/**
 * What the status bar prints after `host: `. `readOnlyLabel` names why no client
 * was started at all (another TUI holds the directory, a store is corrupt); it
 * speaks for the plain `files` mode only, since a reason from a client that did
 * try is the more specific answer.
 */
export function hostLabelFor(connection: SourceConnection, readOnlyLabel?: string): string {
	switch (connection.mode) {
		case 'connecting':
			return 'connecting';
		case 'desktop':
			return connection.host.label;
		case 'lost':
			return `${connection.host.label} (reconnecting)`;
		case 'files':
			if (connection.reason === 'unsupported') return 'read-only (desktop too old)';
			if (connection.reason === 'unauthorized') return 'read-only (desktop refused)';
			return readOnlyLabel ?? 'read-only';
	}
}

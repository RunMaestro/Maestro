/**
 * The WebSocket client's mirror of the desktop's agents and groups.
 *
 * Pure state plus the events each change raises (R8 of
 * `Plans/maestro-tui-client-api.md`): every method that changes the mirror
 * returns the `MaestroEvent`s the change implies, carrying whole records, so
 * `ws-client.ts` only has to deliver them. No socket, no timers, no clock of
 * its own.
 *
 * Records are replaced, never mutated in place, so an event a consumer holds
 * keeps describing the state it announced.
 */

import type { AgentRecord, AITabRecord, GroupRecord } from '../store/records';
import { visibleAiTabsOf } from '../store/read-stores';
import type { MaestroEvent } from './types';

/** One tab as the bridge's typed projections carry it (`AITabData`). */
export interface ProjectedTab {
	id: string;
	agentSessionId?: string | null;
	name?: string | null;
	starred?: boolean;
	state?: 'idle' | 'busy';
	hasUnread?: boolean;
	usageStats?: unknown;
	createdAt?: number;
}

/** One agent as `get_sessions` projects it (`SessionData`): no `hidden`, no config fields (gap G9). */
export interface ProjectedAgent {
	id: string;
	name?: string;
	toolType?: string;
	state?: string;
	inputMode?: string;
	cwd?: string;
	groupId?: string | null;
	bookmarked?: boolean;
	activeTabId?: string;
	aiTabs?: ProjectedTab[];
}

/** The part of a `session_state_change` frame the mirror folds in. */
export interface StateChange {
	sessionId: string;
	state?: string;
	name?: string;
	toolType?: string;
	inputMode?: string;
	cwd?: string;
}

/** Deep equality for JSON-shaped values: what a record is made of. */
export function valuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, index) => valuesEqual(item, b[index]));
	}
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	for (const key of keys) {
		if (!valuesEqual(left[key], right[key])) return false;
	}
	return true;
}

const TAB_FIELDS: ReadonlyArray<keyof ProjectedTab> = [
	'agentSessionId',
	'name',
	'starred',
	'state',
	'hasUnread',
	'usageStats',
	'createdAt',
];

export class ClientMirror {
	private agents = new Map<string, AgentRecord>();
	private groups: GroupRecord[] = [];
	/** When each agent was last added or read in full, to protect a fresh agent from a stale projection. */
	private touchedAt = new Map<string, number>();

	constructor(private readonly now: () => number) {}

	// -- reads ---------------------------------------------------------------

	listAgents(): AgentRecord[] {
		return [...this.agents.values()];
	}

	getAgent(agentId: string): AgentRecord | undefined {
		return this.agents.get(agentId);
	}

	listGroups(): GroupRecord[] {
		return [...this.groups];
	}

	/** The tabs `tabs.list` returns: visible only, in strip order. */
	visibleTabs(agentId: string): AITabRecord[] | undefined {
		const agent = this.agents.get(agentId);
		return agent ? visibleAiTabsOf(agent) : undefined;
	}

	/** The agent's active tab when it is visible, else its first visible one. */
	resolveActiveTabId(agentId: string): string | undefined {
		const agent = this.agents.get(agentId);
		if (!agent) return undefined;
		const tabs = visibleAiTabsOf(agent);
		return tabs.find((tab) => tab.id === agent.activeTabId)?.id ?? tabs[0]?.id;
	}

	/** Ids of every tab the mirror holds that is mid-turn per its stored state. */
	busyTabs(): Array<{ agentId: string; tabId: string }> {
		const busy: Array<{ agentId: string; tabId: string }> = [];
		for (const agent of this.agents.values()) {
			for (const tab of agent.aiTabs ?? []) {
				if (tab?.state === 'busy') busy.push({ agentId: agent.id, tabId: tab.id });
			}
		}
		return busy;
	}

	// -- whole-state replacement --------------------------------------------

	/** Replace everything (connect, resync). Raises no events: the caller emits `snapshot`. */
	replace(agents: AgentRecord[], groups: GroupRecord[]): void {
		this.agents = new Map(agents.map((agent) => [agent.id, agent]));
		this.groups = [...groups];
		const at = this.now();
		this.touchedAt = new Map(agents.map((agent) => [agent.id, at]));
	}

	/**
	 * Fold a full read of every agent into the mirror: adds, updates, and
	 * removals, as events. Used when the reconcile poll finds an id it lacks.
	 */
	syncAgents(next: AgentRecord[]): MaestroEvent[] {
		const events: MaestroEvent[] = [];
		const nextIds = new Set(next.map((agent) => agent.id));
		for (const agent of next) events.push(...this.upsert(agent));
		for (const id of [...this.agents.keys()]) {
			if (!nextIds.has(id)) events.push(...this.remove(id));
		}
		return events;
	}

	// -- single-agent changes ------------------------------------------------

	/** Add or replace one agent from a full record. */
	upsert(record: AgentRecord): MaestroEvent[] {
		const before = this.agents.get(record.id);
		this.agents.set(record.id, record);
		this.touchedAt.set(record.id, this.now());
		return this.diff(before, record);
	}

	remove(agentId: string): MaestroEvent[] {
		if (!this.agents.delete(agentId)) return [];
		this.touchedAt.delete(agentId);
		return [{ type: 'agent.removed', agentId }];
	}

	setGroups(next: GroupRecord[]): MaestroEvent[] {
		if (valuesEqual(this.groups, next)) return [];
		this.groups = [...next];
		return [{ type: 'groups.changed', groups: this.listGroups() }];
	}

	/** Fold a `session_state_change`. An unknown agent is ignored: `session_added` covers it. */
	mergeStateChange(change: StateChange): MaestroEvent[] {
		const before = this.agents.get(change.sessionId);
		if (!before) return [];
		const next: AgentRecord = { ...before };
		if (change.state !== undefined) next.state = change.state as AgentRecord['state'];
		if (change.name !== undefined) next.name = change.name;
		if (change.toolType !== undefined) next.toolType = change.toolType;
		if (change.inputMode !== undefined) next.inputMode = change.inputMode;
		if (change.cwd !== undefined) next.cwd = change.cwd;
		return this.commit(before, next);
	}

	/**
	 * Fold a tab summary list (`tabs_changed`, or the tabs of a reconcile
	 * projection). `unknownTab` is true when the list names a tab the mirror
	 * lacks: a summary carries no `hidden` and no config, so it cannot become a
	 * record, and the caller re-reads the agent instead.
	 */
	mergeTabs(
		agentId: string,
		tabs: readonly ProjectedTab[],
		activeTabId?: string
	): { events: MaestroEvent[]; unknownTab: boolean } {
		const before = this.agents.get(agentId);
		if (!before) return { events: [], unknownTab: false };
		const next = this.withProjectedTabs(before, tabs, activeTabId);
		return { events: this.commit(before, next.agent), unknownTab: next.unknownTab };
	}

	/** Merge a patch onto one tab (the result of the client's own mutation). */
	patchTab(agentId: string, tabId: string, patch: Partial<AITabRecord>): MaestroEvent[] {
		const before = this.agents.get(agentId);
		if (!before?.aiTabs?.some((tab) => tab.id === tabId)) return [];
		const next: AgentRecord = {
			...before,
			aiTabs: before.aiTabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
		};
		return this.commit(before, next);
	}

	/** Merge a patch onto one agent (the result of the client's own mutation). */
	patchAgent(agentId: string, patch: Partial<AgentRecord>): MaestroEvent[] {
		const before = this.agents.get(agentId);
		if (!before) return [];
		return this.commit(before, { ...before, ...patch });
	}

	/** Drop one tab from the record (a closed tab). */
	dropTab(agentId: string, tabId: string): MaestroEvent[] {
		const before = this.agents.get(agentId);
		if (!before?.aiTabs?.some((tab) => tab.id === tabId)) return [];
		const next: AgentRecord = {
			...before,
			aiTabs: before.aiTabs.filter((tab) => tab.id !== tabId),
			...(Array.isArray(before.unifiedTabOrder)
				? { unifiedTabOrder: before.unifiedTabOrder.filter((ref) => ref.id !== tabId) }
				: {}),
		};
		return this.commit(before, next);
	}

	// -- reconcile -----------------------------------------------------------

	/**
	 * Compare a `get_sessions` projection with the mirror on the fields the
	 * projection carries (section 6.3). `needsRead` is true when it names an
	 * agent or a tab the mirror lacks. An agent the projection lacks is removed
	 * unless it was added or read after the projection was requested
	 * (`requestedAt`): a create can land between the request and the reply.
	 */
	reconcile(
		sessions: readonly ProjectedAgent[],
		requestedAt: number
	): { events: MaestroEvent[]; needsRead: boolean } {
		const events: MaestroEvent[] = [];
		let needsRead = false;
		const seen = new Set<string>();

		for (const projected of sessions) {
			seen.add(projected.id);
			const before = this.agents.get(projected.id);
			if (!before) {
				needsRead = true;
				continue;
			}
			const merged = this.withProjectedAgent(before, projected);
			if (merged.unknownTab) needsRead = true;
			events.push(...this.commit(before, merged.agent));
		}

		for (const id of [...this.agents.keys()]) {
			if (seen.has(id)) continue;
			if ((this.touchedAt.get(id) ?? 0) >= requestedAt) continue;
			events.push(...this.remove(id));
		}
		return { events, needsRead };
	}

	// -- internals -----------------------------------------------------------

	private withProjectedAgent(
		before: AgentRecord,
		projected: ProjectedAgent
	): { agent: AgentRecord; unknownTab: boolean } {
		let next: AgentRecord = { ...before };
		if (projected.name !== undefined) next.name = projected.name;
		if (projected.state !== undefined) next.state = projected.state as AgentRecord['state'];
		if (projected.cwd !== undefined) next.cwd = projected.cwd;
		if (projected.inputMode !== undefined) next.inputMode = projected.inputMode;
		const groupId = projected.groupId ?? undefined;
		if (groupId !== before.groupId) {
			if (groupId === undefined) delete next.groupId;
			else next.groupId = groupId;
		}
		const bookmarked = projected.bookmarked === true;
		if (bookmarked !== (before.bookmarked === true)) next.bookmarked = bookmarked;

		let unknownTab = false;
		if (projected.aiTabs) {
			const withTabs = this.withProjectedTabs(next, projected.aiTabs, projected.activeTabId);
			next = withTabs.agent;
			unknownTab = withTabs.unknownTab;
		} else if (projected.activeTabId !== undefined) {
			next.activeTabId = projected.activeTabId;
		}
		return { agent: next, unknownTab };
	}

	private withProjectedTabs(
		before: AgentRecord,
		tabs: readonly ProjectedTab[],
		activeTabId?: string
	): { agent: AgentRecord; unknownTab: boolean } {
		const current = before.aiTabs ?? [];
		const known = new Map(current.map((tab) => [tab.id, tab]));
		const projectedIds = new Set(tabs.map((tab) => tab.id));
		let unknownTab = false;

		const merged = new Map<string, AITabRecord>();
		for (const tab of tabs) {
			const existing = known.get(tab.id);
			if (!existing) {
				unknownTab = true;
				continue;
			}
			const next: AITabRecord = { ...existing };
			for (const field of TAB_FIELDS) {
				if (tab[field] !== undefined) (next as Record<string, unknown>)[field] = tab[field];
			}
			merged.set(tab.id, next);
		}

		// A tab the projection lacks is gone, except a hidden consult tab the
		// projection may not list: it has no chip, so its absence says nothing.
		const aiTabs = current.flatMap((tab) => {
			if (merged.has(tab.id)) return [merged.get(tab.id)!];
			if (projectedIds.has(tab.id)) return [tab];
			return tab.hidden === true ? [tab] : [];
		});

		const agent: AgentRecord = { ...before, aiTabs };
		if (activeTabId !== undefined) agent.activeTabId = activeTabId;
		return { agent, unknownTab };
	}

	/** Store `next` and describe the change; no events when nothing changed. */
	private commit(before: AgentRecord, next: AgentRecord): MaestroEvent[] {
		if (valuesEqual(before, next)) return [];
		this.agents.set(next.id, next);
		return this.diff(before, next);
	}

	private diff(before: AgentRecord | undefined, after: AgentRecord): MaestroEvent[] {
		if (!before) return [{ type: 'agent.added', agent: after }];
		const events: MaestroEvent[] = [];
		const beforeTabs = new Map(visibleAiTabsOf(before).map((tab) => [tab.id, tab]));
		const afterTabs = visibleAiTabsOf(after);
		const afterIds = new Set(afterTabs.map((tab) => tab.id));
		for (const tab of afterTabs) {
			const was = beforeTabs.get(tab.id);
			if (!was) events.push({ type: 'tab.added', agentId: after.id, tab });
			else if (!valuesEqual(was, tab)) events.push({ type: 'tab.updated', agentId: after.id, tab });
		}
		for (const id of beforeTabs.keys()) {
			if (!afterIds.has(id)) events.push({ type: 'tab.removed', agentId: after.id, tabId: id });
		}
		if (!valuesEqual(before, after)) events.push({ type: 'agent.updated', agent: after });
		return events;
	}
}

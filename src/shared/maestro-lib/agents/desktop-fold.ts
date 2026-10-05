/**
 * The desktop fold's applier (DG5, section 4.5 of the desktop migration plan).
 *
 * A pure function: it takes the stored documents, one `DesktopFold`, and a few lookups, and answers the
 * documents and events the fold amounts to. It performs no I/O. The repository runs it inside its command
 * queue, archives what it says to archive, replaces the in-memory documents, and schedules the write.
 *
 * The rules, in the plan's numbering (rule 1, the boundary transforms, is the main-process binding's):
 *
 * 2. Desktop-owned keys always land on an agent or tab the runtime has. A domain key found among them is
 *    dropped: the split is the closed list in `ownership.ts`.
 * 3. Provider-scoped tab fields land through `updateProviderSlot`, keyed by the fold's `provider`.
 * 4. `domain`, `tabDomain`, `closeTabs`, and `order` land only at the revision the sender last applied.
 *    A stale fold's domain part is dropped and reported as drift. A closed tab is archived first.
 * 5. A tab or agent the runtime never had is adopted unless its id is tombstoned.
 * 6. `removeAgents` always lands, and the id is tombstoned.
 * 7. Order is `reconcileTabOrder(stored, fold.order)`.
 * 8. Groups: `collapsed` always lands (and moves no revision); `domain` only at the current `groupsRev`.
 * 9. `activeSessionId` lands when it names an agent that exists.
 *
 * It never removes an agent or a tab because a fold leaves it out. An unchanged agent keeps its object
 * identity, so the memoized serializer reuses its text; a changed agent is a new object.
 *
 * No echo: applying desktop-owned keys emits nothing. Only a landed domain change, an adoption, a close,
 * and a removal emit, so a peer hears what it needs and the sender is not told what it already holds.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` section 4.5.
 */

import { valuesEqual } from '../client/mirror';
import type { MaestroEvent } from '../client/types';
import { agentsOf, groupsOf, projectAgentRecord, projectTabRecord } from '../store/read-stores';
import type {
	AgentRecord,
	AITabRecord,
	ClosedTabRecord,
	GroupRecord,
	GroupsDocument,
	SessionsDocument,
	TabRefRecord,
} from '../store/records';
import type { ToolType } from '../../types';
import type { DesktopFold, DesktopFoldAgent, DriftReport } from './desktop-fold-types';
import { isAgentDomainKey, isTabDomainKey, PROVIDER_SCOPED_TAB_KEYS } from './ownership';
import {
	updateProviderSlot,
	type ProviderSwitchAgent,
	type ProviderSwitchTab,
	type ProviderTabSession,
} from './providerSwap';
import {
	activeAgentAfterRemoval,
	closeTabRecord,
	groupsWithout,
	type RuleContext,
	type TabDefaults,
} from './rules';
import { reconcileTabOrder } from './tab-order';

/** What the applier reads. Everything is a snapshot taken inside the repository's queue. */
export interface FoldState {
	sessions: SessionsDocument;
	groups: GroupsDocument;
	/** The agent's revision, 0 for one the runtime has never changed. */
	revisionOf(agentId: string): number;
	groupsRev: number;
	/** Agents removed earlier (bounded): an adoption of one of these ids is refused. */
	removedAgentIds: ReadonlySet<string>;
	/** Groups removed earlier (bounded): the groups equivalent. */
	removedGroupIds: ReadonlySet<string>;
	/** The ids of the tabs an agent closed, from its archive: the tab tombstones. */
	closedTabIds(agentId: string): ReadonlySet<string>;
}

/** The rules a close needs: ids, the clock, and what a replacement tab starts from. */
export interface FoldDeps {
	ctx: RuleContext;
	defaults: TabDefaults;
}

/** What a fold amounts to. Nothing in it has been written. */
export interface FoldPlan {
	/** The next sessions document, or undefined when nothing stored changed. */
	sessions?: SessionsDocument;
	/** The next groups document, or undefined when nothing stored changed. */
	groups?: GroupsDocument;
	/** Tabs to archive BEFORE the sessions document changes, in order (RT6). */
	archive: Array<{ agentId: string; closed: ClosedTabRecord }>;
	/**
	 * What peers hear, in order: every `agent.removed`; then, per touched agent in the order it was first
	 * touched, its `tab.*` events and one `agent.added` or `agent.updated` (projected, no transcripts);
	 * then `groups.changed`.
	 */
	events: MaestroEvent[];
	/** Agent ids to add to the removed-agent tombstones, including ids the runtime never held. */
	tombstoneAgents: string[];
	tombstoneGroups: string[];
	drift: DriftReport[];
}

/** Agent keys that are structure, not fields: the tab set and the order are handled by their own rules. */
const STRUCTURAL_AGENT_KEYS: ReadonlySet<string> = new Set(['aiTabs', 'unifiedTabOrder']);

/** The group keys a `domain` list replaces on a known group. `collapsed` is the renderer's. */
const GROUP_REPLACED_KEYS = ['name', 'emoji', 'icon', 'color', 'kind', 'parentGroupId'] as const;

const hasOwn = (record: object, key: string): boolean =>
	Object.prototype.hasOwnProperty.call(record, key);

const hasKeys = (record: object | undefined): record is Record<string, unknown> =>
	record !== undefined && record !== null && Object.keys(record).length > 0;

const aiRefsOf = (order: unknown): TabRefRecord[] =>
	Array.isArray(order) ? order.filter((ref: TabRefRecord) => ref?.type === 'ai') : [];

/**
 * `record` with the keys of `patch` that `accept` allows written on it, as a NEW object when any value
 * differs and the same object when none does. A key whose value is `undefined` is deleted.
 */
function assignKeys<T extends Record<string, unknown>>(
	record: T,
	patch: Record<string, unknown>,
	accept: (key: string) => boolean
): { record: T; keys: string[] } {
	let next: T | undefined;
	const keys: string[] = [];
	for (const [key, value] of Object.entries(patch)) {
		if (!accept(key)) continue;
		if (value === undefined) {
			if (!hasOwn(record, key)) continue;
		} else if (valuesEqual(record[key], value)) {
			continue;
		}
		next ??= { ...record };
		if (value === undefined) delete (next as Record<string, unknown>)[key];
		else (next as Record<string, unknown>)[key] = value;
		keys.push(key);
	}
	return { record: next ?? record, keys };
}

const tabsOf = (agent: AgentRecord): AITabRecord[] =>
	Array.isArray(agent.aiTabs) ? agent.aiTabs : [];

function replaceTab(agent: AgentRecord, tab: AITabRecord): AgentRecord {
	return { ...agent, aiTabs: tabsOf(agent).map((entry) => (entry.id === tab.id ? tab : entry)) };
}

/** Whether an entry of a fold's raw record list can be stored as an agent. */
function isAgentShape(value: unknown): value is AgentRecord {
	const candidate = value as Partial<AgentRecord> | null;
	return (
		typeof candidate === 'object' &&
		candidate !== null &&
		typeof candidate.id === 'string' &&
		candidate.id.length > 0 &&
		typeof candidate.name === 'string' &&
		typeof candidate.toolType === 'string'
	);
}

/** One group list entry merged onto a known group: the four domain keys replace, everything else stays. */
function mergeGroupDomain(
	existing: readonly GroupRecord[],
	incoming: readonly GroupRecord[],
	tombstoned: ReadonlySet<string>
): { groups: GroupRecord[]; changed: boolean; adopted: string[] } {
	const incomingById = new Map(incoming.map((group) => [group?.id, group]));
	let changed = false;
	const known = new Set(existing.map((group) => group.id));
	const groups = existing.map((group): GroupRecord => {
		const wanted = incomingById.get(group.id);
		if (!wanted) return group;
		const patch: Record<string, unknown> = {};
		for (const key of GROUP_REPLACED_KEYS) {
			const value = wanted[key];
			// A name is required; any other key the sender no longer has is cleared.
			if (key === 'name' && typeof value !== 'string') continue;
			patch[key] = value;
		}
		const merged = assignKeys(group as Record<string, unknown>, patch, () => true);
		if (merged.keys.length > 0) changed = true;
		return merged.record as GroupRecord;
	});
	const adopted: string[] = [];
	for (const group of incoming) {
		if (typeof group?.id !== 'string' || typeof group.name !== 'string') continue;
		if (known.has(group.id) || tombstoned.has(group.id)) continue;
		groups.push({ ...group });
		known.add(group.id);
		adopted.push(group.id);
		changed = true;
	}
	return { groups, changed, adopted };
}

export function applyDesktopFold(state: FoldState, fold: DesktopFold, deps: FoldDeps): FoldPlan {
	const drift: DriftReport[] = [];
	const archive: FoldPlan['archive'] = [];
	const events: MaestroEvent[] = [];
	const tombstoneAgents: string[] = [];
	const tombstoneGroups: string[] = [];

	// -----------------------------------------------------------------------
	// Agents: the working set
	// -----------------------------------------------------------------------

	const live = new Map<string, AgentRecord>(agentsOf(state.sessions).map((a) => [a.id, a]));
	const original = new Map(live);
	const removedNow = new Set<string>();
	const adoptedNow: string[] = [];
	/** Agents whose domain changed or that were adopted, in first-touch order. */
	const touched = new Map<string, { added: boolean; tabEvents: MaestroEvent[] }>();
	const touch = (id: string, added = false) => {
		let entry = touched.get(id);
		if (!entry) {
			entry = { added, tabEvents: [] };
			touched.set(id, entry);
		}
		return entry;
	};

	let activeSessionId = state.sessions.activeSessionId;

	// -----------------------------------------------------------------------
	// Rule 6: removals always land
	// -----------------------------------------------------------------------

	for (const id of fold.removeAgents ?? []) {
		if (typeof id !== 'string' || !id) continue;
		tombstoneAgents.push(id);
		if (!live.has(id)) continue;
		live.delete(id);
		removedNow.add(id);
		activeSessionId = activeAgentAfterRemoval([...live.values()], id, activeSessionId);
		events.push({ type: 'agent.removed', agentId: id });
	}

	// -----------------------------------------------------------------------
	// Rule 5: adopt agents the runtime never had
	// -----------------------------------------------------------------------

	for (const raw of fold.adoptAgents ?? []) {
		if (!isAgentShape(raw)) continue;
		if (state.removedAgentIds.has(raw.id) || removedNow.has(raw.id)) {
			drift.push({ kind: 'tombstoned-agent', agentId: raw.id });
			continue;
		}
		if (live.has(raw.id)) continue;
		live.set(raw.id, { ...raw });
		adoptedNow.push(raw.id);
		touch(raw.id, true);
		drift.push({ kind: 'adopted-agent', agentId: raw.id });
	}

	// -----------------------------------------------------------------------
	// Rules 2, 3, 4, 5, 7: each agent the fold names
	// -----------------------------------------------------------------------

	const foldAgent = (entry: DesktopFoldAgent): void => {
		const agentId = entry.id;
		let record = live.get(agentId);
		if (!record) {
			if (!removedNow.has(agentId)) drift.push({ kind: 'unknown-agent', agentId });
			return;
		}
		const start = record;
		const current = entry.baseRev !== undefined && entry.baseRev === state.revisionOf(agentId);
		let domainChanged = false;
		const tabEvents: MaestroEvent[] = [];

		// Rule 2: desktop-owned agent keys always land. Domain and structural keys are dropped, not drift.
		record = assignKeys(
			record,
			entry.fields ?? {},
			(key) => !isAgentDomainKey(key) && !STRUCTURAL_AGENT_KEYS.has(key)
		).record;

		// Rule 4: agent domain keys, at the current revision only.
		if (hasKeys(entry.domain)) {
			if (current) {
				const landed = assignKeys(
					record,
					entry.domain,
					(key) => key !== 'id' && isAgentDomainKey(key)
				);
				if (landed.keys.length > 0) {
					record = landed.record;
					domainChanged = true;
				}
			} else {
				drift.push({ kind: 'domain-dropped', agentId, keys: Object.keys(entry.domain) });
			}
		}

		// Rule 5: tabs the runtime never had, unless a closed-tab archive entry tombstones the id.
		for (const raw of entry.adoptTabs ?? []) {
			const tabId = typeof raw?.id === 'string' ? raw.id : '';
			if (!tabId || tabsOf(record).some((tab) => tab.id === tabId)) continue;
			if (state.closedTabIds(agentId).has(tabId)) {
				drift.push({ kind: 'tombstoned-tab', agentId, tabId });
				continue;
			}
			const tab = { ...raw, id: tabId } as AITabRecord;
			const order: TabRefRecord[] = Array.isArray(record.unifiedTabOrder)
				? record.unifiedTabOrder
				: [];
			record = {
				...record,
				aiTabs: [...tabsOf(record), tab],
				unifiedTabOrder: order.some((ref) => ref.type === 'ai' && ref.id === tabId)
					? order
					: [...order, { type: 'ai', id: tabId }],
			};
			domainChanged = true;
			drift.push({ kind: 'adopted-tab', agentId, tabId });
			if (tab.hidden !== true) {
				tabEvents.push({ type: 'tab.added', agentId, tab: projectTabRecord(tab) });
			}
		}

		// Rule 4: tab domain keys, at the current revision only.
		for (const [tabId, keys] of Object.entries(entry.tabDomain ?? {})) {
			if (!hasKeys(keys)) continue;
			if (!current) {
				drift.push({ kind: 'tab-domain-dropped', agentId, tabId, keys: Object.keys(keys) });
				continue;
			}
			const tab = tabsOf(record).find((candidate) => candidate.id === tabId);
			if (!tab) continue;
			const landed = assignKeys(tab, keys, (key) => key !== 'id' && isTabDomainKey(key));
			if (landed.keys.length === 0) continue;
			record = replaceTab(record, landed.record);
			domainChanged = true;
			if (landed.record.hidden !== true) {
				tabEvents.push({ type: 'tab.updated', agentId, tab: projectTabRecord(landed.record) });
			}
		}

		// Rules 2 and 3: desktop-owned tab keys always land; the provider-scoped ones by provider epoch.
		for (const [tabId, fields] of Object.entries(entry.tabs ?? {})) {
			const tab = tabsOf(record).find((candidate) => candidate.id === tabId);
			if (!tab || !hasKeys(fields)) continue;
			const plain: Record<string, unknown> = {};
			const scoped: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(fields)) {
				if (isTabDomainKey(key)) continue;
				(PROVIDER_SCOPED_TAB_KEYS.has(key) ? scoped : plain)[key] = value;
			}
			let next: AITabRecord = assignKeys(tab, plain, () => true).record;
			if (hasKeys(scoped)) {
				if (entry.provider === record.toolType) {
					next = assignKeys(next, scoped, () => true).record;
				} else {
					// Computed under another provider than the agent runs now: it belongs to that provider's
					// parked slot, never to the live fields (DM9). An undefined value has no slot to clear.
					const defined = Object.fromEntries(
						Object.entries(scoped).filter(([, value]) => value !== undefined)
					);
					const slot = (
						next.providerSessions as Record<string, Record<string, unknown>> | undefined
					)?.[entry.provider];
					const differs = Object.entries(defined).some(
						([key, value]) => !valuesEqual(slot?.[key], value)
					);
					if (differs) {
						next = updateProviderSlot(
							next as unknown as ProviderSwitchTab,
							record as unknown as ProviderSwitchAgent,
							entry.provider as ToolType,
							defined as Partial<ProviderTabSession>
						) as unknown as AITabRecord;
					}
				}
			}
			if (next !== tab) record = replaceTab(record, next);
		}

		// Rule 4: closes, at the current revision only. Archived first, by the caller, in this order.
		if (entry.closeTabs && entry.closeTabs.length > 0) {
			if (!current) {
				drift.push({ kind: 'close-tabs-dropped', agentId, keys: [...entry.closeTabs] });
			} else {
				for (const tabId of entry.closeTabs) {
					const outcome = closeTabRecord(record, tabId, deps.ctx, deps.defaults);
					if (!outcome) continue;
					record = outcome.agent;
					archive.push({ agentId, closed: outcome.closed });
					tabEvents.push({ type: 'tab.removed', agentId, tabId });
					if (outcome.freshTab) {
						tabEvents.push({ type: 'tab.added', agentId, tab: projectTabRecord(outcome.freshTab) });
					}
					domainChanged = true;
				}
			}
		}

		// Rule 7: the order, last, so the authority already holds every adoption and drops every close.
		if (entry.order !== undefined) {
			const stored = Array.isArray(record.unifiedTabOrder) ? record.unifiedTabOrder : undefined;
			const reconciled = reconcileTabOrder(stored, entry.order);
			if (!valuesEqual(reconciled, stored ?? [])) {
				if (current) {
					// Only a change to the AI refs is something a peer renders: the renderer owns the rest.
					if (!valuesEqual(aiRefsOf(reconciled), aiRefsOf(stored))) domainChanged = true;
					record = { ...record, unifiedTabOrder: reconciled };
				} else {
					drift.push({ kind: 'order-dropped', agentId });
				}
			}
		}

		if (record !== start) live.set(agentId, record);
		if (domainChanged) {
			const touchedEntry = touch(agentId);
			touchedEntry.tabEvents.push(...tabEvents);
		}
	};

	for (const entry of fold.agents ?? []) foldAgent(entry);

	// -----------------------------------------------------------------------
	// Rule 8: groups
	// -----------------------------------------------------------------------

	let groups = groupsOf(state.groups);
	let groupsChanged = false;
	const removedGroupsNow = new Set<string>();
	const foldGroups = fold.groups;
	if (foldGroups) {
		for (const id of foldGroups.removeGroups ?? []) {
			if (typeof id !== 'string' || !id) continue;
			tombstoneGroups.push(id);
			if (!groups.some((group) => group.id === id)) continue;
			groups = groupsWithout(groups, id);
			removedGroupsNow.add(id);
			groupsChanged = true;
		}
		if (foldGroups.domain) {
			const tombstoned = new Set([...state.removedGroupIds, ...removedGroupsNow]);
			const merged = mergeGroupDomain(groups, foldGroups.domain, tombstoned);
			if (foldGroups.baseRev !== undefined && foldGroups.baseRev === state.groupsRev) {
				if (merged.changed) {
					groups = merged.groups;
					groupsChanged = true;
					for (const groupId of merged.adopted) drift.push({ kind: 'adopted-group', groupId });
				}
			} else if (merged.changed) {
				drift.push({ kind: 'groups-domain-dropped' });
			}
		}
	}

	// Members of a removed group become ungrouped, as the removeGroup command does. This runs after the
	// agent entries, so a fold that moved a member elsewhere in the same breath keeps its move.
	if (removedGroupsNow.size > 0) {
		for (const [id, agent] of [...live]) {
			if (typeof agent.groupId !== 'string' || !removedGroupsNow.has(agent.groupId)) continue;
			const { groupId: _gone, ...rest } = agent;
			live.set(id, rest as AgentRecord);
			touch(id);
		}
	}

	// `collapsed` always lands, moves no revision, and says nothing (CO-4).
	let groupsWritten = groupsChanged;
	if (foldGroups) {
		for (const [id, collapsed] of Object.entries(foldGroups.collapsed ?? {})) {
			if (typeof collapsed !== 'boolean') continue;
			const index = groups.findIndex((group) => group.id === id);
			if (index === -1 || (groups[index].collapsed ?? false) === collapsed) continue;
			groups = groups.map((group, at) => (at === index ? { ...group, collapsed } : group));
			groupsWritten = true;
		}
	}

	// -----------------------------------------------------------------------
	// Rule 9: the active agent
	// -----------------------------------------------------------------------

	if (typeof fold.activeSessionId === 'string') {
		if (fold.activeSessionId === '' || live.has(fold.activeSessionId)) {
			activeSessionId = fold.activeSessionId;
		}
	}

	// -----------------------------------------------------------------------
	// The documents and the events
	// -----------------------------------------------------------------------

	const agentsChanged =
		removedNow.size > 0 ||
		adoptedNow.length > 0 ||
		[...live].some(([id, agent]) => original.get(id) !== agent);
	const activeChanged = (activeSessionId ?? '') !== (state.sessions.activeSessionId ?? '');

	let sessions: SessionsDocument | undefined;
	if (agentsChanged || activeChanged) {
		const stored = Array.isArray(state.sessions.sessions) ? state.sessions.sessions : [];
		const entries = stored.flatMap((entry): unknown[] => {
			const id = (entry as { id?: unknown } | null)?.id;
			if (typeof id === 'string' && original.has(id) && original.get(id) === entry) {
				return live.has(id) ? [live.get(id)] : [];
			}
			return [entry];
		});
		for (const id of adoptedNow) entries.push(live.get(id));
		sessions = { ...state.sessions, sessions: entries };
		if (activeChanged) sessions.activeSessionId = activeSessionId ?? '';
	}

	let groupsDocument: GroupsDocument | undefined;
	if (groupsWritten) {
		groupsDocument = { ...state.groups, groups: [...groups] };
	}

	for (const [id, entry] of touched) {
		const agent = live.get(id);
		if (!agent) continue;
		events.push(...entry.tabEvents);
		events.push(
			entry.added
				? { type: 'agent.added', agent: projectAgentRecord(agent) }
				: { type: 'agent.updated', agent: projectAgentRecord(agent) }
		);
	}
	if (groupsChanged) events.push({ type: 'groups.changed', groups });

	return {
		...(sessions ? { sessions } : {}),
		...(groupsDocument ? { groups: groupsDocument } : {}),
		archive,
		events,
		tombstoneAgents,
		tombstoneGroups,
		drift,
	};
}

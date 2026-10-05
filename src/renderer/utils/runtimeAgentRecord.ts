/**
 * Folding a runtime's authoritative agent record into this window's copy (4.3 of the migration plan).
 *
 * The runtime owns an agent's DOMAIN keys (`ownership.ts`): what it is, how it is configured, which AI
 * tabs it has and in what order. The renderer owns everything else (view, workspace, live turn state),
 * so applying a record takes the domain keys and leaves every other key alone. Four of those keys do
 * not copy cleanly, and each has a reaction that runs first (DM9, DM10, 2.3):
 *
 * - `toolType` changed: run `switchAgentProvider` on the local copy, so its turn state and execution
 *   queue follow the swap, and then take the domain keys (the parked slots are domain).
 * - `cwd` changed: run `withWorkingDirectory`, which moves the five path fields together and clears the
 *   file-tree caches, instead of copying `cwd` alone.
 * - `autoRunFolderPath` changed: the runtime also cleared the cached document and bumped its version;
 *   take those so the desktop reloads it.
 * - The tab set: a tab the runtime holds that this window lacks is added; a tab this window lacks that
 *   the PREVIOUS record held was closed elsewhere and is dropped; a tab this window holds that no record
 *   ever named was created here and not folded yet, so it stays. A busy tab is never dropped.
 *
 * The result is the same object when nothing changed, so a repeated event (the echo of this window's
 * own command) re-renders nothing and does not mark the agent dirty for the next flush.
 */

import { valuesEqual } from '../../shared/maestro-lib/client/mirror';
import type { FoldBaseline } from '../../shared/maestro-lib/agents/fold-builder';
import { AGENT_DOMAIN_KEYS, TAB_DOMAIN_KEYS } from '../../shared/maestro-lib/agents/ownership';
import { switchAgentProvider } from '../../shared/maestro-lib/agents/providerSwap';
import { reconcileTabOrder } from '../../shared/maestro-lib/agents/tab-order';
import type {
	AgentRecord,
	AITabRecord,
	TabRefRecord,
} from '../../shared/maestro-lib/store/records';
import type { AITab, Session, ToolType } from '../types';
import { withWorkingDirectory } from './agentWorkingDirectory';

/** Keys the provider swap and the working-directory move already settled: copying them again would undo their reactions. */
const HANDLED_BY_REACTION: ReadonlySet<string> = new Set(['id', 'toolType', 'cwd']);

/** A key set from the record, or removed when the record has none. Returns the same object when nothing differs. */
function takeKeys<T extends Record<string, unknown>>(
	target: T,
	record: Record<string, unknown>,
	keys: ReadonlySet<string>,
	skip: ReadonlySet<string> = HANDLED_BY_REACTION
): T {
	let next: Record<string, unknown> | undefined;
	for (const key of keys) {
		if (skip.has(key)) continue;
		const has = Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined;
		if (has ? valuesEqual(record[key], target[key]) : target[key] === undefined) continue;
		next ??= { ...target };
		if (has) next[key] = record[key];
		else delete next[key];
	}
	return (next as T | undefined) ?? target;
}

/** A tab this window has never held: everything the record says, with the transcript and composer state empty. */
function newLocalTab(record: AITabRecord): AITab {
	const { logs: _logs, ...rest } = record as AITabRecord & { logs?: unknown };
	return { logs: [], inputValue: '', stagedImages: [], state: 'idle', ...rest } as unknown as AITab;
}

/** The session a record becomes when this window has none: what `restoreSession` is handed. */
export function sessionFromRecord(record: AgentRecord): Session {
	const tabs = Array.isArray(record.aiTabs) ? record.aiTabs : [];
	return { ...record, aiTabs: tabs.map(newLocalTab) } as unknown as Session;
}

function mergeTabs(
	local: Session,
	record: AgentRecord,
	previous: FoldBaseline | undefined
): { tabs: AITab[]; localOnly: Set<string>; changed: boolean } {
	const recordTabs = Array.isArray(record.aiTabs) ? record.aiTabs : [];
	const recordIds = new Set(recordTabs.map((tab) => tab.id));
	const localTabs = local.aiTabs ?? [];
	const localById = new Map(localTabs.map((tab) => [tab.id, tab]));
	let changed = false;

	const merged: AITab[] = [];
	for (const tab of recordTabs) {
		const held = localById.get(tab.id);
		if (!held) {
			merged.push(newLocalTab(tab));
			changed = true;
			continue;
		}
		const next = takeKeys(
			held as unknown as Record<string, unknown>,
			tab,
			TAB_DOMAIN_KEYS,
			new Set(['id'])
		) as unknown as AITab;
		if (next !== held) changed = true;
		merged.push(next);
	}

	// Tabs only this window holds: created here and not folded yet (keep), or closed elsewhere (drop).
	const localOnly = new Set<string>();
	for (const tab of localTabs) {
		if (recordIds.has(tab.id)) continue;
		const closedElsewhere = previous !== undefined && tab.id in previous.tabs;
		if (closedElsewhere && tab.state !== 'busy') {
			changed = true;
			continue;
		}
		localOnly.add(tab.id);
		merged.push(tab);
	}

	// Keep the record's order where the tabs agree, so an event never reshuffles a strip it did not reorder.
	if (
		!changed &&
		merged.length === localTabs.length &&
		merged.every((tab, i) => tab === localTabs[i])
	) {
		return { tabs: localTabs, localOnly, changed: false };
	}
	return { tabs: merged, localOnly, changed };
}

/** `unifiedTabOrder` with the runtime's order, the non-AI refs of this window, and the AI refs of tabs only this window holds. */
function mergeOrder(
	local: Session,
	record: AgentRecord,
	localOnly: ReadonlySet<string>
): TabRefRecord[] {
	const localOrder = (local.unifiedTabOrder ?? []) as TabRefRecord[];
	const reconciled = reconcileTabOrder(record.unifiedTabOrder, localOrder);
	for (const id of localOnly) {
		if (reconciled.some((ref) => ref.type === 'ai' && ref.id === id)) continue;
		const at = localOrder.findIndex((ref) => ref.type === 'ai' && ref.id === id);
		let insertAt = reconciled.length;
		for (let back = at - 1; back >= 0; back -= 1) {
			const found = reconciled.findIndex(
				(ref) => ref.type === localOrder[back].type && ref.id === localOrder[back].id
			);
			if (found >= 0) {
				insertAt = found + 1;
				break;
			}
			if (back === 0) insertAt = 0;
		}
		reconciled.splice(insertAt, 0, { type: 'ai', id });
	}
	return reconciled;
}

export function applyRuntimeAgentRecord(
	local: Session,
	record: AgentRecord,
	previous?: FoldBaseline
): Session {
	let next = local;

	if (record.toolType && record.toolType !== next.toolType) {
		next = switchAgentProvider(next, record.toolType as ToolType).agent as Session;
	}
	if (record.cwd && record.cwd !== next.cwd) next = withWorkingDirectory(next, record.cwd);

	if (
		record.autoRunFolderPath !== undefined &&
		record.autoRunFolderPath !== next.autoRunFolderPath
	) {
		next = {
			...next,
			autoRunSelectedFile: record.autoRunSelectedFile as string | undefined,
			autoRunContent: record.autoRunContent as string | undefined,
			autoRunContentVersion: record.autoRunContentVersion as number | undefined,
		};
	}

	next = takeKeys(
		next as unknown as Record<string, unknown>,
		record,
		AGENT_DOMAIN_KEYS
	) as unknown as Session;

	const tabs = mergeTabs(next, record, previous);
	if (tabs.changed) {
		const activeStillThere = tabs.tabs.some((tab) => tab.id === next.activeTabId);
		next = {
			...next,
			aiTabs: tabs.tabs,
			activeTabId: activeStillThere
				? next.activeTabId
				: tabs.tabs.some((tab) => tab.id === record.activeTabId)
					? (record.activeTabId as string)
					: (tabs.tabs[0]?.id ?? next.activeTabId),
		};
	}
	const order = mergeOrder(next, record, tabs.localOnly);
	if (!valuesEqual(order, next.unifiedTabOrder ?? [])) {
		next = { ...next, unifiedTabOrder: order as Session['unifiedTabOrder'] };
	}
	return next;
}

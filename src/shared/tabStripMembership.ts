/**
 * Which of an agent's tabs the tab strip draws.
 *
 * A tab draws a chip when it has a slot in the strip: a standalone ref in
 * `unifiedTabOrder`, or a leaf in one of the agent's tiled groups (the group
 * ref stands in for its members). A hidden AI tab (`AITab.hidden`: consults,
 * background dispatches, Quick Chat, archived relays) keeps its slot but draws
 * no chip until the user reveals it.
 *
 * A tab with no slot at all is ORPHANED. Nothing creates one on purpose: it is
 * a tab the user closed, snoozed or moved whose record survived the write
 * (#2008). The renderer's restore repair appends every slotless tab to the
 * order, so an orphan left on disk comes back as a chip on the next launch.
 *
 * Pure and structural (no renderer types), because three places must agree
 * exactly: `maestro-cli session list` (main, from the store), the Usage
 * Dashboard "Open Tabs" card (renderer, from memory), and the load-time repair
 * that clears orphans from the store.
 */

/** The tab kinds a strip slot can hold. */
export type StripTabType = 'ai' | 'file' | 'browser' | 'terminal';

/** Where a tab stands relative to the strip. */
export type TabStripVisibility = 'visible' | 'hidden' | 'orphaned';

/** The session field that holds each kind of tab. */
export const STRIP_TAB_FIELDS = {
	ai: 'aiTabs',
	file: 'filePreviewTabs',
	browser: 'browserTabs',
	terminal: 'terminalTabs',
} as const satisfies Record<StripTabType, string>;

const STRIP_TAB_TYPES = Object.keys(STRIP_TAB_FIELDS) as StripTabType[];

type LayoutNodeLike = {
	kind?: unknown;
	tab?: { type?: unknown; id?: unknown };
	children?: unknown;
};

type TabLike = { id?: unknown; hidden?: unknown };

/**
 * The fields of an agent record the strip is built from. The functions below
 * take any object and read these fields defensively, so a renderer `Session`
 * and a main-process `StoredSession` (index-signature typed) both fit.
 */
export interface TabStripSessionLike {
	aiTabs?: unknown;
	filePreviewTabs?: unknown;
	browserTabs?: unknown;
	terminalTabs?: unknown;
	unifiedTabOrder?: unknown;
	tabGroups?: unknown;
}

/** The `type:id` key a strip slot is identified by. */
export function stripTabKey(type: string, id: string): string {
	return `${type}:${id}`;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** The `type:id` key of every tab that is a leaf in one of the agent's tiled groups. */
export function collectGroupMemberTabKeys(record: object): Set<string> {
	const session = record as TabStripSessionLike;
	const keys = new Set<string>();
	const walk = (node: unknown): void => {
		if (!node || typeof node !== 'object') return;
		const n = node as LayoutNodeLike;
		if (n.kind === 'leaf') {
			if (typeof n.tab?.type === 'string' && typeof n.tab.id === 'string') {
				keys.add(stripTabKey(n.tab.type, n.tab.id));
			}
			return;
		}
		asArray(n.children).forEach(walk);
	};
	for (const group of asArray(session.tabGroups)) {
		walk((group as { layout?: unknown } | null)?.layout);
	}
	return keys;
}

/**
 * Every slot the strip has for this agent: standalone order refs plus tiled
 * group leaves. Null for a legacy record with no `unifiedTabOrder` array: the
 * restore builds that order from the tab lists, so none of its tabs is orphaned.
 */
export function tabStripSlotKeys(record: object): Set<string> | null {
	const session = record as TabStripSessionLike;
	if (!Array.isArray(session.unifiedTabOrder)) return null;
	const keys = collectGroupMemberTabKeys(session);
	for (const ref of session.unifiedTabOrder) {
		const r = ref as { type?: unknown; id?: unknown } | null;
		if (typeof r?.type === 'string' && typeof r.id === 'string') {
			keys.add(stripTabKey(r.type, r.id));
		}
	}
	return keys;
}

/**
 * Where one tab stands. A hidden AI tab is `hidden` whether or not it has a
 * slot: it draws no chip either way, and `hidden` is the state a user can act on.
 *
 * @param slots The agent's `tabStripSlotKeys()`, computed once per agent.
 */
export function tabStripVisibility(
	type: StripTabType,
	tab: TabLike,
	slots: Set<string> | null
): TabStripVisibility {
	if (type === 'ai' && tab.hidden === true) return 'hidden';
	if (!slots || typeof tab.id !== 'string') return 'visible';
	return slots.has(stripTabKey(type, tab.id)) ? 'visible' : 'orphaned';
}

/** Tabs of each visibility for one agent, per kind. */
export type TabStripCounts = Record<StripTabType, Record<TabStripVisibility, number>>;

/** Count an agent's tabs by kind and visibility. */
export function countTabStrip(record: object): TabStripCounts {
	const session = record as TabStripSessionLike;
	const slots = tabStripSlotKeys(session);
	const counts = {} as TabStripCounts;
	for (const type of STRIP_TAB_TYPES) {
		const bucket = { visible: 0, hidden: 0, orphaned: 0 };
		for (const tab of asArray(session[STRIP_TAB_FIELDS[type]])) {
			if (!tab || typeof tab !== 'object') continue;
			bucket[tabStripVisibility(type, tab as TabLike, slots)]++;
		}
		counts[type] = bucket;
	}
	return counts;
}

/**
 * Tabs the strip draws a chip for, every kind together. The Usage Dashboard
 * "Open Tabs" card and the default `maestro-cli session list --type all` count
 * both come from this, so the two numbers agree.
 */
export function countOpenTabs(session: object): number {
	const counts = countTabStrip(session);
	return STRIP_TAB_TYPES.reduce((total, type) => total + counts[type].visible, 0);
}

/**
 * The record without its orphaned tabs, and how many were dropped. The record
 * is the same reference when it has none.
 *
 * Hidden AI tabs are kept even without a slot: a non-persistent Quick Chat can
 * legitimately sit outside the order, and a hidden tab never comes back as a
 * chip. Each dropped tab's transcript stays in its provider session, the same
 * as any closed tab's.
 */
export function dropOrphanedTabs<T extends object>(session: T): { session: T; dropped: number } {
	const slots = tabStripSlotKeys(session);
	if (!slots) return { session, dropped: 0 };
	let next: T | null = null;
	let dropped = 0;
	for (const type of STRIP_TAB_TYPES) {
		const field = STRIP_TAB_FIELDS[type];
		const tabs = (session as TabStripSessionLike)[field];
		if (!Array.isArray(tabs)) continue;
		const kept = tabs.filter(
			(tab) =>
				!tab ||
				typeof tab !== 'object' ||
				tabStripVisibility(type, tab as TabLike, slots) !== 'orphaned'
		);
		if (kept.length === tabs.length) continue;
		dropped += tabs.length - kept.length;
		next = { ...(next ?? session), [field]: kept };
	}
	return { session: next ?? session, dropped };
}

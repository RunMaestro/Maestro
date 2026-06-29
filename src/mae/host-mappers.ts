// Pure mappers from Maestro's own data shapes to the bridge's metadata shapes.
// Kept structural (minimal input views) and dependency-free so they stay under
// src/mae (bun-tested) without importing electron/renderer types; the desktop
// glue passes real records that satisfy these views.

import type { CueEntry, PlaybookEntry, SessionListEntry } from './bridge-core';

export interface StoredAiTabLike {
	id?: string;
	// The engine resume key for this tab (e.g. the omp session file path).
	agentSessionId?: string | null;
}

export interface StoredSessionLike {
	id: string;
	name?: string;
	toolType?: string;
	cwd?: string;
	projectRoot?: string;
	state?: string;
	// omp resume key when stored at the top level (rare). Usually the key lives
	// in the omp aiTab (`aiTabs[].agentSessionId`); prefer resolveOmpSessionId.
	ompSessionId?: string;
	// Renderer-persisted tabs; for omp-engine sessions the active tab carries the
	// resume key. Present on GUI-created sessions (StoredSession's index signature).
	activeTabId?: string;
	aiTabs?: ReadonlyArray<StoredAiTabLike>;
}

// omp-engine tool types: 'omp' (headless agent), 'mae' (branded TUI), and 'pi'
// (legacy/transitional rows). Keep all three so existing sessions still resolve.
function isOmpEngine(toolType: string | undefined): boolean {
	return toolType === 'omp' || toolType === 'mae' || toolType === 'pi';
}

// Resolve the omp resume key for a stored session: an explicit top-level
// `ompSessionId` wins; otherwise, for omp-engine sessions, read it from the
// active aiTab (falling back to the first tab that carries one). GUI-created omp
// sessions keep the key in `aiTabs[].agentSessionId`, not at the top level, so
// without this `mae resume` could not continue a session started in the GUI.
export function resolveOmpSessionId(session: StoredSessionLike): string | undefined {
	if (typeof session.ompSessionId === 'string' && session.ompSessionId) {
		return session.ompSessionId;
	}
	if (!isOmpEngine(session.toolType) || !session.aiTabs) return undefined;
	const active = session.activeTabId
		? session.aiTabs.find((tab) => tab.id === session.activeTabId)
		: undefined;
	if (typeof active?.agentSessionId === 'string' && active.agentSessionId) {
		return active.agentSessionId;
	}
	const firstWithKey = session.aiTabs.find(
		(tab) => typeof tab.agentSessionId === 'string' && tab.agentSessionId
	);
	return typeof firstWithKey?.agentSessionId === 'string' ? firstWithKey.agentSessionId : undefined;
}

export function toSessionListEntry(session: StoredSessionLike): SessionListEntry {
	const entry: SessionListEntry = {
		id: session.id,
		title: session.name ?? session.id,
		status: session.state ?? 'unknown',
		projectPath: session.projectRoot ?? session.cwd ?? '',
	};
	if (isOmpEngine(session.toolType)) entry.engine = 'omp';
	const ompSessionId = resolveOmpSessionId(session);
	if (ompSessionId) entry.ompSessionId = ompSessionId;
	return entry;
}

export function toSessionList(sessions: readonly StoredSessionLike[]): SessionListEntry[] {
	return sessions.map(toSessionListEntry);
}

export interface CueSubscriptionLike {
	name?: string;
	lastFiredAt?: number;
}
export interface CueGraphSessionLike {
	subscriptions?: CueSubscriptionLike[];
}
export interface CueRunResultLike {
	subscriptionName?: string;
	name?: string;
	at?: number;
	finishedAt?: number;
}

// Build the cue.observe payload: one entry per unique subscription, annotated
// with its most recent run time (from the activity log, falling back to the
// subscription's own lastFiredAt).
export function toCueEntries(
	graph: readonly CueGraphSessionLike[],
	recent: readonly CueRunResultLike[]
): CueEntry[] {
	const lastFired = new Map<string, number>();
	for (const run of recent) {
		const name = run.subscriptionName ?? run.name;
		const at = run.finishedAt ?? run.at;
		if (typeof name === 'string' && typeof at === 'number') {
			const prev = lastFired.get(name);
			if (prev === undefined || at > prev) lastFired.set(name, at);
		}
	}
	const entries: CueEntry[] = [];
	const seen = new Set<string>();
	for (const session of graph) {
		for (const sub of session.subscriptions ?? []) {
			if (typeof sub.name !== 'string' || seen.has(sub.name)) continue;
			seen.add(sub.name);
			const at = lastFired.get(sub.name) ?? sub.lastFiredAt;
			entries.push(
				typeof at === 'number' ? { name: sub.name, lastFiredAt: at } : { name: sub.name }
			);
		}
	}
	return entries;
}

export interface PlaybookFileLike {
	id?: string;
	name?: string;
}

// Maestro stores playbooks as per-session JSON files; merge + de-dupe by id.
export function mergePlaybooks(
	files: readonly { playbooks?: PlaybookFileLike[] }[]
): PlaybookEntry[] {
	const out: PlaybookEntry[] = [];
	const seen = new Set<string>();
	for (const file of files) {
		for (const playbook of file.playbooks ?? []) {
			if (typeof playbook.id !== 'string' || seen.has(playbook.id)) continue;
			seen.add(playbook.id);
			out.push({
				id: playbook.id,
				name: typeof playbook.name === 'string' ? playbook.name : playbook.id,
			});
		}
	}
	return out;
}

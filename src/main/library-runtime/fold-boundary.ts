/**
 * The transforms a fold passes through in main before it reaches the runtime (rule 1 of 4.5).
 *
 * `sessions:setMany` applies them at the same boundary today: pasted images leave the document for the
 * content-addressed store, oversized tool results are compacted, and a browser client's deferred
 * transcripts are merged back into the stored ones. They need Electron-side modules, so they live here
 * and not in the library. They work on whole sessions, so each fold entry is dressed as one for the
 * transform and taken apart again.
 *
 * Design: `Plans/maestro-tui-desktop-migration.md` section 4.5.
 */

import type {
	DesktopFold,
	DesktopFoldAgent,
} from '../../shared/maestro-lib/agents/desktop-fold-types';
import { compactSessionToolOutputs } from '../../shared/toolOutput';
import { relocateSessionImages } from '../storage/session-image-store';
import { mergeDeferredSessionContent } from '../stores/deferred-session-content';
import type { StoredSession } from '../stores/types';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[LibraryRuntime]';

/** The stored record of an agent, when the runtime has one: what a browser's deferred content merges into. */
export type StoredSessionLookup = (agentId: string) => StoredSession | undefined;

/** An entry as the session it would be: its fields, with the tabs it carries as `aiTabs`. */
function entryAsSession(entry: DesktopFoldAgent): StoredSession {
	return {
		...entry.fields,
		id: entry.id,
		aiTabs: Object.entries(entry.tabs).map(([id, fields]) => ({ ...fields, id })),
	} as unknown as StoredSession;
}

/** The inverse of `entryAsSession`: what a transform returned, split back into fields and tabs. */
function sessionIntoEntry(entry: DesktopFoldAgent, session: StoredSession): DesktopFoldAgent {
	const {
		id: _id,
		aiTabs,
		...fields
	} = session as Record<string, unknown> & {
		aiTabs?: Array<Record<string, unknown>>;
	};
	const tabs: Record<string, Record<string, unknown>> = {};
	for (const tab of aiTabs ?? []) {
		const { id, ...rest } = tab as { id: string } & Record<string, unknown>;
		tabs[id] = rest;
	}
	// A key an entry set to undefined to delete it must stay undefined: the transform never adds it back.
	return { ...entry, fields, tabs };
}

/**
 * Apply the boundary to a fold. Returns a new fold; the argument is not changed.
 *
 * An adoption that carries a deferred-content marker is dropped: the marker means the sender holds a
 * thin projection with no stored counterpart to merge into, so adopting it would persist an agent
 * without its transcripts. The applier tombstone-checks everything that remains.
 */
export async function applyFoldBoundary(
	fold: DesktopFold,
	stored: StoredSessionLookup
): Promise<DesktopFold> {
	const entrySessions = fold.agents.map((entry) => {
		const session = entryAsSession(entry);
		return session.deferredContent
			? mergeDeferredSessionContent(session, stored(entry.id))
			: session;
	});

	const adopted = (fold.adoptAgents ?? []).filter((record) => {
		if (!(record as { deferredContent?: unknown }).deferredContent) return true;
		logger.warn(
			`Dropped the adoption of ${String(record.id)}: it carries deferred content`,
			LOG_CONTEXT
		);
		return false;
	}) as StoredSession[];

	// Tabs adopted into an existing agent ride along as tabs of a throwaway session so they are scanned too.
	const tabHolders = fold.agents.map(
		(entry) =>
			({
				id: entry.id,
				aiTabs: (entry.adoptTabs ?? []) as StoredSession[],
			}) as unknown as StoredSession
	);

	const { sessions: relocated } = await relocateSessionImages([
		...entrySessions,
		...adopted,
		...tabHolders,
	]);
	const compacted = relocated.map((session) => compactSessionToolOutputs(session).session);

	const entryCount = fold.agents.length;
	const agents = fold.agents.map((entry, index) => {
		const next = sessionIntoEntry(entry, compacted[index]);
		const holder = compacted[entryCount + adopted.length + index] as StoredSession;
		if (entry.adoptTabs) next.adoptTabs = (holder.aiTabs ?? []) as Record<string, unknown>[];
		return next;
	});

	const result: DesktopFold = { ...fold, agents };
	if (fold.adoptAgents) {
		result.adoptAgents = compacted.slice(entryCount, entryCount + adopted.length) as Record<
			string,
			unknown
		>[];
	}
	return result;
}

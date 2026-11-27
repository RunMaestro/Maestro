/**
 * What the semantic index reads: History entries, Director's Notes synopses,
 * and the AI tab transcripts Maestro itself persists.
 *
 * Each kind is a {@link SemanticSourceReader}. A reader does not hand over
 * everything at once: it lists GROUPS (one History file, the archive, one
 * agent's tabs) and each group loads on demand, so an index pass holds one
 * file's text in memory at a time, however much history there is.
 *
 * A reader only ever reads what Maestro already stores. Provider session files
 * are not opened here: a transcript is the tab's own persisted log, which is
 * the newest `MAX_PERSISTED_SESSION_LOGS` entries and nothing older.
 *
 * Nothing in this module embeds, hashes, or writes. It answers one question,
 * "what text exists, and whose is it", so the indexer can be tested against
 * plain arrays.
 */

import {
	transcriptSourceId,
	type EmbeddingSourceType,
} from '../../shared/local-models/embedding-index';
import type { HistoryEntry } from '../../shared/types';
import type { ArchivedSynopsis } from './directors-notes-archive';

/** One indexable thing: a History entry, a synopsis, a transcript turn. */
export interface SemanticSourceItem {
	sourceType: EmbeddingSourceType;
	sourceId: string;
	/** The agent it belongs to, when it belongs to one. */
	agentId: string | null;
	/** Never blank: a reader drops a source with nothing to embed. */
	text: string;
	/**
	 * The text can still change. An immutable source is skipped as soon as the
	 * index holds it; a mutable one is re-read and compared chunk by chunk.
	 */
	mutable: boolean;
}

/** Sources that load together. */
export interface SemanticSourceGroup {
	/** Stable within a reader, so a pass can come back to the group. */
	key: string;
	load(): Promise<SemanticSourceItem[]>;
}

export interface SemanticSourceReader {
	sourceType: EmbeddingSourceType;
	groups(): Promise<SemanticSourceGroup[]>;
}

// ============================================================================
// History
// ============================================================================

/**
 * A History entry as one text: the summary, then the full response when it
 * adds anything. The summary leads because it is the entry's own description
 * of itself, and the first window of a long entry is the one most often hit.
 */
export function historyEntryText(entry: Pick<HistoryEntry, 'summary' | 'fullResponse'>): string {
	const summary = (entry.summary ?? '').trim();
	const full = (entry.fullResponse ?? '').trim();
	if (full === '' || full === summary) return summary;
	if (summary === '' || full.startsWith(summary)) return full;
	return `${summary}\n\n${full}`;
}

/**
 * The index item for one History entry, or `null` when it is not indexed: a
 * Cue run while Cue indexing is off, an entry with no id, an entry with no
 * text. `sessionId` is the History file the entry lives in, which is what a
 * search needs to read it back.
 *
 * Cue runs are about 98% of History by volume and mostly the same sentence
 * every few minutes, which is why they are opt-in.
 */
export function historyEntryItem(
	entry: HistoryEntry,
	sessionId: string,
	includeCue: boolean
): SemanticSourceItem | null {
	if (!entry.id) return null;
	if (entry.type === 'CUE' && !includeCue) return null;
	const text = historyEntryText(entry);
	if (text === '') return null;
	return { sourceType: 'history', sourceId: entry.id, agentId: sessionId, text, mutable: false };
}

export interface HistoryReaderDeps {
	/** Agents with a History file. */
	listSessions: () => Promise<string[]>;
	/** One agent's stored entries. */
	getEntries: (sessionId: string) => Promise<HistoryEntry[]>;
	/** The `semanticIndexCue` setting, read per pass so a flip takes effect. */
	includeCue: () => boolean;
	/**
	 * Cue runs that live in the Cue database rather than a History file, by
	 * agent. Only asked when Cue indexing is on. Rows a History file already
	 * carries must be left out by the caller's implementation.
	 */
	cueRuns?: {
		sessions: () => string[];
		entries: (sessionId: string, stored: HistoryEntry[]) => HistoryEntry[];
	};
}

/**
 * The agents a History read covers: every agent with a History file, plus
 * (while Cue indexing is on) every agent that may have Cue runs in the Cue
 * database only.
 */
export async function historySessionIds(deps: HistoryReaderDeps): Promise<string[]> {
	const sessionIds = new Set(await deps.listSessions());
	if (deps.includeCue() && deps.cueRuns) {
		for (const id of deps.cueRuns.sessions()) sessionIds.add(id);
	}
	return [...sessionIds];
}

/**
 * One agent's indexable History entries, each paired with its index item.
 * Entries that are not indexed (see {@link historyEntryItem}) and repeats of an
 * id are left out.
 *
 * The indexer and the search both read through here. A search turns a hit back
 * into text by re-reading its source, so a second derivation that disagreed
 * about which entries exist, or what their text is, would hand back the wrong
 * snippet for a chunk index.
 */
export async function historyGroupEntries(
	deps: HistoryReaderDeps,
	sessionId: string
): Promise<Array<{ entry: HistoryEntry; item: SemanticSourceItem }>> {
	const includeCue = deps.includeCue();
	const stored = await deps.getEntries(sessionId);
	const entries =
		includeCue && deps.cueRuns ? [...stored, ...deps.cueRuns.entries(sessionId, stored)] : stored;
	const pairs: Array<{ entry: HistoryEntry; item: SemanticSourceItem }> = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		const item = historyEntryItem(entry, sessionId, includeCue);
		if (!item || seen.has(item.sourceId)) continue;
		seen.add(item.sourceId);
		pairs.push({ entry, item });
	}
	return pairs;
}

/** History entries, one group per agent. */
export function createHistoryReader(deps: HistoryReaderDeps): SemanticSourceReader {
	return {
		sourceType: 'history',
		async groups() {
			return (await historySessionIds(deps)).map((sessionId) => ({
				key: sessionId,
				async load() {
					return (await historyGroupEntries(deps, sessionId)).map((pair) => pair.item);
				},
			}));
		},
	};
}

// ============================================================================
// Director's Notes
// ============================================================================

/** The index item for one archived synopsis, or `null` when it has no text. */
export function synopsisItem(record: ArchivedSynopsis): SemanticSourceItem | null {
	const text = record.text.trim();
	if (text === '') return null;
	return {
		sourceType: 'directors-notes',
		sourceId: record.id,
		agentId: null,
		text,
		mutable: false,
	};
}

/** Archived synopses, as one group. */
export function createDirectorNotesReader(
	readArchive: () => Promise<ArchivedSynopsis[]>
): SemanticSourceReader {
	return {
		sourceType: 'directors-notes',
		async groups() {
			return [
				{
					key: 'archive',
					async load() {
						const items: SemanticSourceItem[] = [];
						for (const record of await readArchive()) {
							const item = synopsisItem(record);
							if (item) items.push(item);
						}
						return items;
					},
				},
			];
		},
	};
}

// ============================================================================
// Transcripts
// ============================================================================

/**
 * How long a tab's newest turn must have been quiet before it is indexed. A
 * turn still streaming would be embedded, changed, and embedded again on every
 * pass; one that has been still this long is almost always finished.
 */
export const TRANSCRIPT_SETTLE_MS = 2 * 60_000;

/** The log sources that are conversation: what was asked, and what was answered. */
const CONVERSATION_SOURCES = new Set(['user', 'ai', 'stdout']);

interface StoredLog {
	id?: unknown;
	timestamp?: unknown;
	source?: unknown;
	text?: unknown;
	metadata?: { toolState?: unknown; hiddenProgress?: unknown } | null;
}

interface StoredTab {
	id?: unknown;
	hidden?: unknown;
	logs?: unknown;
}

/** One turn of a tab: the user's message and everything said until the next. */
interface Turn {
	/** Id of the entry that opens the turn. */
	id: string;
	parts: string[];
	/** Newest timestamp of ANY entry in the turn, tool calls included. */
	lastActivity: number;
}

function isConversationText(log: StoredLog): log is StoredLog & { text: string } {
	if (typeof log.text !== 'string' || log.text.trim() === '') return false;
	if (typeof log.source !== 'string' || !CONVERSATION_SOURCES.has(log.source)) return false;
	// Tool cards and collapsed progress ride the same sources as real output.
	return !log.metadata?.toolState && !log.metadata?.hiddenProgress;
}

/**
 * A tab's persisted log as turns. A `user` entry opens a turn; entries before
 * the first one (the tail of a turn whose opening fell out of the persisted
 * window) form a turn of their own, anchored on the first entry kept.
 */
function turnsOf(logs: readonly StoredLog[]): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | null = null;
	for (const log of logs) {
		if (typeof log.id !== 'string' || log.id === '') continue;
		if (!current || log.source === 'user') {
			current = { id: log.id, parts: [], lastActivity: 0 };
			turns.push(current);
		}
		if (typeof log.timestamp === 'number') {
			current.lastActivity = Math.max(current.lastActivity, log.timestamp);
		}
		if (isConversationText(log)) current.parts.push(log.text.trim());
	}
	return turns;
}

/**
 * The index items for one agent's persisted tabs.
 *
 * - A hidden tab (a cross-agent consult answered in the background) is left
 *   out: a search hit opens what it found, and opening a consult tab would
 *   turn background work into a foreground tab.
 * - Every turn but a tab's newest is immutable: the next message is only
 *   written once the turn before it has ended.
 * - A tab's newest turn is indexed once it has been quiet for
 *   {@link TRANSCRIPT_SETTLE_MS}, and stays mutable while it is the newest.
 */
export function transcriptItems(
	session: Record<string, unknown>,
	now: number
): SemanticSourceItem[] {
	const agentId = typeof session.id === 'string' ? session.id : '';
	const tabs = Array.isArray(session.aiTabs) ? (session.aiTabs as StoredTab[]) : [];
	if (agentId === '') return [];

	const items: SemanticSourceItem[] = [];
	for (const tab of tabs) {
		if (!tab || typeof tab.id !== 'string' || tab.hidden === true) continue;
		const turns = turnsOf(Array.isArray(tab.logs) ? (tab.logs as StoredLog[]) : []);
		turns.forEach((turn, index) => {
			const newest = index === turns.length - 1;
			if (newest && now - turn.lastActivity < TRANSCRIPT_SETTLE_MS) return;
			const text = turn.parts.join('\n\n');
			if (text === '') return;
			items.push({
				sourceType: 'transcript',
				sourceId: transcriptSourceId(tab.id as string, turn.id),
				agentId,
				text,
				mutable: newest,
			});
		});
	}
	return items;
}

/** Persisted AI tab transcripts, one group per agent. */
export function createTranscriptReader(deps: {
	/** Every agent record in the sessions store. */
	sessions: () => Array<Record<string, unknown>>;
	now?: () => number;
}): SemanticSourceReader {
	return {
		sourceType: 'transcript',
		async groups() {
			const groups: SemanticSourceGroup[] = [];
			for (const session of deps.sessions()) {
				const id = session?.id;
				if (typeof id !== 'string' || id === '') continue;
				groups.push({
					key: id,
					async load() {
						// Read again at load time: the record listed a moment ago may
						// have been replaced by a newer save.
						const current = deps.sessions().find((record) => record?.id === id);
						return current ? transcriptItems(current, (deps.now ?? Date.now)()) : [];
					},
				});
			}
			return groups;
		},
	};
}

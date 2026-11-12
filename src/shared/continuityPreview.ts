/**
 * Continuity preview: the evidence digest of ONE tab, and the gates that decide
 * what may go into it.
 *
 * `buildContextDigest` reads the entries it is handed and trusts the caller that
 * they are one conversation. This module is the caller's side of that promise.
 * It is what an explicit "show me what a continuation must keep" request runs,
 * and nothing else calls the digest (see the guard test beside it).
 *
 * THE GATES
 *  - Target. The tab read must be the tab asked about, on the agent asked
 *    about. A consult tab (another agent's exchange) and a document chat are
 *    refused: their words are not this agent's user speaking about this work.
 *  - Transcript. The digest is built from the tab's own entries, never from
 *    History. A tab with no entries (cleared, or never used) gets an empty
 *    digest that says so; History is not read to fill it in, because that would
 *    restore an old task into a tab that no longer holds it.
 *  - Synopses. A History synopsis is an optional excerpt, and it is admitted
 *    only when it provably belongs to THIS tab's conversation: an interactive
 *    turn that did not fail, owned by this agent, in the provider session the
 *    tab is bound to, and either a native owner record that matches the tab's
 *    (`matchesNativeSessionBinding`: account, host and directory, not a session
 *    id alone) or, where no owner record exists on one side, the same tab id.
 *    A bound owner that differs is a refusal, not a fallback. A synopsis older
 *    than the first entry the tab still holds was cleared or trimmed away and
 *    is refused; one older than the last completed compaction is shown, marked.
 *    Every refusal is counted by reason and reported, never silent.
 *  - Window. Maestro stores only the newest 100 entries of a tab, so a tab that
 *    has been through a restart may hold a tail of its conversation: an early
 *    request or constraint can be missing, and a synopsis of that early work
 *    is refused like one from a cleared tab (older than the first entry held).
 *    From 100 entries up the preview says so.
 *  - Provider window. The provider may have compacted a session on its own
 *    (Claude Code does when its window fills). The transcript Maestro holds does
 *    not show that, and no projection of the provider's own transcript with a
 *    proven owner reaches this module, so the preview says the window is unknown
 *    rather than guess one.
 *
 * Pure: no Electron, React, IPC, clock or file access. It starts no turn and
 * writes nothing. The output is plain text with its control characters
 * removed, so it is safe to print and to show verbatim, and it is never to be
 * rendered as Markdown (excerpts are model text).
 */

import { buildContextDigest, type ContextDigest, type DigestEntry } from './contextDigest';
import { MAX_PERSISTED_SESSION_LOGS } from './deferredSessionContent';
import {
	matchesNativeSessionBinding,
	type NativeSessionBinding,
} from './maestro-lib/agents/providerSwap';
import { stripControlCharacters } from './stringUtils';
import type { TabContinuityPreview } from './tabContextOps';

/** A transcript entry as the digest reads it, plus when it was written. */
export interface ContinuityEntry extends DigestEntry {
	timestamp?: number;
}

/** The slice of an AI tab the preview reads. */
export interface ContinuityTab {
	id: string;
	/** The provider session the tab is bound to right now. Null: none yet. */
	agentSessionId: string | null;
	/** Observed owner of that session. Absent or `unknown` proves nothing. */
	nativeSessionBinding?: NativeSessionBinding;
	/** The provider that owns the tab's live session. */
	provider: string;
	state?: 'idle' | 'busy';
	/** Set on a tab that holds another agent's consult. */
	consultOrigin?: unknown;
	/** Set on a tab that is a chat about a document. */
	documentOrigin?: unknown;
	/** The tab's transcript, oldest first. */
	entries: readonly ContinuityEntry[];
}

/** The slice of a History entry the preview reads. */
export interface ContinuityHistoryRecord {
	id: string;
	type: string;
	timestamp: number;
	success?: boolean;
	/** The agent that owns the entry. */
	sessionId?: string;
	/** The tab the turn ran in. */
	tabId?: string;
	/** The provider session the turn ran in. */
	agentSessionId?: string;
	provider?: string;
	nativeSessionBinding?: NativeSessionBinding;
	summary?: string;
	fullResponse?: string;
}

export interface ContinuityPreviewInput {
	/** What was asked for. The agent and tab below must be these. */
	target: { agentId: string; tabId: string };
	/** The agent the tab was read from. */
	agentId: string;
	tab: ContinuityTab;
	/** The agent's History, any order. Null: it could not be read. */
	history: readonly ContinuityHistoryRecord[] | null;
	/** More History exists than was read. */
	historyTruncated?: boolean;
	/** Characters the digest's listed items may use. */
	maxChars?: number;
}

/** Why a History entry was kept out of the digest. */
export type SynopsisRefusal =
	| 'not-user-turn'
	| 'failed-turn'
	| 'unknown-owner'
	| 'other-agent'
	| 'unproven'
	| 'other-session'
	| 'other-provider'
	| 'owner-mismatch'
	| 'other-tab'
	| 'before-transcript';

/** How a synopsis was tied to the tab: a matching owner record, or the tab and session ids. */
export type SynopsisBasis = 'binding' | 'tab';

export interface ContinuityPreview {
	/** Built from this tab's transcript alone. */
	digest: ContextDigest;
	/** What the gates found about the evidence, one plain sentence each. */
	notices: string[];
	synopses: {
		/** Entries that passed every gate. The digest may still skip a failed or empty one. */
		admitted: number;
		basis: Record<SynopsisBasis, number>;
		refused: Partial<Record<SynopsisRefusal, number>>;
	};
	entryCount: number;
	/** The whole preview as plain text. */
	text: string;
}

export type ContinuityPreviewResult =
	| { ok: true; preview: ContinuityPreview }
	| { ok: false; code: 'wrong-target' | 'not-a-conversation'; error: string };

/** The phrase each refusal reads as in the notice. */
const REFUSAL_LABELS: Record<SynopsisRefusal, string> = {
	'not-user-turn': 'not an interactive turn',
	'failed-turn': 'the turn failed',
	'unknown-owner': 'no owning agent recorded',
	'other-agent': 'another agent',
	unproven: 'no tab or owner recorded',
	'other-session': 'another provider session',
	'other-provider': 'another provider',
	'owner-mismatch': 'a different native owner',
	'other-tab': 'another tab',
	'before-transcript': 'older than the first entry held (cleared or trimmed away)',
};

const SHOWN_ID_CHARS = 80;

/** An id or name from outside the preview, made safe to show in a sentence. */
function shown(value: string): string {
	return stripControlCharacters(value).replace(/\s+/g, ' ').trim().slice(0, SHOWN_ID_CHARS);
}

const isBound = (binding: NativeSessionBinding | undefined): boolean => binding?.state === 'bound';

/**
 * Is this History entry provably part of the tab's conversation? The first
 * check that fails is the reason. A match by owner record is the stronger
 * proof; a match by tab id is accepted only when an owner record is missing on
 * one side, and never against a bound owner that differs.
 */
function admit(
	record: ContinuityHistoryRecord,
	agentId: string,
	tab: ContinuityTab
): { basis: SynopsisBasis } | { refusal: SynopsisRefusal } {
	if (record.type !== 'USER') return { refusal: 'not-user-turn' };
	if (record.success === false) return { refusal: 'failed-turn' };
	if (!record.sessionId) return { refusal: 'unknown-owner' };
	if (record.sessionId !== agentId) return { refusal: 'other-agent' };
	if (!record.agentSessionId || !tab.agentSessionId) return { refusal: 'unproven' };
	if (record.agentSessionId !== tab.agentSessionId) return { refusal: 'other-session' };
	if (record.provider && record.provider !== tab.provider) return { refusal: 'other-provider' };
	if (isBound(record.nativeSessionBinding) && isBound(tab.nativeSessionBinding)) {
		return matchesNativeSessionBinding(tab.nativeSessionBinding, record.nativeSessionBinding)
			? { basis: 'binding' }
			: { refusal: 'owner-mismatch' };
	}
	if (!record.tabId) return { refusal: 'unproven' };
	return record.tabId === tab.id ? { basis: 'tab' } : { refusal: 'other-tab' };
}

/** When the tab's oldest entry was written, and when its last completed compaction was. */
function transcriptWindow(entries: readonly ContinuityEntry[]): {
	firstAt?: number;
	compactedAt?: number;
} {
	let compactedAt: number | undefined;
	let firstAt: number | undefined;
	for (const entry of entries) {
		if (typeof entry.timestamp !== 'number') continue;
		// The oldest time, not the first entry's: a merged or forked tab need not be in order.
		if (firstAt === undefined || entry.timestamp < firstAt) firstAt = entry.timestamp;
		if (entry.contextCompaction?.status === 'done') compactedAt = entry.timestamp;
	}
	return { firstAt, compactedAt };
}

function readSynopses(input: ContinuityPreviewInput) {
	const { agentId, tab, history } = input;
	const refused: Partial<Record<SynopsisRefusal, number>> = {};
	const basis: Record<SynopsisBasis, number> = { binding: 0, tab: 0 };
	const admitted: { id: string; response: string; at: number; beforeCompaction?: boolean }[] = [];
	if (!history || tab.entries.length === 0) return { admitted, refused, basis };
	const { firstAt, compactedAt } = transcriptWindow(tab.entries);
	const seen = new Set<string>();
	for (const record of history) {
		if (seen.has(record.id)) continue;
		seen.add(record.id);
		const verdict = admit(record, agentId, tab);
		const refusal =
			'refusal' in verdict
				? verdict.refusal
				: firstAt !== undefined && record.timestamp < firstAt
					? 'before-transcript'
					: undefined;
		if (refusal) {
			refused[refusal] = (refused[refusal] ?? 0) + 1;
			continue;
		}
		if ('basis' in verdict) basis[verdict.basis] += 1;
		admitted.push({
			id: record.id,
			response: record.fullResponse ?? record.summary ?? '',
			at: record.timestamp,
			...(compactedAt !== undefined && record.timestamp < compactedAt
				? { beforeCompaction: true }
				: {}),
		});
	}
	admitted.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return { admitted, refused, basis };
}

function listNotices(
	input: ContinuityPreviewInput,
	synopses: ReturnType<typeof readSynopses>
): string[] {
	const { tab, history, historyTruncated } = input;
	const notices: string[] = [];
	if (tab.state === 'busy') {
		notices.push('A turn is running in this tab, so its newest entries may be incomplete.');
	}
	if (tab.entries.length >= MAX_PERSISTED_SESSION_LOGS) {
		notices.push(
			`This tab holds ${tab.entries.length} entries. Maestro keeps only the newest ${MAX_PERSISTED_SESSION_LOGS} of a tab across a restart, so an earlier request or constraint may be missing: the objective shown is the first one still held, not necessarily the first one made.`
		);
	}
	if (tab.entries.length === 0) {
		notices.push(
			'This tab has no transcript entries: it was cleared or never used. Nothing was read from History to fill it in.'
		);
	} else if (history === null) {
		notices.push('History could not be read, so no earlier synopsis is shown.');
	} else {
		if (!tab.agentSessionId) {
			notices.push(
				'This tab is not bound to a provider session yet, so no History synopsis can be tied to it.'
			);
		}
		const refusedTotal = Object.values(synopses.refused).reduce((sum, n) => sum + (n ?? 0), 0);
		if (refusedTotal) {
			const parts = (Object.keys(REFUSAL_LABELS) as SynopsisRefusal[])
				.filter((reason) => synopses.refused[reason])
				.map((reason) => `${REFUSAL_LABELS[reason]}: ${synopses.refused[reason]}`);
			notices.push(
				`${refusedTotal} History ${refusedTotal === 1 ? 'entry was' : 'entries were'} not used, by reason (${parts.join(', ')}).`
			);
		}
		const { binding, tab: byTab } = synopses.basis;
		if (binding + byTab) {
			notices.push(
				`${binding + byTab} synopsis ${binding + byTab === 1 ? 'was' : 'excerpts were'} tied to this tab by ${[
					...(binding ? [`a matching native owner record (${binding})`] : []),
					...(byTab
						? [`the tab and session ids, with no native owner record on one side (${byTab})`]
						: []),
				].join(' and ')}.`
			);
		}
		if (historyTruncated) {
			notices.push(
				'Only the newest History entries were read, so an older synopsis of this tab may be missing.'
			);
		}
	}
	notices.push(
		"Whether the provider compacted this conversation on its own is not known: the preview reads Maestro's transcript, not the provider's."
	);
	return notices;
}

/**
 * Plan the preview of one tab, or refuse. Deterministic: the same input gives
 * the same output, and the input is never changed.
 */
export function planContinuityPreview(input: ContinuityPreviewInput): ContinuityPreviewResult {
	const { target, agentId, tab } = input;
	if (agentId !== target.agentId || tab.id !== target.tabId) {
		return {
			ok: false,
			code: 'wrong-target',
			error: `The tab read (${shown(tab.id)} of ${shown(agentId)}) is not the tab asked for (${shown(target.tabId)} of ${shown(target.agentId)}).`,
		};
	}
	if (tab.consultOrigin) {
		return {
			ok: false,
			code: 'not-a-conversation',
			error: `Tab ${shown(tab.id)} holds another agent's consult, not a conversation of this agent.`,
		};
	}
	if (tab.documentOrigin) {
		return {
			ok: false,
			code: 'not-a-conversation',
			error: `Tab ${shown(tab.id)} is a chat about a document, not a conversation to continue.`,
		};
	}

	const synopses = readSynopses(input);
	const digest = buildContextDigest({
		entries: tab.entries,
		synopses: synopses.admitted.map(({ id, response, beforeCompaction }) => ({
			id,
			response,
			...(beforeCompaction ? { beforeCompaction } : {}),
		})),
		agentId: tab.provider,
		maxChars: input.maxChars,
	});
	const notices = listNotices(input, synopses);
	const text = [
		`Continuity preview of tab ${shown(tab.id)} (${shown(tab.provider)}). Read only: nothing was sent, compacted, saved or changed.`,
		'',
		'Notices:',
		...notices.map((notice) => `- ${notice}`),
		'',
		digest.preview,
	].join('\n');

	return {
		ok: true,
		preview: {
			digest,
			notices,
			synopses: {
				admitted: synopses.admitted.length,
				basis: synopses.basis,
				refused: synopses.refused,
			},
			entryCount: tab.entries.length,
			text,
		},
	};
}

/** The part of a preview that crosses the wire to `maestro-cli`. */
export function continuityWire(preview: ContinuityPreview): TabContinuityPreview {
	return {
		text: preview.text,
		entries: preview.entryCount,
		synopses: {
			shown: preview.digest.excerpts.length,
			refused: preview.synopses.refused,
		},
		notices: preview.notices,
		unknowns: preview.digest.unknowns.map((unknown) => `${unknown.field}: ${unknown.reason}`),
	};
}

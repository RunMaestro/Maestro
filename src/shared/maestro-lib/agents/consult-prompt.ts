/**
 * @file consult-prompt.ts
 * @description The pure parts of a cross-agent consult: the prompt the consulted agent
 * receives, how a consult that ended early is worded, and the History entry the
 * consulted agent keeps.
 *
 * A consult is the same operation whether a typed `@mention` in the desktop starts it
 * or `maestro-cli ask` does, so these rules live in one place that the consult service
 * (`consult.ts`), the desktop's router shim and the renderer's dispatch hook all import.
 * Nothing here touches a process, a store or a clock.
 */

import type {
	CrossAgentRequest,
	CrossAgentResponseChunk,
	CrossAgentTranscriptEntry,
} from '../../crossAgentTypes';
import type { HistoryEntry } from '../../types';

/** Header prepended to a consult that forwards the source agent's transcript. */
const CONSULT_HEADER =
	'You are being consulted by another agent in Maestro. Below is the conversation transcript so far, followed by a question.';

/**
 * Header for a consult with no transcript behind it - `maestro-cli ask`, whose
 * whole point is a FRESH context: the calling agent writes a self-contained
 * question rather than relaying a conversation. Announcing a transcript that
 * isn't there sends the target hunting for context it will never find.
 */
const CONSULT_HEADER_NO_TRANSCRIPT =
	'You are being consulted by another agent in Maestro. There is no prior conversation to read - the question below is self-contained.';

/**
 * Access grant appended to the header when the source agent forwards its working
 * directory. The consult runs in the TARGET agent's own cwd, so this is the only
 * pointer it has to the user's project.
 *
 * Two modes, gated by the `crossAgentMentionsWritable` setting (default off).
 * The user-facing names for them are CONSULT and DELEGATION, so the grant text
 * uses those words rather than only "read-only" / "read/write":
 * - Consult (read-only, default): grant read but not write. This is advisory text
 *   ONLY; the real enforcement is `readOnlyMode: true` on the spawn
 *   (`--permission-mode plan` for Claude Code, `--sandbox read-only` for Codex,
 *   ...). Both must stay in agreement: consults used to spawn read-write while
 *   saying this, and targets took the write path anyway. We also tell the target
 *   how the user can lift the restriction, so a "make this change" request gets a
 *   useful answer instead of a silent no-op.
 * - Delegation (read/write): the user opted in, so we drop the write prohibition
 *   and let the target edit files (spawns with `readOnlyMode: false`).
 */
export function cwdGrant(sourceCwd: string, writable: boolean): string {
	if (writable) {
		return (
			`The user is working in the directory \`${sourceCwd}\`. ` +
			'You have permission to READ and MODIFY files under that directory to answer. ' +
			'The user has enabled read/write cross-agent mentions, so this is a DELEGATION rather ' +
			'than a consult: you may apply changes directly.'
		);
	}
	return (
		`The user is working in the directory \`${sourceCwd}\`. ` +
		'You have permission to READ files under that directory to inform your answer. ' +
		'Do NOT modify or create files: this is a one-shot READ-ONLY consultation, so if changes ' +
		'are needed, describe them in your reply and let the user apply them. If the user is asking ' +
		'you to make changes directly, tell them cross-agent mentions are consults (read-only) by ' +
		'default and they can turn them into delegations in Settings > General > Cross-Agent ' +
		'Mentions (set Consult or Delegate to Read/Write).'
	);
}

/** Prefix for the relayed user question, appended after the transcript. */
const QUESTION_PREFIX = '**Question from the user (relayed via the source agent):**';

/** Human-readable role label for a transcript entry's source. */
function roleLabel(source: string): string {
	switch (source) {
		case 'user':
			return '**User:**';
		case 'ai':
			return '**Assistant:**';
		case 'system':
			return '**System:**';
		default:
			// tool / thinking / stdout / stderr / error - only surfaced when they
			// carry visible text (see serializeTranscript), labelled generically.
			return '**Note:**';
	}
}

/**
 * Serialize a windowed transcript into a single human-readable block.
 * Entries with no visible text are dropped; tool/thinking entries only survive
 * if they carry visible text.
 */
export function serializeTranscript(transcript: CrossAgentTranscriptEntry[]): string {
	const parts: string[] = [];
	for (const entry of transcript) {
		const text = entry.text?.trim();
		if (!text) continue;
		parts.push(`${roleLabel(entry.source)} ${text}`);
	}
	return parts.join('\n');
}

/**
 * Build the full outgoing prompt: header + serialized transcript + the relayed
 * user question.
 */
export function buildCrossAgentPrompt(request: CrossAgentRequest, writable = false): string {
	const transcriptBlock = serializeTranscript(request.transcript);
	const intro = transcriptBlock ? CONSULT_HEADER : CONSULT_HEADER_NO_TRANSCRIPT;
	const header = request.sourceCwd ? `${intro}\n\n${cwdGrant(request.sourceCwd, writable)}` : intro;
	const sections = [header];
	if (transcriptBlock) {
		sections.push(transcriptBlock);
	}
	sections.push(`${QUESTION_PREFIX}\n${request.userPrompt}`);
	return sections.join('\n\n');
}

/**
 * The note explaining why a consult ended, or null when it simply finished. The
 * attribution header only carries `error` in an `sr-only` span, so the reason has
 * to reach the bubble body or the user never sees it.
 *
 * Stop and failure are deliberately worded apart: the user pressing Stop is not
 * the target agent failing to answer, and reporting it as one blames the wrong
 * party for something the user chose.
 */
export function crossAgentTerminationNote(
	chunk: Pick<CrossAgentResponseChunk, 'canceled' | 'error' | 'targetAgentName'>
): string | null {
	if (chunk.canceled) return `⏹ ${chunk.targetAgentName} was stopped.`;
	if (chunk.error) return `⚠️ ${chunk.targetAgentName} could not respond: ${chunk.error}`;
	return null;
}

/** Label for a consult tab on the target: signals an inbound consult + who from. */
export function buildConsultTabName(sourceAgentName: string): string {
	return `↩ ${sourceAgentName}`;
}

/** What {@link buildConsultHistoryEntry} derives the target's History entry from. */
export interface ConsultHistoryEntryInput {
	entryId: string;
	timestamp: number;
	/** Display name of the agent that did the consulting. */
	sourceAgentName: string;
	/** Short subject derived from the question; may be empty. */
	subject: string;
	/** Accumulated response text (empty on a consult that failed before answering). */
	accumulated: string;
	/** Failure reason, when the consult errored. */
	error?: string;
	/** The user stopped the consult; not a failure of the target agent. */
	canceled?: boolean;
	/** The target agent's provider session id, when one was captured. */
	agentSessionId?: string;
	/** Fallback label when there is no subject. */
	consultTabName?: string | null;
	targetName?: string | null;
	historySessionId: string;
	projectPath: string;
}

/** Build the History entry the TARGET agent keeps for a finished consult. */
export function buildConsultHistoryEntry(opts: ConsultHistoryEntryInput): HistoryEntry {
	// Summary names WHO consulted and ABOUT WHAT; the pill carries the subject so
	// multiple consults from the same agent are distinguishable at a glance. The
	// consult TAB stays named after the source agent (it's the reused container
	// for every consult from that tab) - only this per-consult entry gets the subject.
	const summary = opts.subject
		? `Consulted by ${opts.sourceAgentName}: ${opts.subject}`
		: `Consulted by ${opts.sourceAgentName}`;
	const sessionName = opts.subject
		? `↩ ${opts.subject}`
		: (opts.consultTabName ?? opts.targetName ?? undefined) || undefined;

	// A failed or stopped consult may accumulate nothing, so the raw text alone
	// would leave the detail view blank. The reason lives on the chunk - not in
	// `accumulated` - so fold it in here the same way the inline bubble does
	// (partial text first, then the reason). A cancel is recorded as a SUCCESS
	// with a note: the user stopping a consult is not the target failing.
	const endNote = opts.canceled
		? '⏹ Consult stopped by the user.'
		: opts.error
			? `⚠️ Consult failed: ${opts.error}`
			: '';
	const detailFallback = [opts.accumulated, endNote].filter(Boolean).join('\n\n');

	return {
		id: opts.entryId,
		// A consult is an ordinary message that happened to be proxied in from
		// another agent - NOT automation. Logging it as AUTO made it render as an
		// Auto Run task and inflated the Auto Run counts.
		type: 'AGENT',
		timestamp: opts.timestamp,
		summary,
		// Raw response (or the failure reason) is the immediate fallback for the
		// detail view; the desktop replaces it with a condensed summary once a
		// background synopsis pass returns.
		fullResponse: detailFallback || undefined,
		agentSessionId: opts.agentSessionId,
		sessionId: opts.historySessionId,
		sessionName,
		projectPath: opts.projectPath,
		sourceAgentName: opts.sourceAgentName,
		success: !opts.error,
	};
}

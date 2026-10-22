/**
 * Computer History digests on a local model: the `history-digests` Local
 * Models task.
 *
 * The digest scheduler (`src/main/computer-history/digests.ts`) calls this
 * while the digest source is `local`. The other writer is the digest agent,
 * which reads the files itself; a local model has no tools, so the text is
 * read here and handed over (`src/shared/computer-history/digestInput.ts`).
 *
 * A local model's context holds about one piece of a busy 15-minute window,
 * so an input that does not fit is read in pieces: each piece is answered with
 * notes, and one last call merges the notes into the digest. One piece that
 * fails abandons the digest: a summary with a hole in it would not say so.
 *
 * With no model assigned there is no writer (`hasModel()`), so the scheduler
 * queues nothing. The verdicts of a call, none of which falls back to an agent:
 *   - `off` (the model was unassigned after the job was queued) fails with
 *     where to choose one.
 *   - `unavailable` fails with the reason and raises the Local Models notice
 *     once (`reportLocalTaskUnavailable`): digests run with nobody watching,
 *     so a silent skip every 15 minutes would read as the feature being broken.
 *   - `cancelled` is the per-call timeout.
 *
 * Every call is `background`: nobody waits on a digest, so it stands aside for
 * a task someone is waiting on and is not counted as one.
 */

import * as fs from 'fs/promises';

import {
	buildLocalDigestInstruction,
	renderDigestsForRollup,
	renderSegmentForDigest,
	type LocalDigestInstruction,
} from '../../shared/computer-history/digestInput';
import { parseSegmentText } from '../../shared/computer-history/reader';
import { fenceUntrusted } from '../../shared/computer-history/status';
import { estimateTokenCount } from '../../shared/formatters';
import { taskAssignmentLocation } from '../../shared/local-models/settings-location';
import {
	LOCAL_MODEL_TASKS,
	localModelAssignmentSourceLabel,
	resolveLocalModelAssignment,
	type LocalModelAssignments,
} from '../../shared/local-models/tasks';
import { getPrompt } from '../prompt-manager';
import type { SafeSendFn } from '../utils/safe-send';
import { captureException } from '../utils/sentry';
import { getConfiguredLocalModelEndpoints } from './endpoint-service';
import { readLocalModelAssignments, type LocalModelSource } from './sources';
import { clearLocalTaskNotice, reportLocalTaskUnavailable } from './task-notices';
import {
	runLocalTask,
	whenNoInteractiveLocalTask,
	type LocalTaskInput,
	type LocalTaskResult,
} from './task-router';
import { chunkText } from './text-chunker';

const TASK_ID = 'history-digests';

/** Where a person assigns the task's source, for refusal text. */
const ASSIGNMENT_LOCATION = taskAssignmentLocation(TASK_ID);

/**
 * Input tokens in one call, by the 4-characters-per-token estimate. Captured
 * text (URLs, code, tables) runs denser than prose, so this is sized to fit a
 * 4096-token context with the system prompt and the reply even at 3
 * characters per token.
 */
export const DIGEST_PIECE_TOKENS = 1500;

/** The most pieces one digest is read in. A segment is cut to fit them. */
export const DIGEST_MAX_PIECES = 6;

/** Characters of a segment a digest reads: every piece, full. */
export const DIGEST_MAX_INPUT_CHARS = DIGEST_MAX_PIECES * DIGEST_PIECE_TOKENS * 4;

/** Reply budget for the notes of one piece. The notes of every piece fit one call. */
const DIGEST_NOTES_MAX_TOKENS = 240;

/** Reply budget for a digest or a roll-up. */
const DIGEST_MAX_TOKENS = 600;

/** How long one call may take. Long enough for a cold model to load. */
export const DIGEST_CALL_TIMEOUT_MS = 3 * 60_000;

/** What the scheduler hands over: the same facts the agent prompt names. */
export type HistoryDigestRequest =
	| {
			kind: '15m';
			/** Absolute path of the closed segment file. */
			segmentPath: string;
			windowStartIso: string;
			windowEndIso: string;
	  }
	| {
			kind: '6h';
			/** Absolute paths of the block's 15-minute digests, in time order. */
			digestPaths: string[];
			blockStartIso: string;
			blockEndIso: string;
	  };

export type HistoryDigestResult =
	| {
			success: true;
			answer: string;
			/** What a person calls the model that wrote it. */
			writtenBy: string;
	  }
	| { success: false; error: string };

export interface HistoryDigestWriterOptions {
	/** Broadcast channel for the one-time "skipped" notice. */
	safeSend?: SafeSendFn;
	/** Test seam. Defaults to the task router. */
	runTask?: (input: LocalTaskInput) => Promise<LocalTaskResult>;
	/** Test seam. Defaults to the stored assignments. */
	readAssignments?: () => LocalModelAssignments | undefined;
}

export interface HistoryDigestWriter {
	/**
	 * Whether the task is assigned a model. With none there is no writer, the
	 * same as an agent source with no agent: the scheduler queues nothing.
	 */
	hasModel(): boolean;
	write(request: HistoryDigestRequest): Promise<HistoryDigestResult>;
}

/** The text of one call and the model that wrote it. */
interface DigestReply {
	text: string;
	source: LocalModelSource;
}

/** A call that did not produce text, as the failure the scheduler records. */
class DigestCallFailed extends Error {}

/**
 * Build the writer the Computer History service is given. Throws only for an
 * unclassified failure inside the model engine, which is a bug: it is reported
 * to Sentry here, because the scheduler records a failed digest and moves on.
 */
export function createHistoryDigestWriter(
	options: HistoryDigestWriterOptions = {}
): HistoryDigestWriter {
	const runTask = options.runTask ?? ((input) => runLocalTask(TASK_ID, input));
	const readAssignments = options.readAssignments ?? readLocalModelAssignments;
	const label = LOCAL_MODEL_TASKS[TASK_ID].label;

	const ask = async (prompt: string, maxTokens: number): Promise<DigestReply> => {
		await whenNoInteractiveLocalTask();
		const verdict = await runTask({
			system: getPrompt('computer-history-digest-local'),
			prompt,
			maxTokens,
			background: true,
			signal: AbortSignal.timeout(DIGEST_CALL_TIMEOUT_MS),
		});
		switch (verdict.status) {
			case 'off':
				// The assignment changed between the scheduler's check and the call.
				throw new DigestCallFailed(
					`${label} has no model. Choose one in the Computer History settings or in ${ASSIGNMENT_LOCATION}.`
				);
			case 'use-utility-agent':
				// The registry refuses this assignment for the task; a hand-edited
				// settings file is the only way here.
				throw new DigestCallFailed(
					`${label} cannot run on the Utility Agent. Assign it a local model or an endpoint in ${ASSIGNMENT_LOCATION}.`
				);
			case 'cancelled':
				throw new DigestCallFailed('The assigned model took too long to write the digest.');
			case 'unavailable':
				reportLocalTaskUnavailable({ safeSend: options.safeSend, taskId: TASK_ID, verdict });
				throw new DigestCallFailed(verdict.reason);
			case 'ok': {
				const text = verdict.text.trim();
				if (text === '') throw new DigestCallFailed('The assigned model returned an empty digest.');
				return { text, source: verdict.source };
			}
		}
	};

	const summarize = async (job: LocalDigestInstruction, input: string): Promise<DigestReply> => {
		const pieces = chunkText(input, {
			countTokens: estimateTokenCount,
			maxTokens: DIGEST_PIECE_TOKENS,
			overlapTokens: 0,
			// Windows close at line ends, so they can run under-full.
			maxChunks: 2 * DIGEST_MAX_PIECES,
		});
		const request = (at: Parameters<typeof buildLocalDigestInstruction>[1], body: string) =>
			`${buildLocalDigestInstruction(job, at)}\n\n${fenceUntrusted(body)}`;
		if (pieces.length === 1) {
			return ask(request({ stage: 'whole' }, pieces[0]), DIGEST_MAX_TOKENS);
		}
		const notes: string[] = [];
		for (const [index, piece] of pieces.entries()) {
			const reply = await ask(
				request({ stage: 'part', part: index + 1, parts: pieces.length }, piece),
				DIGEST_NOTES_MAX_TOKENS
			);
			notes.push(reply.text);
		}
		return ask(
			request({ stage: 'notes', parts: pieces.length }, notes.join('\n\n')),
			DIGEST_MAX_TOKENS
		);
	};

	const write = async (request: HistoryDigestRequest): Promise<HistoryDigestResult> => {
		try {
			let job: LocalDigestInstruction;
			let input: string;
			if (request.kind === '15m') {
				const events = parseSegmentText(await fs.readFile(request.segmentPath, 'utf-8'));
				const rendered = renderSegmentForDigest(events, { maxChars: DIGEST_MAX_INPUT_CHARS });
				input = rendered.text;
				job = {
					kind: '15m',
					windowStartIso: request.windowStartIso,
					windowEndIso: request.windowEndIso,
					shown: rendered.shown,
					total: rendered.total,
				};
			} else {
				const bodies = await Promise.all(
					request.digestPaths.map((digestPath) => fs.readFile(digestPath, 'utf-8'))
				);
				input = renderDigestsForRollup(bodies);
				job = {
					kind: '6h',
					blockStartIso: request.blockStartIso,
					blockEndIso: request.blockEndIso,
					digests: bodies.length,
				};
			}
			if (input.trim() === '') {
				return { success: false, error: 'The window holds nothing to summarize.' };
			}
			const reply = await summarize(job, input);
			clearLocalTaskNotice(TASK_ID);
			const model =
				localModelAssignmentSourceLabel(reply.source, getConfiguredLocalModelEndpoints()) ??
				reply.source.type;
			return { success: true, answer: reply.text, writtenBy: `local model \`${model}\`` };
		} catch (error) {
			if (error instanceof DigestCallFailed) return { success: false, error: error.message };
			// A file that went away (clear, retention) is an ordinary skip.
			if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
				return { success: false, error: 'The history to summarize is no longer on disk.' };
			}
			void captureException(error instanceof Error ? error : new Error(String(error)), {
				operation: 'computerHistory:localDigest',
				kind: request.kind,
			});
			throw error;
		}
	};

	return {
		hasModel: () => resolveLocalModelAssignment(readAssignments(), TASK_ID).type !== 'off',
		write,
	};
}

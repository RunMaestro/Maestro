/**
 * Computer History digests on a local model: the `history-digests` Local
 * Models task.
 *
 * The digest scheduler (`src/main/computer-history/digests.ts`) calls this
 * while the digest source is `local`. The other writer is the digest agent,
 * which reads the files itself; a local model has no tools, so the text is
 * read here and handed over (`src/shared/computer-history/digestInput.ts`).
 *
 * Every call asks for a {@link DIGEST_CONTEXT_TOKENS} context, which holds a
 * whole busy 15-minute window. An input that still does not fit (a window
 * full of large screens, or a model or server with a smaller context) is read
 * in pieces: each piece is answered with notes, and one last call merges the
 * notes into the digest. One piece that fails abandons the digest: a summary
 * with a hole in it would not say so.
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
	renderPreviousDigest,
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
	type LocalModelAssignment,
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
import { getLocalModel } from '../../shared/local-models/model-catalog';
import { MODEL_SERVER_ENDPOINT_ID } from '../../shared/local-models/model-server';
import type { LocalModelEndpoint } from '../../shared/local-models/endpoints';

const TASK_ID = 'history-digests';

/** Where a person assigns the task's source, for refusal text. */
const ASSIGNMENT_LOCATION = taskAssignmentLocation(TASK_ID);

/**
 * What one digest may read and write, for the context its source runs at.
 * Every size is derived from `contextTokens` so a call never overflows it:
 * input pieces are counted at 4 characters per token, but captured text (URLs,
 * code, tables) can run to 3, so each budget leaves that margin plus the
 * system prompt, the instruction, the previous digest, and the reply.
 */
export interface DigestBudget {
	/** The context every call asks for (`contextTokens`). */
	contextTokens: number;
	/** Input tokens in one call, by the 4-characters-per-token estimate. */
	pieceTokens: number;
	/** The most pieces one digest is read in. A segment is cut to fit them. */
	maxPieces: number;
	/** Reply budget for the notes of one piece. The notes of every piece fit one call. */
	notesMaxTokens: number;
	/** Reply budget for a digest or a roll-up. */
	replyMaxTokens: number;
	/** The most of the previous digest's summary shown, in characters. */
	previousChars: number;
}

/**
 * The context every digest call asks for when its source can hold it. A whole
 * busy 15-minute window fits in one call at this size, so the model reads the
 * window itself instead of notes on pieces of it.
 */
export const DIGEST_CONTEXT_TOKENS = 32_768;

/**
 * For a source that runs at {@link DIGEST_CONTEXT_TOKENS} or more. A full piece
 * is about 26,700 real tokens at 3 characters per token; the rest of the call
 * is about 3,300.
 */
export const LARGE_DIGEST_BUDGET: DigestBudget = {
	contextTokens: DIGEST_CONTEXT_TOKENS,
	pieceTokens: 20_000,
	maxPieces: 4,
	notesMaxTokens: 600,
	replyMaxTokens: 1200,
	previousChars: 2000,
};

/**
 * For a source whose context is unknown or small: a server that runs at the
 * context it was started with (LM Studio, llama-server, vLLM), or a model
 * trained for less. Sized for a 4,096-token context.
 */
export const SMALL_DIGEST_BUDGET: DigestBudget = {
	contextTokens: 4096,
	pieceTokens: 1100,
	maxPieces: 6,
	notesMaxTokens: 200,
	replyMaxTokens: 600,
	previousChars: 600,
};

/** Characters of a segment a digest reads at most: every piece, full. */
export function digestMaxInputChars(budget: DigestBudget): number {
	return budget.maxPieces * budget.pieceTokens * 4;
}

/**
 * The budget for the task's assignment. Large when the context is one
 * Maestro sets or knows: an in-process model trained for it (the engine opens
 * the context each call asks for), Maestro's model server (its catalog models
 * run at 40,960), or Ollama (sent `num_ctx` per call). Small otherwise.
 */
export function digestBudgetFor(
	source: LocalModelAssignment,
	endpoints: readonly LocalModelEndpoint[]
): DigestBudget {
	if (source.type !== 'local' && source.type !== 'endpoint') return SMALL_DIGEST_BUDGET;
	if (source.type === 'local') {
		const trained = getLocalModel(source.modelId)?.contextLength ?? 0;
		return trained >= DIGEST_CONTEXT_TOKENS ? LARGE_DIGEST_BUDGET : SMALL_DIGEST_BUDGET;
	}
	if (source.endpointId === MODEL_SERVER_ENDPOINT_ID) return LARGE_DIGEST_BUDGET;
	const endpoint = endpoints.find((e) => e.id === source.endpointId);
	return endpoint?.kind === 'ollama' ? LARGE_DIGEST_BUDGET : SMALL_DIGEST_BUDGET;
}

/**
 * How long one call may take: a cold load of a large model plus reading a
 * full piece, on a laptop, with other work running.
 */
export const DIGEST_CALL_TIMEOUT_MS = 10 * 60_000;

/** What the scheduler hands over: the same facts the agent prompt names. */
export type HistoryDigestRequest =
	| {
			kind: '15m';
			/** Absolute path of the closed segment file. */
			segmentPath: string;
			windowStartIso: string;
			windowEndIso: string;
			/**
			 * Absolute path of the nearest earlier digest of the last hour, or
			 * null. Its summary is shown for continuity; a missing file is skipped.
			 */
			previousDigestPath?: string | null;
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
 * The previous digest's summary, or '' when there is none. A previous digest
 * that went away between the scheduler's check and this read (cleared,
 * retention) only costs the continuity, never the digest.
 */
async function readPreviousDigest(
	previousDigestPath: string | null | undefined,
	maxChars: number
): Promise<string> {
	if (!previousDigestPath) return '';
	try {
		return renderPreviousDigest(await fs.readFile(previousDigestPath, 'utf-8'), maxChars);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return '';
		throw error;
	}
}

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

	const ask = async (
		prompt: string,
		maxTokens: number,
		budget: DigestBudget
	): Promise<DigestReply> => {
		await whenNoInteractiveLocalTask();
		const verdict = await runTask({
			system: getPrompt('computer-history-digest-local'),
			prompt,
			maxTokens,
			contextTokens: budget.contextTokens,
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

	const summarize = async (
		job: LocalDigestInstruction,
		input: string,
		budget: DigestBudget,
		previous = ''
	): Promise<DigestReply> => {
		const pieces = chunkText(input, {
			countTokens: estimateTokenCount,
			maxTokens: budget.pieceTokens,
			overlapTokens: 0,
			// Windows close at line ends, so they can run under-full.
			maxChunks: 2 * budget.maxPieces,
		});
		// The previous digest goes only to a call that writes the digest, never
		// to a notes call, and as its own fenced block (it was written from
		// captured text, so it is as untrusted as the record).
		const request = (at: Parameters<typeof buildLocalDigestInstruction>[1], body: string) => {
			const withPrevious = previous !== '' && at.stage !== 'part';
			const instruction = buildLocalDigestInstruction(
				job.kind === '15m' ? { ...job, hasPrevious: withPrevious } : job,
				at
			);
			return withPrevious
				? `${instruction}\n\n${fenceUntrusted(previous)}\n\n${fenceUntrusted(body)}`
				: `${instruction}\n\n${fenceUntrusted(body)}`;
		};
		if (pieces.length === 1) {
			return ask(request({ stage: 'whole' }, pieces[0]), budget.replyMaxTokens, budget);
		}
		const notes: string[] = [];
		for (const [index, piece] of pieces.entries()) {
			const reply = await ask(
				request({ stage: 'part', part: index + 1, parts: pieces.length }, piece),
				budget.notesMaxTokens,
				budget
			);
			notes.push(reply.text);
		}
		return ask(
			request({ stage: 'notes', parts: pieces.length }, notes.join('\n\n')),
			budget.replyMaxTokens,
			budget
		);
	};

	const write = async (request: HistoryDigestRequest): Promise<HistoryDigestResult> => {
		try {
			const budget = digestBudgetFor(
				resolveLocalModelAssignment(readAssignments(), TASK_ID),
				getConfiguredLocalModelEndpoints()
			);
			let job: LocalDigestInstruction;
			let input: string;
			let previous = '';
			if (request.kind === '15m') {
				previous = await readPreviousDigest(request.previousDigestPath, budget.previousChars);
				const events = parseSegmentText(await fs.readFile(request.segmentPath, 'utf-8'));
				const rendered = renderSegmentForDigest(events, {
					maxChars: digestMaxInputChars(budget),
				});
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
				input = renderDigestsForRollup(bodies, { maxChars: digestMaxInputChars(budget) });
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
			const reply = await summarize(job, input, budget, previous);
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

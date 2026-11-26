/**
 * What the runtime writes down when a turn ends (gap L13, CH-5): the transcript, the History
 * entry, and the usage row, so the desktop shows the same conversation and counts the same work.
 *
 * | Record | Where | Written by |
 * | --- | --- | --- |
 * | Transcript | the tab's `logs` in `maestro-sessions.json` | `AgentRepository.appendTranscript` |
 * | History | `<userData>/history/<agentId>.jsonl` | `createHistoryWriter` |
 * | Usage | `query_events` in `<userData>/stats.db` | `createStatsRecorder` |
 *
 * The three are independent. Each is attempted in that order whatever the one before did, and
 * none throws: the turn already happened, and a record that could not be written is a line in
 * the result, not a failed turn.
 *
 * The History entry comes from a synopsis turn when the recorder has `summarize` (a host's
 * runtime: the desktop's exit rule, `runExitSynopsis`), so the same reply reads the same in every
 * mode: the turn must have done tool work (`turnDidMeaningfulWork`, with the tab's thinking mode
 * deciding whether its tool cards prove it, `thinkingLogsRecorded`) and run in a provider session,
 * and `summarize` then writes the entry once the tab is free. Without `summarize` the summary
 * comes from the answer (`summarizeAnswer`) and `fullResponse` is the answer itself.
 *
 * The transcript holds the user's message, the answer, and a failure, plus the turn's thinking and
 * tool cards when the tab's thinking mode keeps them past the turn's end ('sticky',
 * `logsKeptAtTurnEnd()`, the rule a local tab's exit cleanup applies). They stream live to the
 * client either way; the runtime folds them from the same events (`RecordedTurn.streamed`).
 *
 * A tab whose `saveToHistory` chip is off records no History entry (as on the desktop; a sender's
 * own chip, `RecordedTurn.saveToHistory`, stands in for the tab's for that turn), and an
 * interrupted or crashed turn records none either: History is the record of work that finished.
 * Usage is recorded for every turn that ran.
 */

import { formatSessionId } from '../store/tab-display';
import { TURN_CANCELED_NOTE, type LogEntryRecord } from '../store/transcript';
import type { AgentRecord, AITabRecord } from '../store/records';
import type { NativeSessionBinding } from '../agents/providerSwap';
import type { AgentRepository, TabWriteGuard } from '../agents/repository';
import { DEFAULT_RULE_CONTEXT, sshRecordOf, type RuleContext } from '../agents/rules';
import type { ClientResult } from '../client/types';
import type { MaestroPaths } from '../paths/resolve';
import { estimateContextUsage } from '../parsers/usage-aggregator';
import type { CompletedTurn } from '../run/run-to-completion';
import type { DataDirVerdict } from '../runtime/data-dir-lock';
import { usageStatsToTurnFields } from '../../turnUsageLedger';
import { compactLogToolOutputs } from '../../toolOutput';
import {
	logsKeptAtTurnEnd,
	type HistoryEntry,
	type ThinkingMode,
	type ToolType,
} from '../../types';
import type { AssembledTurn } from './assemble';
import { createHistoryWriter, type HistoryAppendResult, type HistoryWriter } from './history';
import {
	createStatsRecorder,
	readStatsCollectionEnabled,
	type StatsConnectionConstructor,
	type StatsRecordResult,
	type StatsRecorder,
} from './stats';
import { summarizeAnswer } from './summary';
import { thinkingLogsRecorded, turnDidMeaningfulWork } from '../../synopsis';

/** The stderr kept in a failure entry when the provider named no error. */
const STDERR_TAIL_CHARS = 500;

/** One finished turn, as the runtime knows it. */
export interface RecordedTurn {
	/** Original tab incarnation and turn/slot ownership, checked within each mutation queue. */
	writeGuard?: TabWriteGuard;
	/** Original turn attribution. It is not proof of canonical native ownership. */
	scope?: Readonly<{ projectPath: string; isRemote: boolean; isWorktree: boolean }>;
	/** Only the launch observer may bind this; absent/unknown never uses current settings. */
	nativeSessionBinding?: NativeSessionBinding;
	agentId: string;
	tabId: string;
	/** The turn as `assembleTurn` made it: what was sent and under which settings. */
	assembled: Pick<AssembledTurn, 'entry' | 'settings'>;
	/** How it ended, from `runAgentTurn`'s `result`. */
	completed: Pick<
		CompletedTurn,
		'outcome' | 'answerText' | 'sessionId' | 'usage' | 'error' | 'exit'
	>;
	/** When the message was sent, epoch ms. */
	startedAt: number;
	/** When the process ended, epoch ms. */
	endedAt: number;
	/**
	 * The person's message is already in the transcript (the runtime writes it when the turn
	 * starts, through `beginTurn`). The entries written here then start at the answer.
	 */
	userEntryWritten?: boolean;
	/** The machine the person sent the turn from (`TurnInput.originHost`): the entry's `hostname`. */
	originHost?: string;
	/**
	 * The sender's own save-to-History chip for this turn (`TurnOverrides.saveToHistory`), read in
	 * place of the tab's `saveToHistory`. Absent: the tab's chip decides.
	 */
	saveToHistory?: boolean;
	/**
	 * What the turn streamed, as `foldLiveTurn()` folded its events (the live tail a client drew).
	 * Its thinking and tool entries are written before the answer when the tab keeps them past the
	 * turn's end ('sticky'); the rest is recorded from `completed`.
	 */
	streamed?: readonly LogEntryRecord[];
}

/** What happened to each record. A skipped record says why. */
export interface TurnRecordResult {
	transcript: ClientResult<void>;
	/** `synopsis`: the entry was handed to `summarize`, which writes it after a synopsis turn. */
	history:
		| HistoryAppendResult
		| { ok: true; synopsis: true }
		| { ok: false; reason: 'not-recorded'; message: string };
	stats: StatsRecordResult;
}

/** A finished turn's History entry, handed to `TurnRecorderOptions.summarize`. */
export interface TurnSummaryHandoff {
	agentId: string;
	tabId: string;
	/** The provider, model, and effort the turn ran at, frozen at send. */
	settings: { provider: string; model?: string; effort?: string };
	/** The entry as the turn would write it; the synopsis replaces its summary and usage. */
	entry: HistoryEntry;
}

export interface TurnRecorderOptions {
	paths: Pick<MaestroPaths, 'historyDir' | 'statsFile' | 'settingsFile'>;
	repository: Pick<AgentRepository, 'getAgent' | 'getTab' | 'appendTranscript'> &
		Partial<Pick<AgentRepository, 'withTabWriteGuard'>>;
	/** The host's `better-sqlite3` loader (the CLI's `loadBetterSqlite3`). It throws when the module cannot load. */
	loadSqlite: () => StatsConnectionConstructor;
	/** Is this process still the data directory's writer? Asked before the History and usage writes. */
	fence?: () => DataDirVerdict;
	/** Ids and the clock for the entries it makes. */
	context?: Partial<RuleContext>;
	/**
	 * Write an eligible turn's History entry from a synopsis turn instead of from the answer. Called
	 * without waiting: the synopsis resumes the turn's provider session, so it runs once the turn
	 * has ended. It must not throw.
	 */
	summarize?(handoff: TurnSummaryHandoff): void;
	/** Test seams: the writers themselves. */
	historyWriter?: HistoryWriter;
	statsRecorder?: StatsRecorder;
}

export interface TurnRecorder {
	/** Write every record of a finished turn. Never throws. */
	recordTurn(turn: RecordedTurn): Promise<TurnRecordResult>;
}

/** The text of a failure entry for a crash the provider did not classify. */
export function describeCrash(exit: CompletedTurn['exit']): string {
	if (exit.spawnError) return `The agent could not be started: ${exit.spawnError.message}`;
	const stderr = exit.stderrText.trim().slice(-STDERR_TAIL_CHARS);
	const how = exit.signal
		? `was stopped by ${exit.signal}`
		: `exited with code ${exit.exitCode ?? 'unknown'}`;
	return stderr ? `The agent ${how}.\n${stderr}` : `The agent ${how}.`;
}

/**
 * The transcript entry for the message a person sent (CH-5): what they typed, never the hidden
 * layers. Pure; the id and time come from the caller.
 */
export function buildUserTranscriptEntry(
	entry: AssembledTurn['entry'],
	timestamp: number,
	ctx: Pick<RuleContext, 'newId'>
): LogEntryRecord {
	return {
		id: ctx.newId(),
		timestamp,
		source: 'user',
		text: entry.text,
		delivered: true,
		...(entry.images?.length ? { images: entry.images } : {}),
		...(entry.readOnly ? { readOnly: true } : {}),
		...(entry.aiCommand
			? {
					aiCommand: {
						command: entry.aiCommand.command,
						description: entry.aiCommand.description ?? '',
					},
				}
			: {}),
	};
}

/**
 * The transcript entries of one turn: the message the person sent (unless the runtime already
 * wrote it), the thinking and tool cards a 'sticky' tab keeps (`showThinking`, the tab's mode when
 * the turn ends), then the answer, then a failure when it crashed. Pure; ids and times come from
 * the caller.
 */
export function buildTurnTranscript(
	turn: RecordedTurn,
	ctx: RuleContext,
	showThinking?: unknown
): LogEntryRecord[] {
	const { entry, settings } = turn.assembled;
	const entries: LogEntryRecord[] = turn.userEntryWritten
		? []
		: [buildUserTranscriptEntry(entry, turn.startedAt, ctx)];

	const reasoning = (turn.streamed ?? []).filter(
		(streamed) => streamed.source === 'thinking' || streamed.source === 'tool'
	);
	entries.push(...compactLogToolOutputs(logsKeptAtTurnEnd(reasoning, showThinking)));

	const answer = turn.completed.answerText?.trim() ? turn.completed.answerText : undefined;
	if (answer) {
		entries.push({
			id: ctx.newId(),
			timestamp: turn.endedAt,
			source: 'stdout',
			text: answer,
			// What the turn ran under, frozen at send (a model change mid-stream must not relabel it).
			...(settings.model ? { turnModel: settings.model } : {}),
			...(settings.effort ? { turnEffort: settings.effort } : {}),
		});
	}

	if (turn.completed.outcome === 'crashed') {
		entries.push({
			id: ctx.newId(),
			timestamp: turn.endedAt,
			source: 'error',
			text: turn.completed.error?.message ?? describeCrash(turn.completed.exit),
			...(turn.completed.error ? { agentError: turn.completed.error } : {}),
		});
	}
	// A turn the person stopped ends on the note a local Stop writes, so every mode reads the same.
	if (turn.completed.outcome === 'interrupted') {
		entries.push({
			id: ctx.newId(),
			timestamp: turn.endedAt,
			source: 'system',
			text: TURN_CANCELED_NOTE,
		});
	}
	return entries;
}

export function createTurnRecorder(options: TurnRecorderOptions): TurnRecorder {
	const ctx: RuleContext = { ...DEFAULT_RULE_CONTEXT, ...options.context };
	const historyWriter =
		options.historyWriter ??
		createHistoryWriter({
			paths: options.paths,
			...(options.fence ? { fence: options.fence } : {}),
		});
	const statsRecorder =
		options.statsRecorder ??
		createStatsRecorder({
			paths: options.paths,
			loadSqlite: options.loadSqlite,
			...(options.fence ? { fence: options.fence } : {}),
			// The same gate the desktop's stats writers use: collected unless explicitly turned off.
			isEnabled: () => readStatsCollectionEnabled(options.paths.settingsFile),
		});

	async function recordTurn(turn: RecordedTurn): Promise<TurnRecordResult> {
		// Detach attribution before the first writer yields to settings/receipt changes.
		turn = {
			...turn,
			scope: turn.scope && { ...turn.scope },
			nativeSessionBinding: turn.nativeSessionBinding && structuredClone(turn.nativeSessionBinding),
		};
		const agent = options.repository.getAgent(turn.agentId);
		const tab = options.repository.getTab(turn.agentId, turn.tabId);
		const missing = !agent
			? `No agent ${turn.agentId}.`
			: !tab
				? `No tab ${turn.tabId}.`
				: undefined;
		if (!agent || !tab) {
			const message = missing ?? 'Nothing to record against.';
			return {
				transcript: { ok: false, error: { code: 'not-found', message, method: 'tabs.update' } },
				history: { ok: false, reason: 'not-recorded', message },
				stats: { ok: false, reason: 'failed', message },
			};
		}

		const transcript = await options.repository.appendTranscript(
			turn.agentId,
			turn.tabId,
			buildTurnTranscript(turn, ctx, tab.showThinking),
			...(turn.writeGuard ? [turn.writeGuard] : [])
		);

		// Reserve the repository mutation queue across the writers' own queues and
		// filesystem awaits. A prior CAS alone leaves a replacement race here.
		if (turn.writeGuard) {
			const guarded =
				transcript.ok && options.repository.withTabWriteGuard
					? await options.repository.withTabWriteGuard(turn.writeGuard, () =>
							recordOther(turn, transcript, agent, tab)
						)
					: { ok: false as const, error: { message: 'The original turn could not be recorded.' } };
			if (!guarded.ok) {
				const message = guarded.error.message;
				return {
					transcript: transcript.ok
						? { ok: false, error: { code: 'rejected', message, method: 'tabs.update' } }
						: transcript,
					history: { ok: false, reason: 'not-recorded', message },
					stats: { ok: false, reason: 'failed', message },
				};
			}
			return guarded.value;
		}
		return recordOther(turn, transcript, agent, tab);
	}

	async function recordOther(
		turn: RecordedTurn,
		transcript: ClientResult<void>,
		agent: AgentRecord,
		tab: AITabRecord
	): Promise<TurnRecordResult> {
		const { completed } = turn;
		// The provider the turn ran under, frozen at send: the agent may have swapped since.
		const provider = turn.assembled.settings.provider;
		const finished =
			completed.outcome === 'completed' || completed.outcome === 'completed-with-warning';
		const summary = summarizeAnswer(completed.answerText) || 'Completed successfully';
		let history: TurnRecordResult['history'];
		if (!finished) {
			history = { ok: false, reason: 'not-recorded', message: `The turn ${completed.outcome}.` };
		} else if (
			turn.nativeSessionBinding?.state === 'bound' &&
			(turn.nativeSessionBinding.provider !== provider ||
				turn.nativeSessionBinding.nativeSessionId !== completed.sessionId)
		) {
			history = {
				ok: false,
				reason: 'not-recorded',
				message: 'Native session identity mismatch.',
			};
		} else if ((turn.saveToHistory ?? tab.saveToHistory) === false) {
			history = {
				ok: false,
				reason: 'not-recorded',
				message:
					turn.saveToHistory === false
						? 'The sender chose not to save this turn to History.'
						: 'The tab does not save to History.',
			};
		} else if (options.summarize && !completed.sessionId) {
			// The desktop's rule: no provider session, no synopsis to resume, no entry.
			history = {
				ok: false,
				reason: 'not-recorded',
				message: 'The turn ran in no provider session.',
			};
		} else if (
			options.summarize &&
			!turnDidMeaningfulWork(
				turn.streamed ?? [],
				!!turn.assembled.entry.aiCommand,
				thinkingLogsRecorded(tab.showThinking as ThinkingMode | boolean | undefined)
			)
		) {
			history = {
				ok: false,
				reason: 'not-recorded',
				message: 'The turn ran no tool, so it is not summarized to History.',
			};
		} else {
			const context = completed.usage
				? estimateContextUsage(completed.usage, provider as ToolType)
				: null;
			const entry: HistoryEntry = {
				id: ctx.newId(),
				type: 'USER',
				timestamp: turn.endedAt,
				summary,
				...(completed.answerText ? { fullResponse: completed.answerText } : {}),
				...(completed.sessionId ? { agentSessionId: completed.sessionId } : {}),
				sessionName:
					tab.name || (completed.sessionId ? formatSessionId(completed.sessionId) : undefined),
				projectPath: turn.scope?.projectPath ?? agent.cwd ?? '',
				...(provider === 'grok'
					? {
							nativeSessionBinding: structuredClone(
								turn.nativeSessionBinding ?? {
									version: 1,
									state: 'unknown',
									reason: 'unobserved',
								}
							),
						}
					: {}),
				sessionId: agent.id,
				tabId: tab.id,
				...(context !== null ? { contextUsage: context } : {}),
				...(completed.usage ? { usageStats: completed.usage } : {}),
				success: true,
				elapsedTimeMs: turn.endedAt - turn.startedAt,
				...(turn.originHost ? { hostname: turn.originHost } : {}),
			};
			if (options.summarize) {
				options.summarize({
					agentId: agent.id,
					tabId: tab.id,
					settings: {
						provider,
						...(turn.assembled.settings.model ? { model: turn.assembled.settings.model } : {}),
						...(turn.assembled.settings.effort ? { effort: turn.assembled.settings.effort } : {}),
					},
					entry,
				});
				history = { ok: true, synopsis: true };
			} else {
				history = await historyWriter.append(agent.id, entry);
			}
		}

		const stats = await statsRecorder.recordQuery({
			sessionId: agent.id,
			agentType: provider,
			source: 'user',
			startTime: turn.startedAt,
			duration: turn.endedAt - turn.startedAt,
			projectPath: turn.scope?.projectPath ?? agent.cwd,
			tabId: tab.id,
			isRemote: turn.scope?.isRemote ?? sshRecordOf(agent.sessionSshRemoteConfig)?.enabled === true,
			isWorktree:
				turn.scope?.isWorktree ??
				(typeof agent.parentSessionId === 'string' && agent.parentSessionId !== ''),
			...usageStatsToTurnFields(completed.usage),
		});

		return { transcript, history, stats };
	}

	return { recordTurn };
}

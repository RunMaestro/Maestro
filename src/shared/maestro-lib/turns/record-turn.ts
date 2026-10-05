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
 * Two departures from the desktop, both on purpose:
 *
 * - **The History summary comes from the answer** (`summarizeAnswer`, the function the desktop's
 *   exit toast uses), not from a synopsis agent. The desktop spawns a second provider turn per
 *   exit to write one; the runtime does not start work nobody asked for. `fullResponse` is the
 *   answer itself.
 * - **Only the user's message, the answer, and a failure are written to the transcript.** Thinking
 *   and tool cards stream live to the client; persisting them is a richer entry model than
 *   this task owns.
 *
 * A tab whose `saveToHistory` chip is off records no History entry (as on the desktop), and an
 * interrupted or crashed turn records none either: History is the record of work that finished.
 * Usage is recorded for every turn that ran.
 */

import { readStoreDocument } from '../store/io';
import { formatSessionId } from '../store/tab-display';
import type { LogEntryRecord } from '../store/transcript';
import type { AgentRepository } from '../agents/repository';
import { DEFAULT_RULE_CONTEXT, sshRecordOf, type RuleContext } from '../agents/rules';
import type { ClientResult } from '../client/types';
import type { MaestroPaths } from '../paths/resolve';
import { estimateContextUsage } from '../parsers/usage-aggregator';
import type { CompletedTurn } from '../run/run-to-completion';
import type { DataDirVerdict } from '../runtime/data-dir-lock';
import { usageStatsToTurnFields } from '../../turnUsageLedger';
import type { HistoryEntry, ToolType } from '../../types';
import type { AssembledTurn } from './assemble';
import { createHistoryWriter, type HistoryAppendResult, type HistoryWriter } from './history';
import {
	createStatsRecorder,
	type StatsConnectionConstructor,
	type StatsRecordResult,
	type StatsRecorder,
} from './stats';
import { summarizeAnswer } from './summary';

/** The stderr kept in a failure entry when the provider named no error. */
const STDERR_TAIL_CHARS = 500;

/** One finished turn, as the runtime knows it. */
export interface RecordedTurn {
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
}

/** What happened to each record. A skipped record says why. */
export interface TurnRecordResult {
	transcript: ClientResult<void>;
	history: HistoryAppendResult | { ok: false; reason: 'not-recorded'; message: string };
	stats: StatsRecordResult;
}

export interface TurnRecorderOptions {
	paths: Pick<MaestroPaths, 'historyDir' | 'statsFile' | 'settingsFile'>;
	repository: Pick<AgentRepository, 'getAgent' | 'getTab' | 'appendTranscript'>;
	/** The host's `better-sqlite3` loader (the CLI's `loadBetterSqlite3`). It throws when the module cannot load. */
	loadSqlite: () => StatsConnectionConstructor;
	/** Is this process still the data directory's writer? Asked before the History and usage writes. */
	fence?: () => DataDirVerdict;
	/** Ids and the clock for the entries it makes. */
	context?: Partial<RuleContext>;
	/** Test seams: the writers themselves. */
	historyWriter?: HistoryWriter;
	statsRecorder?: StatsRecorder;
}

export interface TurnRecorder {
	/** Write every record of a finished turn. Never throws. */
	recordTurn(turn: RecordedTurn): Promise<TurnRecordResult>;
}

/** The text of a failure entry for a crash the provider did not classify. */
function describeCrash(exit: CompletedTurn['exit']): string {
	if (exit.spawnError) return `The agent could not be started: ${exit.spawnError.message}`;
	const stderr = exit.stderrText.trim().slice(-STDERR_TAIL_CHARS);
	const how = exit.signal
		? `was stopped by ${exit.signal}`
		: `exited with code ${exit.exitCode ?? 'unknown'}`;
	return stderr ? `The agent ${how}.\n${stderr}` : `The agent ${how}.`;
}

/**
 * The transcript entries of one turn: the message the person sent, then the answer, then a
 * failure when it crashed. Pure; ids and times come from the caller.
 */
export function buildTurnTranscript(turn: RecordedTurn, ctx: RuleContext): LogEntryRecord[] {
	const { entry, settings } = turn.assembled;
	const entries: LogEntryRecord[] = [
		{
			id: ctx.newId(),
			timestamp: turn.startedAt,
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
		},
	];

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
			isEnabled: async () => {
				const read = await readStoreDocument<Record<string, unknown>>(options.paths.settingsFile);
				return read.status !== 'ok' || read.data.statsCollectionEnabled !== false;
			},
		});

	async function recordTurn(turn: RecordedTurn): Promise<TurnRecordResult> {
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
			buildTurnTranscript(turn, ctx)
		);

		const { completed } = turn;
		const finished =
			completed.outcome === 'completed' || completed.outcome === 'completed-with-warning';
		const summary = summarizeAnswer(completed.answerText) || 'Completed successfully';
		let history: TurnRecordResult['history'];
		if (!finished) {
			history = { ok: false, reason: 'not-recorded', message: `The turn ${completed.outcome}.` };
		} else if (tab.saveToHistory === false) {
			history = { ok: false, reason: 'not-recorded', message: 'The tab does not save to History.' };
		} else {
			const context = completed.usage
				? estimateContextUsage(completed.usage, agent.toolType as ToolType)
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
				projectPath: agent.cwd ?? '',
				sessionId: agent.id,
				tabId: tab.id,
				...(context !== null ? { contextUsage: context } : {}),
				...(completed.usage ? { usageStats: completed.usage } : {}),
				success: true,
				elapsedTimeMs: turn.endedAt - turn.startedAt,
			};
			history = await historyWriter.append(agent.id, entry);
		}

		const stats = await statsRecorder.recordQuery({
			sessionId: agent.id,
			agentType: agent.toolType,
			source: 'user',
			startTime: turn.startedAt,
			duration: turn.endedAt - turn.startedAt,
			projectPath: agent.cwd,
			tabId: tab.id,
			isRemote: sshRecordOf(agent.sessionSshRemoteConfig)?.enabled === true,
			isWorktree: typeof agent.parentSessionId === 'string' && agent.parentSessionId !== '',
			...usageStatsToTurnFields(completed.usage),
		});

		return { transcript, history, stats };
	}

	return { recordTurn };
}

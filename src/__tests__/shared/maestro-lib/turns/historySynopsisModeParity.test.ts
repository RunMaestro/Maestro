// @vitest-environment jsdom
/**
 * P8: a finished turn's History entry comes from a synopsis turn in every mode, by one rule. A
 * local and an SSH tab run the desktop's exit rule (`shouldRunSynopsisOnExit()`, then
 * `turnDidMeaningfulWork()` with `thinkingLogsRecorded()`); a hosted tab's headless host runs the
 * same gate in `createTurnRecorder()` and hands the entry to its synopsis turn (`summarize`). The
 * entry is the synopsis' summary in both (`parseSynopsis()`), so the same reply reads the same.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	shouldRunSynopsisOnExit,
	turnDidMeaningfulWork,
} from '../../../../renderer/hooks/agent/internal/helpers/exitSynopsis';
import { thinkingLogsRecorded } from '../../../../renderer/hooks/agent/internal/helpers/thinkingLogs';
import {
	createTurnRecorder,
	type RecordedTurn,
	type TurnSummaryHandoff,
} from '../../../../shared/maestro-lib/turns/record-turn';
import type { HistoryWriter } from '../../../../shared/maestro-lib/turns/history';
import type { StatsRecorder } from '../../../../shared/maestro-lib/turns/stats';
import type { LogEntry } from '../../../../renderer/types';
import type { ThinkingMode } from '../../../../shared/types';
import { AGENT_MODES, createModeSession, type AgentMode } from '../../../helpers/mockSession';

const SESSION_ID = 'abcd1234-0000-4000-8000-000000000000';

interface Case {
	showThinking: ThinkingMode;
	/** The turn's streamed cards after the user's message: tool work or prose only. */
	ranTool: boolean;
	customCommand: boolean;
}

const CASES: Array<[string, Case]> = [
	[
		'a text-only turn on a tab that keeps tool cards',
		{ showThinking: 'on', ranTool: false, customCommand: false },
	],
	[
		'a tool turn on a tab that keeps tool cards',
		{ showThinking: 'sticky', ranTool: true, customCommand: false },
	],
	[
		'a text-only turn on a tab with thinking off',
		{ showThinking: 'off', ranTool: false, customCommand: false },
	],
	['a custom command', { showThinking: 'on', ranTool: false, customCommand: true }],
];

const toolCard = { id: 'tool-1', timestamp: 3, source: 'tool' as const, text: 'Read' };

/** Whether the turn is summarized to History, in one agent mode. */
async function summarized(mode: AgentMode, c: Case): Promise<boolean> {
	if (mode !== 'hosted') {
		const tab = {
			id: 'tab-1',
			agentSessionId: SESSION_ID,
			saveToHistory: true,
			showThinking: c.showThinking,
			logs: [
				{ id: 'u', timestamp: 1, source: 'user', text: 'do it' },
				...(c.ranTool ? [toolCard] : []),
				{ id: 'a', timestamp: 4, source: 'stdout', text: 'Done.' },
			] as LogEntry[],
		};
		const session = createModeSession(mode, {
			executionQueue: [],
			...(c.customCommand ? { pendingAICommandForSynopsis: '/commit' } : {}),
		});
		return (
			shouldRunSynopsisOnExit(session, tab) &&
			turnDidMeaningfulWork(tab.logs, c.customCommand, thinkingLogsRecorded(tab.showThinking))
		);
	}
	const handoffs: TurnSummaryHandoff[] = [];
	const historyWriter: HistoryWriter = {
		append: vi.fn(async () => ({ ok: true as const, file: 'unused' })),
	} as unknown as HistoryWriter;
	const statsRecorder = {
		recordQuery: async () => ({ ok: true as const, id: 'stat' }),
	} as unknown as StatsRecorder;
	const recorder = createTurnRecorder({
		paths: { historyDir: '', statsFile: '', settingsFile: '' },
		repository: {
			getAgent: () => ({ id: 'a1', toolType: 'claude-code', cwd: '/work' }) as never,
			getTab: () => ({ id: 'tab-1', saveToHistory: true, showThinking: c.showThinking }) as never,
			appendTranscript: async () => ({ ok: true, value: undefined }),
		},
		loadSqlite: () => {
			throw new Error('unused');
		},
		historyWriter,
		statsRecorder,
		summarize: (handoff) => handoffs.push(handoff),
	});
	const turn: RecordedTurn = {
		agentId: 'a1',
		tabId: 'tab-1',
		assembled: {
			entry: { text: 'do it', ...(c.customCommand ? { aiCommand: { command: '/commit' } } : {}) },
			settings: { provider: 'claude-code' },
		},
		completed: {
			outcome: 'completed',
			answerText: 'Done.',
			sessionId: SESSION_ID,
			usage: undefined,
			error: undefined,
			exit: {
				exitCode: 0,
				signal: null,
				interrupted: false,
				stderrText: '',
				stdoutText: '',
				droppedOutputBytes: 0,
			},
		},
		startedAt: 1,
		endedAt: 5,
		userEntryWritten: true,
		streamed: [
			...(c.ranTool ? [toolCard] : []),
			{ id: 'a', timestamp: 4, source: 'stdout', text: 'Done.' },
		],
	};
	await recorder.recordTurn(turn);
	// The host never writes the answer as the entry: only the synopsis turn writes it.
	expect(historyWriter.append).not.toHaveBeenCalled();
	return handoffs.length === 1;
}

describe('a turn summarized to History (P8)', () => {
	it.each(CASES)('%s: the same decision in all three modes', async (_name, c) => {
		const views = await Promise.all(AGENT_MODES.map((mode) => summarized(mode, c)));
		expect(views[1]).toBe(views[0]);
		expect(views[2]).toBe(views[0]);
		expect(views[0]).toBe(c.ranTool || c.customCommand || c.showThinking === 'off');
	});
});

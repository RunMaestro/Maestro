/**
 * What the runtime writes when a turn ends: transcript, History, usage.
 *
 * Real repository, real History writer, real temp directory. The usage recorder is a spy where
 * the question is what row it is asked to write (`stats.test.ts` covers the row itself), and
 * the real one where the question is what happens when SQLite is not there.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userData = '';

vi.mock('electron', () => ({ app: { getPath: vi.fn(() => userData) } }));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import { HistoryManager } from '../../../../main/history-manager';
import { createAgentRepository } from '../../../../shared/maestro-lib/agents/repository';
import {
	DEFAULT_TAB_DEFAULTS,
	type RuleContext,
} from '../../../../shared/maestro-lib/agents/rules';
import { createEventBus } from '../../../../shared/maestro-lib/client/event-bus';
import { resolveMaestroPaths } from '../../../../shared/maestro-lib/paths/resolve';
import type { MaestroPaths } from '../../../../shared/maestro-lib/paths/resolve';
import { transcriptOf } from '../../../../shared/maestro-lib/store/transcript';
import {
	buildTurnTranscript,
	buildUserTranscriptEntry,
	createTurnRecorder,
	type RecordedTurn,
} from '../../../../shared/maestro-lib/turns/record-turn';
import type { StatsRecorder } from '../../../../shared/maestro-lib/turns/stats';
import type { QueryEvent } from '../../../../shared/stats-types';

const confText = (doc: unknown) => JSON.stringify(doc, null, '\t');

function context(): RuleContext {
	let id = 0;
	return { newId: () => `id-${++id}`, now: () => 1_000, random: () => 0 };
}

const USAGE = {
	inputTokens: 1000,
	outputTokens: 250,
	cacheReadInputTokens: 900,
	cacheCreationInputTokens: 80,
	totalCostUsd: 0.42,
	contextWindow: 200_000,
};

const CLEAN_EXIT = {
	exitCode: 0,
	signal: null,
	interrupted: false,
	stderrText: '',
	stdoutText: '',
	droppedOutputBytes: 0,
};

function turn(overrides: Partial<RecordedTurn> = {}): RecordedTurn {
	return {
		agentId: 'a1',
		tabId: 't1',
		assembled: {
			entry: { text: 'fix the login bug' },
			settings: { provider: 'claude-code', model: 'opus', effort: 'high' },
		},
		completed: {
			outcome: 'completed',
			answerText: 'Fixed the login bug in the session handler. Tests pass.',
			sessionId: 'abcd1234-0000-4000-8000-000000000000',
			usage: USAGE,
			error: undefined,
			exit: CLEAN_EXIT,
		},
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_004_200,
		...overrides,
	};
}

describe('turn records', () => {
	let paths: MaestroPaths;
	let statsEvents: Array<Omit<QueryEvent, 'id'>>;
	let statsRecorder: StatsRecorder;

	const seed = (extraAgent: Record<string, unknown> = {}, extraTab: Record<string, unknown> = {}) =>
		fs.writeFileSync(
			paths.sessionsFile,
			confText({
				sessions: [
					{
						id: 'a1',
						name: 'Alpha',
						toolType: 'claude-code',
						cwd: '/work/a1',
						aiTabs: [{ id: 't1', name: 'Login work', logs: [], ...extraTab }],
						activeTabId: 't1',
						...extraAgent,
					},
				],
			})
		);

	async function recorder(
		options: { statsRecorder?: StatsRecorder; loadSqlite?: () => never } = {}
	) {
		const repository = createAgentRepository({
			paths,
			bus: createEventBus('[test]'),
			context: context(),
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			checkCwd: () => null,
		});
		const loaded = await repository.load();
		if (!loaded.ok) throw new Error(loaded.failure.message);
		return {
			repository,
			recorder: createTurnRecorder({
				paths,
				repository,
				loadSqlite:
					options.loadSqlite ??
					(() => {
						throw new Error('unused');
					}),
				context: context(),
				// With a loader given, the real recorder runs; otherwise the spy.
				...(options.loadSqlite ? {} : { statsRecorder }),
			}),
		};
	}

	beforeEach(() => {
		userData = fs.mkdtempSync(path.join(os.tmpdir(), 'record-turn-test-'));
		paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: userData } });
		statsEvents = [];
		statsRecorder = {
			recordQuery: async (event) => {
				statsEvents.push(event);
				return { ok: true, id: 'stat-1' };
			},
		};
		seed();
	});
	afterEach(() => {
		fs.rmSync(userData, { recursive: true, force: true });
	});

	it('appends the user message and the answer to the tab, stamped with the settings the turn ran under', async () => {
		const { recorder: records, repository } = await recorder();
		const result = await records.recordTurn(turn());
		expect(result.transcript.ok).toBe(true);
		expect(transcriptOf(repository.getTab('a1', 't1')!).map(({ id, ...rest }) => rest)).toEqual([
			{ timestamp: 1_700_000_000_000, source: 'user', text: 'fix the login bug', delivered: true },
			{
				timestamp: 1_700_000_004_200,
				source: 'stdout',
				text: 'Fixed the login bug in the session handler. Tests pass.',
				turnModel: 'opus',
				turnEffort: 'high',
			},
		]);
		// The desktop reads the same file.
		const onDisk = JSON.parse(fs.readFileSync(paths.sessionsFile, 'utf-8'));
		expect(onDisk.sessions[0].aiTabs[0].logs).toHaveLength(2);
	});

	it('records usage under the provider the turn was sent to, not the one the agent has now', async () => {
		const { recorder: records } = await recorder();
		await records.recordTurn(
			turn({
				assembled: { entry: { text: 'hi' }, settings: { provider: 'codex' } },
			})
		);
		expect(statsEvents[0]?.agentType).toBe('codex');
	});

	it('records a USER history entry the desktop reads, built from the answer', async () => {
		const { recorder: records } = await recorder();
		const result = await records.recordTurn(turn());
		expect(result.history).toMatchObject({ ok: true });
		const [entry] = await new HistoryManager().getEntries('a1');
		expect(entry).toEqual({
			id: 'id-3',
			type: 'USER',
			timestamp: 1_700_000_004_200,
			summary: 'Fixed the login bug in the session handler.',
			fullResponse: 'Fixed the login bug in the session handler. Tests pass.',
			agentSessionId: 'abcd1234-0000-4000-8000-000000000000',
			sessionName: 'Login work',
			projectPath: '/work/a1',
			sessionId: 'a1',
			tabId: 't1',
			contextUsage: 1,
			usageStats: USAGE,
			success: true,
			elapsedTimeMs: 4200,
		});
	});

	it('names an unnamed tab the way the tab strip does', async () => {
		seed({}, { name: null });
		const { recorder: records } = await recorder();
		await records.recordTurn(turn());
		const [entry] = await new HistoryManager().getEntries('a1');
		expect(entry.sessionName).toBe('ABCD1234');
	});

	it('records the turn in usage with the per-turn token deltas and the agent facts', async () => {
		seed({ parentSessionId: 'parent', sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } });
		const { recorder: records } = await recorder();
		await records.recordTurn(turn());
		expect(statsEvents).toEqual([
			{
				sessionId: 'a1',
				agentType: 'claude-code',
				source: 'user',
				startTime: 1_700_000_000_000,
				duration: 4200,
				projectPath: '/work/a1',
				tabId: 't1',
				isRemote: true,
				isWorktree: true,
				inputTokens: 1000,
				outputTokens: 250,
				cacheReadTokens: 900,
				cacheCreationTokens: 80,
				costUsd: 0.42,
			},
		]);
	});

	it('writes no History entry when the tab does not save to History, but still the transcript and usage', async () => {
		seed({}, { saveToHistory: false });
		const { recorder: records, repository } = await recorder();
		const result = await records.recordTurn(turn());
		expect(result.history).toMatchObject({ ok: false, reason: 'not-recorded' });
		expect(fs.existsSync(path.join(paths.historyDir, 'a1.jsonl'))).toBe(false);
		expect(repository.getTab('a1', 't1')?.logs).toHaveLength(2);
		expect(statsEvents).toHaveLength(1);
	});

	it('records an interrupted turn as the partial answer and usage, with no History entry', async () => {
		const { recorder: records, repository } = await recorder();
		const result = await records.recordTurn(
			turn({
				completed: {
					...turn().completed,
					outcome: 'interrupted',
					answerText: 'Looking at the handler',
					exit: { ...CLEAN_EXIT, exitCode: null, signal: 'SIGINT', interrupted: true },
				},
			})
		);
		expect(result.history).toMatchObject({ ok: false, reason: 'not-recorded' });
		expect(transcriptOf(repository.getTab('a1', 't1')!).map((e) => e.source)).toEqual([
			'user',
			'stdout',
		]);
		expect(statsEvents).toHaveLength(1);
	});

	it('adds the provider error to the transcript of a crashed turn, and no History entry', async () => {
		const { recorder: records, repository } = await recorder();
		const result = await records.recordTurn(
			turn({
				completed: {
					...turn().completed,
					outcome: 'crashed',
					answerText: undefined,
					usage: undefined,
					error: {
						type: 'auth_expired',
						message: 'Authentication failed. Sign in again.',
						recoverable: true,
						agentId: 'claude-code',
						timestamp: 1,
					},
					exit: { ...CLEAN_EXIT, exitCode: 1 },
				},
			})
		);
		expect(result.history).toMatchObject({ ok: false, reason: 'not-recorded' });
		const entries = transcriptOf(repository.getTab('a1', 't1')!);
		expect(entries.map((e) => [e.source, e.text])).toEqual([
			['user', 'fix the login bug'],
			['error', 'Authentication failed. Sign in again.'],
		]);
		// No usage reported: the columns stay NULL rather than becoming 0.
		expect(statsEvents[0]).not.toHaveProperty('inputTokens');
	});

	describe('buildTurnTranscript', () => {
		const ctx = context();

		it('words an unclassified crash from the exit facts', () => {
			const crash = (exit: Partial<typeof CLEAN_EXIT> & { spawnError?: Error }) =>
				buildTurnTranscript(
					turn({
						completed: {
							...turn().completed,
							outcome: 'crashed',
							answerText: undefined,
							exit: { ...CLEAN_EXIT, ...exit } as never,
						},
					}),
					ctx
				).at(-1)!.text;
			expect(crash({ exitCode: 2, stderrText: 'boom\n' })).toBe(
				'The agent exited with code 2.\nboom'
			);
			expect(crash({ exitCode: null, signal: 'SIGKILL' as never })).toBe(
				'The agent was stopped by SIGKILL.'
			);
			expect(crash({ spawnError: new Error('ENOENT') })).toBe(
				'The agent could not be started: ENOENT'
			);
		});

		it('carries what the composer sent: images, the read-only flag, and the command', () => {
			const [user] = buildTurnTranscript(
				turn({
					assembled: {
						settings: { provider: 'claude-code' },
						entry: {
							text: '/commit',
							images: ['maestro-image://store/a.png'],
							readOnly: true,
							aiCommand: { command: '/commit' },
						},
					},
				}),
				ctx
			);
			expect(user).toMatchObject({
				images: ['maestro-image://store/a.png'],
				readOnly: true,
				aiCommand: { command: '/commit', description: '' },
			});
		});

		it('starts at the answer when the runtime already wrote the message', () => {
			const entries = buildTurnTranscript(turn({ userEntryWritten: true }), ctx);
			expect(entries.map((e) => e.source)).toEqual(['stdout']);
		});

		it('builds the same user entry the recorder would, from the same inputs', () => {
			const sent = { text: 'fix it', readOnly: true as const };
			const entry = buildUserTranscriptEntry(sent, 42, ctx);
			expect(entry).toMatchObject({
				source: 'user',
				text: 'fix it',
				timestamp: 42,
				delivered: true,
				readOnly: true,
			});
		});

		it('leaves the pills off an answer that ran under the agent defaults, and writes no answer for an empty one', () => {
			const entries = buildTurnTranscript(
				turn({
					assembled: { entry: { text: 'hi' }, settings: { provider: 'claude-code' } },
					completed: { ...turn().completed, answerText: '  ' },
				}),
				ctx
			);
			expect(entries.map((e) => e.source)).toEqual(['user']);
			const [, answer] = buildTurnTranscript(
				turn({ assembled: { entry: { text: 'hi' }, settings: { provider: 'claude-code' } } }),
				ctx
			);
			expect(answer).not.toHaveProperty('turnModel');
			expect(answer).not.toHaveProperty('turnEffort');
		});
	});

	describe('when a record cannot be written', () => {
		it('keeps the turn, the transcript, and History when SQLite will not load, and says so once', async () => {
			fs.writeFileSync(paths.statsFile, '');
			const { recorder: records, repository } = await recorder({
				loadSqlite: () => {
					throw new Error("Maestro's database module cannot be loaded.");
				},
			});
			const result = await records.recordTurn(turn());
			expect(result.stats).toMatchObject({
				ok: false,
				reason: 'unavailable',
				message: "Maestro's database module cannot be loaded.",
			});
			expect(result.transcript.ok).toBe(true);
			expect(result.history).toMatchObject({ ok: true });
			expect(repository.getTab('a1', 't1')?.logs).toHaveLength(2);
			expect(await new HistoryManager().getEntries('a1')).toHaveLength(1);
		});

		it('still writes usage when the History file is on the legacy format', async () => {
			fs.mkdirSync(paths.historyDir, { recursive: true });
			fs.writeFileSync(path.join(paths.historyDir, 'a1.json'), JSON.stringify({ entries: [] }));
			const { recorder: records } = await recorder();
			const result = await records.recordTurn(turn());
			expect(result.history).toMatchObject({ ok: false, reason: 'legacy-format' });
			expect(result.transcript.ok).toBe(true);
			expect(statsEvents).toHaveLength(1);
		});

		it('says what is missing for an agent or tab that is gone, and writes nothing', async () => {
			const { recorder: records } = await recorder();
			const noTab = await records.recordTurn(turn({ tabId: 'gone' }));
			expect(noTab.transcript).toMatchObject({ ok: false, error: { code: 'not-found' } });
			const noAgent = await records.recordTurn(turn({ agentId: 'gone' }));
			expect(noAgent.history).toMatchObject({ ok: false, reason: 'not-recorded' });
			expect(statsEvents).toEqual([]);
			expect(fs.existsSync(paths.historyDir)).toBe(false);
		});
	});
});

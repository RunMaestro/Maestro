/**
 * What the runtime writes when a turn ends: transcript, History, usage.
 *
 * Real repository, real History writer, real temp directory. The usage recorder is a spy where
 * the question is what row it is asked to write (`stats.test.ts` covers the row itself), and
 * the real one where the question is what happens when SQLite is not there.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userData = '';

vi.mock('fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('fs/promises')>()),
}));

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
import { TURN_CANCELED_NOTE, transcriptOf } from '../../../../shared/maestro-lib/store/transcript';
import {
	buildTurnTranscript,
	buildUserTranscriptEntry,
	createTurnRecorder,
	type RecordedTurn,
	type TurnSummaryHandoff,
} from '../../../../shared/maestro-lib/turns/record-turn';
import type { StatsRecorder } from '../../../../shared/maestro-lib/turns/stats';
import type { TurnExit } from '../../../../shared/maestro-lib/run/start-turn';
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

const CLEAN_EXIT: TurnExit = {
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
		options: {
			statsRecorder?: StatsRecorder;
			loadSqlite?: () => never;
			summarize?: (handoff: TurnSummaryHandoff) => void;
		} = {}
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
				...(options.summarize ? { summarize: options.summarize } : {}),
			}),
		};
	}

	beforeEach(() => {
		const scratch = path.join(process.cwd(), 'tmp');
		fs.mkdirSync(scratch, { recursive: true });
		userData = fs.mkdtempSync(path.join(scratch, 'record-turn-test-'));
		paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: userData } });
		statsEvents = [];
		statsRecorder = {
			startAutoRun: vi.fn<StatsRecorder['startAutoRun']>(),
			recordAutoTask: vi.fn<StatsRecorder['recordAutoTask']>(),
			endAutoRun: vi.fn<StatsRecorder['endAutoRun']>(),
			recordQuery: async (event) => {
				statsEvents.push(event);
				return { ok: true, id: 'stat-1' };
			},
		};
		seed();
	});
	afterEach(() => {
		vi.restoreAllMocks();
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
				// The turn's end, as every host stamps it (R36).
				turnEnded: true,
			},
		]);
		// The desktop reads the same file.
		const onDisk = JSON.parse(fs.readFileSync(paths.sessionsFile, 'utf-8'));
		expect(onDisk.sessions[0].aiTabs[0].logs).toHaveLength(2);
	});

	// Parity R36: a turn that wrote nothing of its own still says it ended, on its message.
	it("stamps the end on the message's entry when the turn wrote nothing of its own (R36)", async () => {
		seed({}, { logs: [{ id: 'u1', timestamp: 1, source: 'user', text: 'fix the login bug' }] });
		const { recorder: records, repository } = await recorder();
		await records.recordTurn(
			turn({
				userEntryWritten: true,
				userEntryId: 'u1',
				completed: { ...turn().completed, answerText: '' },
			})
		);
		expect(transcriptOf(repository.getTab('a1', 't1')!)).toEqual([
			{ id: 'u1', timestamp: 1, source: 'user', text: 'fix the login bug', turnEnded: true },
		]);
	});

	// CodeRabbit on #2167: a stamp that could not be written is reported, never a silent success.
	it('reports the transcript failed when the end stamp on the message could not be written', async () => {
		seed({}, { logs: [{ id: 'u1', timestamp: 1, source: 'user', text: 'fix the login bug' }] });
		const { repository } = await recorder();
		const records = createTurnRecorder({
			paths,
			repository: {
				getAgent: repository.getAgent,
				getTab: repository.getTab,
				appendTranscript: repository.appendTranscript,
				replaceTranscriptEntry: async () => ({
					ok: false as const,
					error: { code: 'rejected' as const, message: 'fenced', method: 'tabs.update' as const },
				}),
			},
			loadSqlite: () => {
				throw new Error('unused');
			},
			context: context(),
			statsRecorder,
		});
		const result = await records.recordTurn(
			turn({
				userEntryWritten: true,
				userEntryId: 'u1',
				completed: { ...turn().completed, answerText: '' },
			})
		);
		expect(result.transcript).toMatchObject({ ok: false, error: { message: 'fenced' } });
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

	it.each([false, true])(
		'detaches original Grok scope and binding before recording (remote/worktree=%s)',
		async (remote) => {
			const scope = { projectPath: '/original/project', isRemote: remote, isWorktree: remote };
			const binding = {
				version: 1 as const,
				state: 'bound' as const,
				provider: 'grok' as const,
				nativeSessionId: turn().completed.sessionId!,
				accountRef: 'grok-account:original',
				host: { kind: remote ? ('ssh' as const) : ('local' as const), identity: 'original-host' },
				cwd: scope.projectPath,
			};
			const originalBinding = structuredClone(binding);
			seed({
				toolType: 'codex',
				cwd: '/changed/project',
				parentSessionId: remote ? '' : 'parent',
				sessionSshRemoteConfig: { enabled: !remote, remoteId: 'changed-host' },
			});
			const { recorder: records, repository } = await recorder();
			const append = repository.appendTranscript.bind(repository);
			vi.spyOn(repository, 'appendTranscript').mockImplementationOnce(async (...args) => {
				scope.projectPath = '/mutated/project';
				scope.isRemote = !remote;
				scope.isWorktree = !remote;
				binding.host.identity = 'mutated-host';
				binding.nativeSessionId = 'mutated-native';
				return append(...args);
			});
			const result = await records.recordTurn(
				turn({
					scope,
					nativeSessionBinding: binding,
					assembled: {
						entry: { text: 'hi' },
						settings: { provider: 'grok', model: 'original-model' },
					},
				})
			);
			expect(result.history).toMatchObject({ ok: true });
			const [entry] = await new HistoryManager().getEntries('a1');
			expect(entry).toMatchObject({
				projectPath: '/original/project',
				nativeSessionBinding: originalBinding,
			});
			expect(statsEvents[0]).toMatchObject({
				agentType: 'grok',
				projectPath: '/original/project',
				isRemote: remote,
				isWorktree: remote,
			});
			expect(transcriptOf(repository.getTab('a1', 't1')!).at(-1)).toMatchObject({
				turnModel: 'original-model',
			});
		}
	);

	it('rejects an old transcript queued behind a successor without changing prior History or usage', async () => {
		seed(
			{ toolType: 'grok' },
			{
				agentSessionId: turn().completed.sessionId,
				runtimeTurnId: 'original',
				usageStats: USAGE,
			}
		);
		const { recorder: records, repository } = await recorder();
		const original = turn({ assembled: { entry: { text: 'hi' }, settings: { provider: 'grok' } } });
		await records.recordTurn(original);
		const historyFile = path.join(paths.historyDir, 'a1.jsonl');
		const historyBefore = fs.readFileSync(historyFile, 'utf-8');
		const statsBefore = structuredClone(statsEvents);
		const logsBefore = structuredClone(repository.getTab('a1', 't1')!.logs);
		const incarnation = repository.captureTabIncarnation('a1', 't1');
		const writeGuard = () =>
			incarnation() && repository.getTab('a1', 't1')?.runtimeTurnId === 'original';
		const successorEntry = buildUserTranscriptEntry({ text: 'successor' }, 2_000, context());
		// Both calls enter with the original owner; the actual queued mutation sees the successor.
		const successor = repository.beginTurn('a1', 't1', {
			turnId: 'successor',
			provider: 'grok',
			consumedMergedContext: false,
			userEntry: successorEntry,
		});
		expect(writeGuard()).toBe(true);
		const recording = records.recordTurn({ ...original, writeGuard });
		expect((await successor).ok).toBe(true);
		const result = await recording;
		expect(result.transcript).toMatchObject({ ok: false, error: { code: 'rejected' } });
		expect(result.history).toMatchObject({ ok: false, reason: 'not-recorded' });
		expect(result.stats).toMatchObject({ ok: false });
		expect(fs.readFileSync(historyFile, 'utf-8')).toBe(historyBefore);
		expect(statsEvents).toEqual(statsBefore);
		const stored = JSON.parse(fs.readFileSync(paths.sessionsFile, 'utf-8')).sessions[0].aiTabs[0];
		expect(stored).toMatchObject({
			runtimeTurnId: 'successor',
			agentSessionId: original.completed.sessionId,
			usageStats: USAGE,
		});
		expect(stored.logs).toEqual([...logsBefore!, successorEntry]);
	});

	it('holds a successor outside the real History append and keeps the original scope through stats', async () => {
		seed(
			{ toolType: 'grok' },
			{
				agentSessionId: turn().completed.sessionId,
				runtimeTurnId: 'original',
			}
		);
		const { recorder: records, repository } = await recorder();
		const incarnation = repository.captureTabIncarnation('a1', 't1');
		const writeGuard = () =>
			incarnation() && repository.getTab('a1', 't1')?.runtimeTurnId === 'original';
		expect(
			(
				await repository.updateAgent('a1', {
					provider: 'codex',
					cwd: '/changed/project',
					env: { GROK_HOME: '/changed/account' },
				})
			).ok
		).toBe(true);
		const recordQuery = statsRecorder.recordQuery;
		statsRecorder.recordQuery = async (event) => {
			// The ownership reservation must still cover the actual usage mutation.
			expect(writeGuard()).toBe(true);
			return recordQuery(event);
		};
		const blocked = Promise.withResolvers<void>();
		const writing = Promise.withResolvers<void>();
		const append = fsp.appendFile;
		vi.spyOn(fsp, 'appendFile').mockImplementationOnce(async (...args) => {
			writing.resolve();
			await blocked.promise;
			return append(...args);
		});
		const recording = records.recordTurn(
			turn({
				writeGuard,
				scope: { projectPath: '/original/project', isRemote: true, isWorktree: true },
				assembled: { entry: { text: 'hi' }, settings: { provider: 'grok' } },
			})
		);
		await writing.promise;
		let successorCommitted = false;
		const successor = repository
			.beginTurn('a1', 't1', {
				turnId: 'successor',
				provider: 'codex',
				consumedMergedContext: false,
				userEntry: buildUserTranscriptEntry({ text: 'successor' }, 2_000, context()),
			})
			.then((result) => {
				successorCommitted = true;
				return result;
			});
		try {
			await Promise.resolve();
			expect(successorCommitted).toBe(false);
			expect(repository.getTab('a1', 't1')?.runtimeTurnId).toBe('original');
			expect(statsEvents).toEqual([]);
		} finally {
			blocked.resolve();
		}
		expect((await recording).history.ok).toBe(true);
		expect((await successor).ok).toBe(true);
		const [entry] = await new HistoryManager().getEntries('a1');
		expect(entry).toMatchObject({
			agentSessionId: turn().completed.sessionId,
			projectPath: '/original/project',
			usageStats: USAGE,
		});
		expect(statsEvents).toEqual([
			expect.objectContaining({
				agentType: 'grok',
				projectPath: '/original/project',
				isRemote: true,
				isWorktree: true,
			}),
		]);
		const stored = JSON.parse(fs.readFileSync(paths.sessionsFile, 'utf-8')).sessions[0].aiTabs[0];
		expect(stored.runtimeTurnId).toBe('successor');
		expect(stored.providerSessions.grok.agentSessionId).toBe(turn().completed.sessionId);
		expect(stored.logs.map((entry: { text: string }) => entry.text)).toEqual([
			'hi',
			turn().completed.answerText,
			'successor',
		]);
	});

	it('records unobserved Grok provenance without borrowing the current account or host', async () => {
		seed({
			toolType: 'grok',
			customEnvVars: { GROK_HOME: '/new/account' },
			sessionSshRemoteConfig: { enabled: true, remoteId: 'new-host' },
		});
		const { recorder: records } = await recorder();
		await records.recordTurn(
			turn({
				assembled: { entry: { text: 'hi' }, settings: { provider: 'grok' } },
			})
		);
		const [entry] = await new HistoryManager().getEntries('a1');
		expect(entry.nativeSessionBinding).toEqual({
			version: 1,
			state: 'unknown',
			reason: 'unobserved',
		});
	});

	it.each([
		['completed', 'different-native', 'Native session identity mismatch.'],
		['completed', undefined, 'Native session identity mismatch.'],
		['crashed', undefined, 'The turn crashed.'],
		['interrupted', 'original-native', 'The turn interrupted.'],
	] as const)(
		'retains Grok History and resume scope after %s with terminal ID %s',
		async (outcome, sessionId, message) => {
			const binding = {
				version: 1 as const,
				state: 'bound' as const,
				provider: 'grok' as const,
				nativeSessionId: 'original-native',
				accountRef: 'grok-account:original',
				host: { kind: 'ssh' as const, identity: 'original-endpoint' },
				cwd: '/original/project',
			};
			seed(
				{ toolType: 'grok' },
				{
					agentSessionId: binding.nativeSessionId,
					nativeSessionBinding: binding,
					usageStats: USAGE,
				}
			);
			const { recorder: records, repository } = await recorder();
			const original = turn({
				assembled: { entry: { text: 'original request' }, settings: { provider: 'grok' } },
				completed: { ...turn().completed, sessionId: binding.nativeSessionId },
				nativeSessionBinding: binding,
				scope: { projectPath: binding.cwd, isRemote: true, isWorktree: false },
			});
			expect((await records.recordTurn(original)).history.ok).toBe(true);
			const historyFile = path.join(paths.historyDir, 'a1.jsonl');
			const historyBefore = fs.readFileSync(historyFile, 'utf-8');
			const logsBefore = structuredClone(repository.getTab('a1', 't1')!.logs);
			const statsBefore = structuredClone(statsEvents);
			const result = await records.recordTurn({
				...original,
				assembled: { entry: { text: 'resume request' }, settings: { provider: 'grok' } },
				completed: {
					...original.completed,
					outcome,
					sessionId,
					answerText: 'Partial resume output',
					exit: {
						...CLEAN_EXIT,
						interrupted: outcome === 'interrupted',
						exitCode: outcome === 'crashed' ? 1 : 0,
					},
				},
			});
			expect(result.history).toEqual({ ok: false, reason: 'not-recorded', message });
			expect(result.transcript.ok).toBe(true);
			expect(fs.readFileSync(historyFile, 'utf-8')).toBe(historyBefore);
			expect(statsEvents.slice(0, statsBefore.length)).toEqual(statsBefore);
			// Partial output/spend is retained, but cannot rewrite the resumable identity or prior usage.
			expect(statsEvents).toHaveLength(statsBefore.length + 1);
			const { repository: reloaded } = await recorder();
			const tab = reloaded.getTab('a1', 't1')!;
			expect(tab).toMatchObject({
				agentSessionId: binding.nativeSessionId,
				nativeSessionBinding: binding,
				usageStats: USAGE,
			});
			expect(tab.logs?.slice(0, logsBefore!.length)).toEqual(logsBefore);
			expect(transcriptOf(tab).some((entry) => entry.text === 'Partial resume output')).toBe(true);
			const [history] = await new HistoryManager().getEntries('a1');
			expect(history).toMatchObject({ nativeSessionBinding: binding, usageStats: USAGE });
		}
	);

	it('keeps colliding Grok native IDs scoped to each tab and account through History reload', async () => {
		const tabs = ['t1', 't2'].map((id) => ({
			id,
			name: id,
			logs: [],
			agentSessionId: 'colliding-native',
			nativeSessionBinding: {
				version: 1 as const,
				state: 'bound' as const,
				provider: 'grok' as const,
				nativeSessionId: 'colliding-native',
				accountRef: `grok-account:${id}`,
				host: { kind: 'ssh' as const, identity: `endpoint-${id}` },
				cwd: `/remote/${id}`,
			},
		}));
		seed({ toolType: 'grok', aiTabs: tabs, activeTabId: 't2' });
		const { recorder: records } = await recorder();
		const results = await Promise.all(
			tabs.map((tab) =>
				records.recordTurn(
					turn({
						tabId: tab.id,
						assembled: { entry: { text: `request-${tab.id}` }, settings: { provider: 'grok' } },
						completed: {
							...turn().completed,
							sessionId: tab.agentSessionId,
							answerText: `answer-${tab.id}`,
						},
						nativeSessionBinding: tab.nativeSessionBinding,
						scope: { projectPath: tab.nativeSessionBinding.cwd, isRemote: true, isWorktree: false },
					})
				)
			)
		);
		expect(results.every((result) => result.history.ok && result.transcript.ok)).toBe(true);
		const histories = await new HistoryManager().getEntries('a1');
		expect(histories).toHaveLength(2);
		const { repository: reloaded } = await recorder();
		for (const tab of tabs) {
			expect(histories.find((entry) => entry.tabId === tab.id)).toMatchObject({
				agentSessionId: 'colliding-native',
				nativeSessionBinding: tab.nativeSessionBinding,
				projectPath: tab.nativeSessionBinding.cwd,
				fullResponse: `answer-${tab.id}`,
			});
			const stored = reloaded.getTab('a1', tab.id)!;
			expect(stored.nativeSessionBinding).toEqual(tab.nativeSessionBinding);
			expect(stored.agentSessionId).toBe('colliding-native');
			expect(transcriptOf(stored).map((entry) => entry.text)).toEqual([
				`request-${tab.id}`,
				`answer-${tab.id}`,
			]);
			expect(statsEvents.filter((entry) => entry.tabId === tab.id)).toEqual([
				expect.objectContaining({
					agentType: 'grok',
					projectPath: tab.nativeSessionBinding.cwd,
					isRemote: true,
				}),
			]);
		}
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

	it('stamps the History entry with the machine the turn was sent from', async () => {
		const { recorder: records } = await recorder();
		await records.recordTurn(turn({ originHost: 'laptop.local' }));
		const [stamped] = await new HistoryManager().getEntries('a1');
		expect(stamped.hostname).toBe('laptop.local');
	});

	it('leaves the hostname off when the turn names no origin', async () => {
		const { recorder: records } = await recorder();
		await records.recordTurn(turn());
		const [entry] = await new HistoryManager().getEntries('a1');
		expect(entry).not.toHaveProperty('hostname');
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

	it("lets the sender's own save-to-History chip decide in place of the tab's", async () => {
		seed({}, { saveToHistory: false });
		const { recorder: kept } = await recorder();
		const saved = await kept.recordTurn(turn({ saveToHistory: true }));
		expect(saved.history).toMatchObject({ ok: true });
		expect(await new HistoryManager().getEntries('a1')).toHaveLength(1);
	});

	it('writes no History entry when the sender turned it off, though the tab saves', async () => {
		const { recorder: records, repository } = await recorder();
		const result = await records.recordTurn(turn({ saveToHistory: false }));
		expect(result.history).toMatchObject({
			ok: false,
			reason: 'not-recorded',
			message: 'The sender chose not to save this turn to History.',
		});
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
		// It ends on the note a local Stop writes, so a hosted tab reads the same.
		expect(transcriptOf(repository.getTab('a1', 't1')!).map((e) => [e.source, e.text])).toEqual([
			['user', 'fix the login bug'],
			['stdout', expect.any(String)],
			['system', TURN_CANCELED_NOTE],
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
		// The structured error is kept on the entry, as a local error entry keeps it.
		expect(entries[1].agentError).toMatchObject({ type: 'auth_expired', recoverable: true });
		// No usage reported: the columns stay NULL rather than becoming 0.
		expect(statsEvents[0]).not.toHaveProperty('inputTokens');
	});

	describe('buildTurnTranscript', () => {
		const ctx = context();

		it('ends a stopped turn on the note a local Stop writes, after its partial answer', () => {
			const entries = buildTurnTranscript(
				turn({
					completed: {
						...turn().completed,
						outcome: 'interrupted',
						answerText: 'Partial answer',
						exit: { ...CLEAN_EXIT, interrupted: true },
					},
				}),
				ctx
			);
			expect(entries.map((e) => [e.source, e.text])).toEqual([
				['user', 'fix the login bug'],
				['stdout', 'Partial answer'],
				['system', TURN_CANCELED_NOTE],
			]);
			expect(TURN_CANCELED_NOTE).toBe('Canceled by user');
		});

		it('words an unclassified crash from the exit facts', () => {
			const crash = (exit: Partial<TurnExit>) =>
				buildTurnTranscript(
					turn({
						completed: {
							...turn().completed,
							outcome: 'crashed',
							answerText: undefined,
							exit: { ...CLEAN_EXIT, ...exit },
						},
					}),
					ctx
				).at(-1)!.text;
			expect(crash({ exitCode: 2, stderrText: 'boom\n' })).toBe(
				'The agent exited with code 2.\nboom'
			);
			expect(crash({ exitCode: null, signal: 'SIGKILL' })).toBe(
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

		it.each([
			['sticky', ['user', 'thinking', 'tool', 'stdout']],
			['on', ['user', 'stdout']],
			['off', ['user', 'stdout']],
			[undefined, ['user', 'stdout']],
		])(
			'writes what a %s tab keeps of the streamed thinking and tool cards (P7)',
			(mode, sources) => {
				const streamed = [
					{ id: 's1', timestamp: 2, source: 'thinking' as const, text: 'Plan it.' },
					{
						id: 'tool-1',
						timestamp: 3,
						source: 'tool' as const,
						text: 'Read',
						metadata: { toolState: { status: 'completed' as const, output: 'x'.repeat(10_000) } },
					},
					{ id: 's2', timestamp: 4, source: 'stdout' as const, text: 'streamed answer' },
				];
				const entries = buildTurnTranscript(turn({ streamed }), ctx, mode);
				expect(entries.map((e) => e.source)).toEqual(sources);
				if (mode === 'sticky') {
					// The tool card is capped as a saved tab's is; the answer is the result, written once.
					const output = entries[2].metadata?.toolState?.output as string;
					expect(output.length).toBeLessThan(10_000);
					expect(entries.filter((e) => e.source === 'stdout')).toHaveLength(1);
				}
			}
		);

		it('starts at the answer when the runtime already wrote the message', () => {
			const entries = buildTurnTranscript(turn({ userEntryWritten: true }), ctx);
			expect(entries.map((e) => e.source)).toEqual(['stdout']);
		});

		it.each([
			['answered', {}, 'stdout'],
			['crashed', { outcome: 'crashed' as const, answerText: '' }, 'error'],
			['stopped', { outcome: 'interrupted' as const, answerText: '' }, 'system'],
		])("stamps the turn's end on its last entry when it %s (R36)", (_how, completed, last) => {
			const entries = buildTurnTranscript(
				turn({ userEntryWritten: true, completed: { ...turn().completed, ...completed } }),
				ctx
			);
			expect(entries.at(-1)).toMatchObject({ source: last, turnEnded: true });
			expect(entries.slice(0, -1).some((entry) => entry.turnEnded)).toBe(false);
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

	// P8: with `summarize` (a host's runtime), a finished turn's History entry comes from a synopsis
	// turn, by the desktop's exit rule: the turn ran a tool (or its tool cards are not kept, or it
	// was a custom command) in a provider session.
	describe('History from a synopsis turn (P8)', () => {
		const tool = { id: 'tool-1', timestamp: 3, source: 'tool' as const, text: 'Read' };

		it("hands the entry to summarize with the turn's provider, model and effort, and writes none", async () => {
			const handoffs: TurnSummaryHandoff[] = [];
			const { recorder: records } = await recorder({ summarize: (h) => handoffs.push(h) });
			const result = await records.recordTurn(turn({ streamed: [tool] }));
			expect(result.history).toEqual({ ok: true, synopsis: true });
			expect(await new HistoryManager().getEntries('a1')).toEqual([]);
			expect(handoffs).toHaveLength(1);
			expect(handoffs[0].settings).toEqual({
				provider: 'claude-code',
				model: 'opus',
				effort: 'high',
			});
			expect(handoffs[0].entry).toMatchObject({
				type: 'USER',
				agentSessionId: 'abcd1234-0000-4000-8000-000000000000',
				sessionId: 'a1',
				tabId: 't1',
				elapsedTimeMs: 4_200,
				success: true,
			});
			// Usage is still recorded for the turn itself.
			expect(statsEvents).toHaveLength(1);
		});

		it.each([
			['a tab that keeps tool cards, after a text-only turn', 'on', [], undefined, false],
			['a tab that keeps tool cards, after a tool turn', 'on', [tool], undefined, true],
			['a tab with thinking off, whose tool cards are not kept', 'off', [], undefined, true],
			['a custom command, whatever it ran', 'on', [], { command: '/commit' }, true],
		] as const)('%s: summarized=%s', async (_name, showThinking, streamed, aiCommand, handed) => {
			seed({}, { showThinking });
			const summarize = vi.fn();
			const { recorder: records } = await recorder({ summarize });
			const result = await records.recordTurn(
				turn({
					streamed: [...streamed],
					assembled: {
						entry: { text: 'do it', ...(aiCommand ? { aiCommand } : {}) },
						settings: { provider: 'claude-code' },
					},
				})
			);
			expect(summarize).toHaveBeenCalledTimes(handed ? 1 : 0);
			expect(result.history).toMatchObject(handed ? { ok: true } : { reason: 'not-recorded' });
		});

		it('summarizes a tool turn whose cards the host did not fold (P12)', async () => {
			seed({}, { showThinking: 'on' });
			const summarize = vi.fn();
			const { recorder: records } = await recorder({ summarize });
			const result = await records.recordTurn(turn({ ranTool: true }));
			expect(summarize).toHaveBeenCalledTimes(1);
			expect(result.history).toMatchObject({ ok: true });
		});

		it('summarizes a tool turn whose thinking was folded and whose tool was not (review)', async () => {
			seed({}, { showThinking: 'on' });
			const summarize = vi.fn();
			const { recorder: records } = await recorder({ summarize });
			const thought = { id: 'th1', timestamp: 1, source: 'thinking', text: 'Plan it.' } as const;
			await records.recordTurn(turn({ streamed: [thought], ranTool: true }));
			expect(summarize).toHaveBeenCalledTimes(1);
		});

		it('summarizes no turn that ran in no provider session, as the desktop does not', async () => {
			const summarize = vi.fn();
			const { recorder: records } = await recorder({ summarize });
			const result = await records.recordTurn(
				turn({ streamed: [tool], completed: { ...turn().completed, sessionId: undefined } })
			);
			expect(summarize).not.toHaveBeenCalled();
			expect(result.history).toMatchObject({ ok: false, reason: 'not-recorded' });
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

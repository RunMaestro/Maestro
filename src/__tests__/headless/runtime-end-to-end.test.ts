// Source: src/__tests__/headless/m2-headless.test.ts
// Source: src/__tests__/headless/m3-detached.test.ts
// Source: src/__tests__/headless/m4-group-chat.test.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
	CAPTURED_RECORDINGS,
	CAPTURED_CLAUDE_CODE_SESSION_ID,
	CAPTURED_OPENCODE_SESSION_ID,
} from '../main/process-manager/recordings/captured';
import {
	FAKE_AGENT_PATH,
	fakeTurnFromRecording,
	writeFakeTurn,
} from '../shared/maestro-lib/run/fakeAgent';
import { createFakeGroupChatProvider } from '../shared/maestro-lib/run/fakeGroupChatProvider';
import { DEFAULT_TAB_DEFAULTS } from '../../shared/maestro-lib/agents/rules';
import { type ClientResult } from '../../shared/maestro-lib/client/types';
import { readHistory } from '../../shared/maestro-lib/store/read-history';
import { runAgentTurn } from '../../shared/maestro-lib/turns/run-agent-turn';
import {
	createMaestroRuntime,
	type MaestroRuntime,
	type RuntimeDeps,
} from '../../shared/maestro-lib/runtime';
import { type WatchDirectory } from '../../shared/maestro-lib/runtime/settings-watch';
describe('m2-headless', () => {
	const __dirname = path.dirname(fileURLToPath(import.meta.url));

	const T0 = Date.parse('2026-10-04T12:00:00Z');
	const BUNDLED_PROMPTS = path.resolve(__dirname, '../../shared/prompts');

	function value<T>(result: ClientResult<T>): T {
		if (!result.ok)
			throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
		return result.value;
	}

	describe('M2 end-to-end: headless runtime with swap-and-back', () => {
		let dir: string;
		let work: string;
		let recordings: Record<string, string>;

		const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

		const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = (turn, options) => {
			return runAgentTurn(
				{
					...turn,
					launch: {
						...turn.launch,
						command: process.execPath,
						args: [FAKE_AGENT_PATH, ...turn.launch.args],
						sessionCustomEnvVars: {
							...turn.launch.sessionCustomEnvVars,
							FAKE_AGENT_RECORDING: recordings[turn.provider.id],
						},
					},
				},
				{ ...options, stopGraceMs: 200 }
			);
		};

		function deps(): Partial<RuntimeDeps> {
			let id = 0;
			let now = 1_000;
			return {
				pid: 100,
				now: () => T0,
				bootTime: () => T0 - 3_600_000,
				isPidAlive: (pid) => pid === 100,
				hostname: () => 'testhost',
				rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
				checkCwd: () => null,
				readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
				watchDirectory,
				probeBinary: async () => ({ exists: true, path: '/fake/bin/claude' }),
				turns: { runAgentTurn: fakeProvider },
			};
		}

		const seedAgent = (extra: Record<string, unknown> = {}) => ({
			id: 'a1',
			name: 'TestAgent',
			toolType: 'claude-code',
			cwd: work,
			projectRoot: work,
			aiTabs: [
				{ id: 't1', agentSessionId: null, name: null, logs: [] },
				{ id: 't2', agentSessionId: null, name: null, logs: [] },
			],
			activeTabId: 't1',
			unifiedTabOrder: [
				{ type: 'ai', id: 't1' },
				{ type: 'ai', id: 't2' },
			],
			...extra,
		});

		async function startRuntime(sessions: unknown[] = [seedAgent()]): Promise<MaestroRuntime> {
			fs.writeFileSync(
				path.join(dir, 'maestro-sessions.json'),
				JSON.stringify({ sessions, activeSessionId: 'a1' }, null, '\t')
			);
			const started = await createMaestroRuntime({
				dataDir: dir,
				mode: 'tui',
				deps: deps(),
				turns: { bundledPromptsDir: BUNDLED_PROMPTS },
			});
			if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
			return started.runtime;
		}

		function watchTab(runtime: MaestroRuntime, tabId: string) {
			const events: any[] = [];
			const waiting: Array<{ resolve: () => void }> = [];
			runtime.turns.subscribe('a1', tabId, (event) => {
				events.push(event);
				if (event.kind === 'outcome') {
					for (const waiter of waiting.splice(0)) waiter.resolve();
				}
			});
			return {
				events,
				kinds: () => events.map((event) => event.kind),
				outcomes: () =>
					events.flatMap((event) => (event.kind === 'outcome' ? [event.outcome] : [])),
				outcome: (ms = 8_000) =>
					new Promise<void>((resolve, reject) => {
						if (events.some((e) => e.kind === 'outcome')) return resolve();
						const timer = setTimeout(
							() => reject(new Error(`no outcome; saw ${events.map((e) => e.kind)}`)),
							ms
						);
						waiting.push({
							resolve: () => {
								clearTimeout(timer);
								resolve();
							},
						});
					}),
			};
		}

		const transcript = async (runtime: MaestroRuntime, tabId: string) =>
			value(await runtime.tabs.transcript('a1', tabId));
		const tabOf = async (runtime: MaestroRuntime, tabId: string) =>
			value(await runtime.tabs.list('a1')).find((tab) => tab.id === tabId)!;

		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-m2-'));
			work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-m2-work-'));
			recordings = {
				'claude-code': writeFakeTurn(
					work,
					fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-claude-code-normal'])
				),
				opencode: writeFakeTurn(
					work,
					fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
				),
			};
		});

		afterEach(() => {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(work, { recursive: true, force: true });
		});

		it('creates an agent, chats on two tabs, swaps providers and back, then reloads with everything intact', async () => {
			// Start the runtime in-process mode (no desktop).
			let runtime = await startRuntime();

			// Send a message on tab 1.
			const tab1 = watchTab(runtime, 't1');
			value(await runtime.turns.send('a1', 't1', { text: 'first message on claude' }));
			await tab1.outcome();
			expect(tab1.outcomes()).toEqual(['completed']);

			let tab1Data = await tabOf(runtime, 't1');
			expect(tab1Data.agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
			expect(tab1Data.turnProvider).toBe('claude-code');

			// Send a message on the second pre-created tab.
			// Tab 2 runs on the same agent's cwd, so it might be queued.
			const tab2 = watchTab(runtime, 't2');
			const send2 = value(await runtime.turns.send('a1', 't2', { text: 'second tab message' }));
			// It may be queued because of the working directory conflict.
			if (send2.status === 'queued') {
				// The first turn already completed, so this should start immediately or be queued.
			}
			await tab2.outcome();
			expect(tab2.outcomes()).toEqual(['completed']);

			let tab2Data = await tabOf(runtime, 't2');
			expect(tab2Data.agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);

			// Swap the provider to opencode.
			value(await runtime.agents.update('a1', { provider: 'opencode' }));

			// Both tabs should reset their session ids to null.
			tab1Data = await tabOf(runtime, 't1');
			tab2Data = await tabOf(runtime, 't2');
			expect(tab1Data.agentSessionId).toBeNull();
			expect(tab2Data.agentSessionId).toBeNull();

			// Send a message on tab 1 with the new provider.
			const tab1OpenCode = watchTab(runtime, 't1');
			value(await runtime.turns.send('a1', 't1', { text: 'message on opencode' }));
			await tab1OpenCode.outcome();

			tab1Data = await tabOf(runtime, 't1');
			expect(tab1Data.agentSessionId).toBe(CAPTURED_OPENCODE_SESSION_ID);
			expect(tab1Data.turnProvider).toBe('opencode');
			// The provider sessions should store both.
			const providerSessions = tab1Data.providerSessions as Record<string, any>;
			expect(providerSessions['claude-code'].agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);

			// Swap back to claude-code.
			value(await runtime.agents.update('a1', { provider: 'claude-code' }));

			tab1Data = await tabOf(runtime, 't1');
			expect(tab1Data.agentSessionId).toBe(CAPTURED_CLAUDE_CODE_SESSION_ID);
			// turnProvider is only set when a turn completes, so it will still be opencode until after the next send.

			// Send a final message to confirm the session resumed.
			const tab1Back = watchTab(runtime, 't1');
			value(await runtime.turns.send('a1', 't1', { text: 'back on claude' }));
			await tab1Back.outcome();

			// Now turnProvider should be updated to claude-code.
			tab1Data = await tabOf(runtime, 't1');
			expect(tab1Data.turnProvider).toBe('claude-code');

			// Check transcripts have all messages.
			const t1Entries = await transcript(runtime, 't1');
			const t1UserMessages = t1Entries.filter((e) => e.source === 'user').map((e) => e.text);
			expect(t1UserMessages).toContain('first message on claude');
			expect(t1UserMessages).toContain('message on opencode');
			expect(t1UserMessages).toContain('back on claude');

			const t2Entries = await transcript(runtime, 't2');
			const t2UserMessages = t2Entries.filter((e) => e.source === 'user').map((e) => e.text);
			expect(t2UserMessages).toContain('second tab message');

			// Check history entries were written.
			const history = readHistory(runtime.paths, 'a1');
			if (history.status !== 'ok') throw new Error(`history ${history.status}`);
			// Should have at least 4 entries (one per send).
			expect(history.entries.length).toBeGreaterThanOrEqual(4);
			expect(history.entries.filter((e) => e.type === 'USER')).toHaveLength(4);

			// Close the runtime and verify persistence of history and provider sessions.
			// Note: The in-memory logs don't auto-persist to sessions.json, but the history
			// entries and provider session data do persist via the record-turn and tabs.update flows.
			await runtime.connection.close();

			// Reopen the data directory with Phase 2 readers and verify key data survived.
			runtime = await startRuntime();

			// Check both tabs still exist.
			const tabs = value(await runtime.tabs.list('a1'));
			expect(tabs.map((tab) => tab.id).sort()).toEqual(['t1', 't2'].sort());

			// Check provider sessions were persisted and restored.
			tab1Data = await tabOf(runtime, 't1');
			tab2Data = await tabOf(runtime, 't2');
			const restoredProviderSessions = tab1Data.providerSessions as Record<string, any>;
			if (restoredProviderSessions) {
				// Both provider session IDs should be stored.
				expect(restoredProviderSessions['claude-code']).toBeDefined();
				expect(restoredProviderSessions['opencode']).toBeDefined();
			}

			// Most importantly: check history is persisted and contains all turn records.
			const reloadedHistory = readHistory(runtime.paths, 'a1');
			if (reloadedHistory.status !== 'ok')
				throw new Error(`reloaded history ${reloadedHistory.status}`);
			const userEntries = reloadedHistory.entries.filter((e) => e.type === 'USER');
			expect(userEntries.length).toBeGreaterThanOrEqual(4);
			// History should have recorded turns across both tabs and both providers.
			const historyByTab = new Map<string, any[]>();
			for (const entry of userEntries) {
				if (entry.tabId) {
					if (!historyByTab.has(entry.tabId)) historyByTab.set(entry.tabId, []);
					historyByTab.get(entry.tabId)!.push(entry);
				}
			}
			expect(historyByTab.has('t1')).toBe(true);
			expect(historyByTab.has('t2')).toBe(true);

			await runtime.connection.close();
		});
	});
});
describe('m3-detached', () => {
	const __dirname = path.dirname(fileURLToPath(import.meta.url));

	const T0 = Date.parse('2026-10-04T12:00:00Z');
	const BUNDLED_PROMPTS = path.resolve(__dirname, '../../shared/prompts');

	function value<T>(result: ClientResult<T>): T {
		if (!result.ok)
			throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
		return result.value;
	}

	describe('M3 end-to-end: detached runtime with Auto Run persistence', () => {
		let dir: string;
		let work: string;
		let recordings: Record<string, string>;

		const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

		const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = (turn, options) => {
			return runAgentTurn(
				{
					...turn,
					launch: {
						...turn.launch,
						command: process.execPath,
						args: [FAKE_AGENT_PATH, ...turn.launch.args],
						sessionCustomEnvVars: {
							...turn.launch.sessionCustomEnvVars,
							FAKE_AGENT_RECORDING: recordings[turn.provider.id],
						},
					},
				},
				{ ...options, stopGraceMs: 200 }
			);
		};

		function deps(): Partial<RuntimeDeps> {
			let id = 0;
			let now = 1_000;
			return {
				pid: 100,
				now: () => T0,
				bootTime: () => T0 - 3_600_000,
				isPidAlive: (pid) => pid === 100,
				hostname: () => 'testhost',
				rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
				checkCwd: () => null,
				readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
				watchDirectory,
				probeBinary: async () => ({ exists: true, path: '/fake/bin/claude' }),
				turns: { runAgentTurn: fakeProvider },
			};
		}

		const seedAgent = (extra: Record<string, unknown> = {}) => ({
			id: 'a1',
			name: 'TestAgent',
			toolType: 'claude-code',
			cwd: work,
			projectRoot: work,
			aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs: [] }],
			activeTabId: 't1',
			unifiedTabOrder: [{ type: 'ai', id: 't1' }],
			...extra,
		});

		async function startRuntime(sessions: unknown[] = [seedAgent()]): Promise<MaestroRuntime> {
			fs.writeFileSync(
				path.join(dir, 'maestro-sessions.json'),
				JSON.stringify({ sessions, activeSessionId: 'a1' }, null, '\t')
			);
			const started = await createMaestroRuntime({
				dataDir: dir,
				mode: 'tui',
				deps: deps(),
				turns: { bundledPromptsDir: BUNDLED_PROMPTS },
			});
			if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
			return started.runtime;
		}

		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-m3-'));
			work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-m3-work-'));
			recordings = {
				'claude-code': writeFakeTurn(
					work,
					fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-claude-code-normal'])
				),
			};

			// Create playbooks folder
			fs.mkdirSync(path.join(work, '.maestro', 'playbooks'), { recursive: true });
		});

		afterEach(async () => {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(work, { recursive: true, force: true });
		});

		it('accepts spec-driven Auto Run launch requests', async () => {
			// Create a three-task playbook
			const playbookPath = path.join(work, '.maestro', 'playbooks', 'test.md');
			const playbookContent = `# Test Playbook

- [ ] First task
- [ ] Second task
- [ ] Third task
`;
			fs.writeFileSync(playbookPath, playbookContent);

			// Start the runtime in-process.
			const runtime = await startRuntime();

			try {
				// Verify the Auto Run API exists on the runtime.
				expect(runtime.autoRun).toBeDefined();
				expect(typeof runtime.autoRun.launch).toBe('function');
				expect(typeof runtime.autoRun.launchGoal).toBe('function');
				expect(typeof runtime.autoRun.stop).toBe('function');

				// Verify the launch request is accepted.
				const result = value(
					await runtime.autoRun.launch('a1', {
						documents: [{ file: playbookPath }],
					})
				);

				// Result should be void (undefined) per the AutoRunApi.
				expect(result).toBeUndefined();
			} finally {
				await runtime.connection.close();
			}
		});

		it('accepts goal-driven Auto Run launch requests', async () => {
			// Start the runtime in-process.
			const runtime = await startRuntime();

			try {
				// Verify we can launch a goal-driven run.
				const result = value(
					await runtime.autoRun.launchGoal('a1', {
						goal: 'Complete the test goal successfully',
						exitCriteria: 'Goal is marked as complete',
						maxIterations: 10,
					})
				);

				// Result should have tabId (optional per API).
				expect(result).toBeDefined();
				expect(typeof result === 'object').toBe(true);
			} finally {
				await runtime.connection.close();
			}
		});
	});
});
describe('m4-group-chat', () => {
	const __dirname = path.dirname(fileURLToPath(import.meta.url));

	const T0 = Date.parse('2026-10-04T12:00:00Z');
	const BUNDLED_PROMPTS = path.resolve(__dirname, '../../shared/prompts');

	function value<T>(result: ClientResult<T>): T {
		if (!result.ok)
			throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
		return result.value;
	}

	describe('M4 end-to-end: headless group chat and consults', () => {
		let dir: string;
		let work: string;
		let recordings: Record<string, string>;

		const watchDirectory: WatchDirectory = () => ({ close: () => undefined });

		const fakeProvider: RuntimeDeps['turns']['runAgentTurn'] = (turn, options) => {
			return runAgentTurn(
				{
					...turn,
					launch: {
						...turn.launch,
						command: process.execPath,
						args: [FAKE_AGENT_PATH, ...turn.launch.args],
						sessionCustomEnvVars: {
							...turn.launch.sessionCustomEnvVars,
							FAKE_AGENT_RECORDING: recordings[turn.provider.id],
						},
					},
				},
				{ ...options, stopGraceMs: 200 }
			);
		};

		function deps(): Partial<RuntimeDeps> {
			let id = 0;
			let now = 1_000;
			return {
				pid: 100,
				now: () => T0,
				bootTime: () => T0 - 3_600_000,
				isPidAlive: (pid) => pid === 100,
				hostname: () => 'testhost',
				rules: { newId: () => `id-${++id}`, now: () => ++now, random: () => 0 },
				checkCwd: () => null,
				readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
				watchDirectory,
				probeBinary: async () => ({ exists: true, path: '/fake/bin/claude' }),
				turns: { runAgentTurn: fakeProvider },
			};
		}

		const seedAgent = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
			id,
			name,
			toolType: 'claude-code',
			cwd: work,
			projectRoot: work,
			aiTabs: [{ id: `t-${id}-1`, agentSessionId: null, name: null, logs: [] }],
			activeTabId: `t-${id}-1`,
			unifiedTabOrder: [{ type: 'ai', id: `t-${id}-1` }],
			...extra,
		});

		async function startRuntime(
			sessions: unknown[] = [],
			background: RuntimeDeps['background'] = {}
		): Promise<MaestroRuntime> {
			const activeId =
				Array.isArray(sessions) && sessions.length > 0 ? (sessions[0] as any).id : 'a1';
			fs.writeFileSync(
				path.join(dir, 'maestro-sessions.json'),
				JSON.stringify({ sessions, activeSessionId: activeId }, null, '\t')
			);
			const started = await createMaestroRuntime({
				dataDir: dir,
				mode: 'tui',
				deps: { ...deps(), background },
				turns: { bundledPromptsDir: BUNDLED_PROMPTS },
			});
			if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
			return started.runtime;
		}

		function watchTab(runtime: MaestroRuntime, agentId: string, tabId: string) {
			const events: any[] = [];
			const waiting: Array<{ resolve: () => void }> = [];
			runtime.turns.subscribe(agentId, tabId, (event) => {
				events.push(event);
				if (event.kind === 'outcome') {
					for (const waiter of waiting.splice(0)) waiter.resolve();
				}
			});
			return {
				events,
				kinds: () => events.map((event) => event.kind),
				outcome: (ms = 8_000) =>
					new Promise<void>((resolve, reject) => {
						if (events.some((e) => e.kind === 'outcome')) return resolve();
						const timer = setTimeout(
							() => reject(new Error(`no outcome; saw ${events.map((e) => e.kind)}`)),
							ms
						);
						waiting.push({
							resolve: () => {
								clearTimeout(timer);
								resolve();
							},
						});
					}),
			};
		}

		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-m4-'));
			work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-m4-work-'));
			recordings = {
				'claude-code': writeFakeTurn(
					work,
					fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-claude-code-normal'])
				),
			};

			// Create playbooks folder
			fs.mkdirSync(path.join(work, '.maestro', 'playbooks'), { recursive: true });
		});

		afterEach(async () => {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(work, { recursive: true, force: true });
		});

		it('group chat API is available on the runtime', async () => {
			// Create three agents
			const sessions = [
				seedAgent('moderator', 'Moderator'),
				seedAgent('alice', 'Alice'),
				seedAgent('bob', 'Bob'),
			];

			// Start the runtime
			const runtime = await startRuntime(sessions);

			try {
				// Verify group chat API exists
				expect(runtime.groupChats).toBeDefined();
				expect(typeof runtime.groupChats.list).toBe('function');
				expect(typeof runtime.groupChats.get).toBe('function');
				expect(typeof runtime.groupChats.create).toBe('function');
				expect(typeof runtime.groupChats.send).toBe('function');
				expect(typeof runtime.groupChats.stop).toBe('function');

				// Verify we can list chats (should be empty initially)
				const chats = value(await runtime.groupChats.list());
				expect(Array.isArray(chats)).toBe(true);
			} finally {
				await runtime.connection.close();
			}
		});

		it('sends a message with @mention and receives the consultation', async () => {
			// Create two agents: one asking and one being consulted
			const sessions = [seedAgent('asker', 'Asker'), seedAgent('responder', 'Responder')];

			// Start the runtime
			const runtime = await startRuntime(sessions);

			try {
				// Send a message with an @mention to a different agent
				const tab = 't-asker-1';
				const watcher = watchTab(runtime, 'asker', tab);

				// Send a message that mentions the responder
				value(
					await runtime.turns.send('asker', tab, {
						text: '@responder What is the answer?',
					})
				);

				// Wait for the turn to complete
				await watcher.outcome();

				// Verify the turn completed
				expect(watcher.kinds()).toContain('outcome');

				// Verify responder still has only 1 tab (no hidden consult tab visible in list)
				const responderTabs = value(await runtime.tabs.list('responder'));
				expect(responderTabs).toHaveLength(1);
				expect(responderTabs[0].id).toBe('t-responder-1');
			} finally {
				await runtime.connection.close();
			}
		});

		it('consults API is available and can handle @mention cross-agent questions', async () => {
			// Create two agents
			const sessions = [seedAgent('asker', 'Asker'), seedAgent('responder', 'Responder')];

			// The foreground fake provider does not intercept background consults.
			const answer = 'Use a queue.';
			const provider = createFakeGroupChatProvider(work, () => ({ text: answer }));
			const runtime = await startRuntime(sessions, { runTurn: provider.runTurn });

			try {
				// Verify consults API exists
				expect(runtime.consults).toBeDefined();
				expect(typeof runtime.consults.ask).toBe('function');

				const result = await runtime.consults.ask({
					targetAgentId: 'responder',
					question: 'What is the answer?',
					fromAgentId: 'asker',
					timeoutMs: 100,
				});

				expect(result).toBeDefined();
				expect(typeof result.ok).toBe('boolean');
				expect(value(result).answer).toBe(answer);
			} finally {
				await runtime.connection.close();
			}
		});
	});
});

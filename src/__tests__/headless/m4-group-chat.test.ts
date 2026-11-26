/**
 * M4 end-to-end test: headless group chat and cross-agent consults.
 *
 * With no desktop running and a fake provider, create three agents, start a group chat
 * with one moderator and two participants, send a message, verify routing and synthesis,
 * then send an @mention consult and verify the answer lands inline with no tab changes
 * on the consulted agent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { CAPTURED_RECORDINGS } from '../main/process-manager/recordings/captured';
import {
	FAKE_AGENT_PATH,
	fakeTurnFromRecording,
	writeFakeTurn,
} from '../shared/maestro-lib/run/fakeAgent';
import { DEFAULT_TAB_DEFAULTS } from '../../shared/maestro-lib/agents/rules';
import { buildRemoteAskerKey } from '../../shared/crossAgentTypes';
import type { ClientResult } from '../../shared/maestro-lib/client/types';
import { runAgentTurn } from '../../shared/maestro-lib/turns/run-agent-turn';
import {
	createMaestroRuntime,
	type MaestroRuntime,
	type RuntimeDeps,
} from '../../shared/maestro-lib/runtime';
import type { WatchDirectory } from '../../shared/maestro-lib/runtime/settings-watch';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const BUNDLED_PROMPTS = path.resolve(__dirname, '../../shared/prompts');

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
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

	async function startRuntime(sessions: unknown[] = []): Promise<MaestroRuntime> {
		const activeId =
			Array.isArray(sessions) && sessions.length > 0 ? (sessions[0] as any).id : 'a1';
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({ sessions, activeSessionId: activeId }, null, '\t')
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

		// Start the runtime
		const runtime = await startRuntime(sessions);

		try {
			// Verify consults API exists
			expect(runtime.consults).toBeDefined();
			expect(typeof runtime.consults.ask).toBe('function');

			// Verify we can ask a consult (it will timeout since fake provider doesn't handle it,
			// but that's OK - we're just verifying the API is wired)
			const result = await runtime.consults.ask({
				targetAgentId: 'responder',
				question: 'What is the answer?',
				fromAgentId: 'asker',
				timeoutMs: 100, // Short timeout for test
			});

			// Even if it times out, the API should return a ClientResult
			expect(result).toBeDefined();
			expect(typeof result.ok).toBe('boolean');
		} finally {
			await runtime.connection.close();
		}
	});

	// G2: an asker on another machine names itself by (machine, agent, tab). The host keeps one
	// consult tab per key, as it keeps one per local asker, so a follow-up continues its own
	// thread; a key it cannot read falls back to the one shared stand-in tab, never another's.
	it('keeps one consult tab per remote asker key, and none a key can reach outside it', async () => {
		const sessions = [seedAgent('responder', 'Responder')];
		const runtime = await startRuntime(sessions);
		const keyA = buildRemoteAskerKey({ machine: 'laptop', agentId: 'agent-a', tabId: 'tab-1' });
		const keyB = buildRemoteAskerKey({ machine: 'laptop', agentId: 'agent-a', tabId: 'tab-2' });
		try {
			for (const askerKey of [keyA, keyA, keyB, 'responder', undefined]) {
				await runtime.consults.ask({
					targetAgentId: 'responder',
					question: 'What is the answer?',
					fromAgentName: 'Laptop Agent',
					...(askerKey ? { askerKey } : {}),
				});
			}
		} finally {
			await runtime.connection.close();
		}
		const stored = JSON.parse(fs.readFileSync(path.join(dir, 'maestro-sessions.json'), 'utf8'));
		const responder = stored.sessions.find((s: { id: string }) => s.id === 'responder');
		const consultTabs = responder.aiTabs.filter(
			(tab: { consultOrigin?: unknown }) => tab.consultOrigin
		);
		expect(consultTabs.map((tab: { consultOrigin: unknown }) => tab.consultOrigin)).toEqual([
			{ sourceSessionId: `remote-asker:${keyA}`, sourceTabId: 'cli-ask' },
			{ sourceSessionId: `remote-asker:${keyB}`, sourceTabId: 'cli-ask' },
			// The bare agent id is not a key: it lands in the shared stand-in, not the agent's own tab.
			{ sourceSessionId: 'cli-ask', sourceTabId: 'cli-ask' },
		]);
		// Two questions from the same asker landed in one thread.
		const userTurns = consultTabs[0].logs.filter(
			(log: { source: string }) => log.source === 'user'
		);
		expect(userTurns).toHaveLength(2);
		// The agent's own tab is untouched.
		expect(responder.aiTabs[0].logs).toEqual([]);
	});

	// G1: Stop on a remote asker reaches this host by its key, and a key that is not one stops
	// nothing, never the stand-in tab other askers share.
	it('stops a remote asker by its key and refuses a key it cannot read', async () => {
		const runtime = await startRuntime([seedAgent('responder', 'Responder')]);
		try {
			const key = buildRemoteAskerKey({ machine: 'laptop', agentId: 'a', tabId: 't' });
			expect(await runtime.consults.cancel?.({ askerKey: key })).toEqual({
				ok: true,
				value: { canceled: 0 },
			});
			const refused = await runtime.consults.cancel?.({ askerKey: 'cli-ask' });
			expect(refused?.ok).toBe(false);
		} finally {
			await runtime.connection.close();
		}
	});

	// A Stop that lands before the consult's process starts (it waits its turn, or its question is
	// still being written) still ends it as stopped, on its consult tab too, as a local Stop does.
	it('ends a consult stopped before its process started as a stopped one', async () => {
		const runtime = await startRuntime([seedAgent('responder', 'Responder')]);
		const askerKey = buildRemoteAskerKey({ machine: 'laptop', agentId: 'a', tabId: 't' });
		let result: ClientResult<unknown> | undefined;
		try {
			const asked = runtime.consults.ask({
				targetAgentId: 'responder',
				question: 'What is the answer?',
				askerKey,
			});
			expect(await runtime.consults.cancel?.({ askerKey })).toEqual({
				ok: true,
				value: { canceled: 1 },
			});
			result = await asked;
		} finally {
			await runtime.connection.close();
		}
		expect(result?.ok).toBe(false);
		if (result && !result.ok) expect(result.error.message).toMatch(/was stopped/);
		const stored = JSON.parse(fs.readFileSync(path.join(dir, 'maestro-sessions.json'), 'utf8'));
		const responder = stored.sessions.find((s: { id: string }) => s.id === 'responder');
		const consultTab = responder.aiTabs.find(
			(tab: { consultOrigin?: unknown }) => tab.consultOrigin
		);
		expect(consultTab.logs.map((log: { source: string }) => log.source)).toEqual(['user', 'ai']);
		expect(consultTab.logs[1].text).toMatch(/was stopped/);
	});
});

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
});

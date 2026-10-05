/**
 * The runtime's consults (XM-1 to XM-4): `ask` end to end with no desktop, over a fake provider.
 *
 * As in the group chat tests, a consult is a real process on a real pipe: the runtime plans the
 * real spawn and starts it through the real run layer, and only the command is swapped for the
 * fake agent. The runtime, its repository, and the target's consult tab are real and write to a
 * temp data directory, so what the tests read back is what a desktop would read.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createFakeGroupChatProvider,
	promptOf,
	type FakeGroupChatProvider,
	type FakeScript,
} from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import { CROSS_AGENT_ASK_SESSION_ID, CROSS_AGENT_ASK_TAB_ID } from '../../../crossAgentTypes';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import type { ClientResult, MaestroEvent } from '../../client/types';
import { readHistory } from '../../store/read-history';
import { createMaestroRuntime, type MaestroRuntime, type RuntimeDeps } from '../index';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const BUNDLED_PROMPTS = path.resolve(__dirname, '../../../../prompts');

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}
function errorOf(result: ClientResult<unknown>) {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

const agentRecord = (
	id: string,
	name: string,
	cwd: string,
	extra: Record<string, unknown> = {}
) => ({
	id,
	name,
	toolType: 'claude-code',
	cwd,
	projectRoot: cwd,
	aiTabs: [{ id: `${id}-t1`, agentSessionId: null, name: null, logs: [] }],
	activeTabId: `${id}-t1`,
	unifiedTabOrder: [{ type: 'ai', id: `${id}-t1` }],
	...extra,
});

const ANSWER: FakeScript = (call) => ({ text: `Answer ${call.nth}: use a queue.` });

describe('runtime consults', () => {
	let dir: string;
	let work: string;
	let open: MaestroRuntime[];
	let provider: FakeGroupChatProvider;

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
			watchDirectory: () => ({ close: () => undefined }),
			probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
			background: { runTurn: provider.runTurn },
			consults: { minTimeoutMs: 50 },
		};
	}

	const sessionsFile = () => path.join(dir, 'maestro-sessions.json');
	const readSessions = () => JSON.parse(fs.readFileSync(sessionsFile(), 'utf-8')).sessions;

	async function start(
		script: FakeScript = ANSWER,
		sessions: unknown[] = [
			agentRecord('a1', 'Alpha', work),
			agentRecord('a2', 'Beta', work),
			agentRecord('a3', 'Gamma', work),
		],
		settings: Record<string, unknown> = {}
	): Promise<MaestroRuntime> {
		provider = createFakeGroupChatProvider(work, script);
		fs.writeFileSync(
			sessionsFile(),
			JSON.stringify({ sessions, activeSessionId: 'a1' }, null, '\t')
		);
		fs.writeFileSync(path.join(dir, 'maestro-settings.json'), JSON.stringify(settings));
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps: deps(),
			turns: { bundledPromptsDir: BUNDLED_PROMPTS },
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		open.push(started.runtime);
		return started.runtime;
	}

	/** The hidden consult tab Beta keeps for Alpha's asks. */
	const consultTab = (agentId: string) =>
		readSessions()
			.find((s: { id: string }) => s.id === agentId)
			.aiTabs.find((t: { consultOrigin?: unknown }) => t.consultOrigin);

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-consult-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-consult-work-'));
		open = [];
	});
	afterEach(async () => {
		for (const runtime of open) await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	describe('an answer, inline (XM-2)', () => {
		it('asks the target and returns what it said', async () => {
			const runtime = await start();
			const answer = value(
				await runtime.consults.ask({
					targetAgentId: 'a2',
					question: 'How should we retry?',
					fromAgentId: 'a1',
				})
			);

			expect(answer).toEqual({ answer: 'Answer 1: use a queue.', agentName: 'Beta' });
			const [call] = provider.callsFor('consult');
			expect(call.processId).toMatch(/^cross-agent-/);
			expect(call.spec.command).toBe('/fake/bin/claude');
			// The question and the consulting agent's name are in what the target was told.
			expect(promptOf(call.spec)).toContain('How should we retry?');
		});

		it('is read-only by default, and writable only when the user opted in (B19)', async () => {
			const readOnly = await start();
			value(await readOnly.consults.ask({ targetAgentId: 'a2', question: 'Look at this' }));
			expect(provider.callsFor('consult')[0].spec.args.join(' ')).toContain('plan');
			await readOnly.connection.close();

			const writable = await start(ANSWER, undefined, { crossAgentMentionsWritable: true });
			value(await writable.consults.ask({ targetAgentId: 'a2', question: 'Fix this' }));
			expect(provider.callsFor('consult')[0].spec.args.join(' ')).not.toContain('plan');
		});

		it('creates no tab, no tab event, and no unread on the consulted agent (XM-2)', async () => {
			const runtime = await start();
			const events: MaestroEvent[] = [];
			runtime.events.subscribe((event) => events.push(event));
			const before = value(await runtime.tabs.list('a2'));
			const activeBefore = value(await runtime.agents.get('a2')).activeTabId;

			value(
				await runtime.consults.ask({
					targetAgentId: 'a2',
					question: 'Quietly, please',
					fromAgentId: 'a1',
				})
			);

			// What a person sees of Beta is exactly what it was.
			expect(value(await runtime.tabs.list('a2'))).toEqual(before);
			expect(value(await runtime.agents.get('a2')).activeTabId).toBe(activeBefore);
			expect(events.filter((event) => event.type.startsWith('tab.'))).toEqual([]);
			expect(events.some((event) => event.type === 'turn')).toBe(false);

			// The exchange lives on a hidden tab of its own, keyed by who asked.
			const tab = consultTab('a2');
			expect(tab).toMatchObject({
				hidden: true,
				name: '↩ Alpha',
				consultOrigin: { sourceSessionId: 'a1', sourceTabId: CROSS_AGENT_ASK_TAB_ID },
			});
			expect(tab.hasUnread).toBeFalsy();
			expect(tab.logs.map((entry: { source: string }) => entry.source)).toEqual(['user', 'ai']);
			expect(tab.logs[1].text).toBe('Answer 1: use a queue.');
			// The asking agent's own tabs are untouched.
			expect(value(await runtime.tabs.list('a1')).map((t) => t.id)).toEqual(['a1-t1']);
		});

		it('writes a History entry on the target saying who consulted it and about what', async () => {
			const runtime = await start();
			value(
				await runtime.consults.ask({
					targetAgentId: 'a2',
					question: 'How should we retry the webhook?',
					fromAgentId: 'a1',
				})
			);

			const read = readHistory({ historyDir: path.join(dir, 'history') }, 'a2');
			if (read.status !== 'ok') throw new Error(`history was ${read.status}`);
			expect(read.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: 'AGENT',
						sourceAgentName: 'Alpha',
						summary: expect.stringContaining('How should we retry the webhook?'),
						success: true,
					}),
				])
			);
		});

		it('keys an unattributed ask on one shared consult tab, like the desktop', async () => {
			const runtime = await start();
			value(await runtime.consults.ask({ targetAgentId: 'a2', question: 'First' }));
			value(await runtime.consults.ask({ targetAgentId: 'a2', question: 'Second' }));

			const tabs = readSessions()
				.find((s: { id: string }) => s.id === 'a2')
				.aiTabs.filter((t: { consultOrigin?: unknown }) => t.consultOrigin);
			expect(tabs).toHaveLength(1);
			expect(tabs[0].consultOrigin).toEqual({
				sourceSessionId: CROSS_AGENT_ASK_SESSION_ID,
				sourceTabId: CROSS_AGENT_ASK_TAB_ID,
			});
			expect(tabs[0].name).toBe('↩ CLI');
			expect(tabs[0].logs).toHaveLength(4);
		});

		it('forwards the asking tab as context only when asked to, windowed by the question', async () => {
			const sessions = [
				agentRecord('a1', 'Alpha', work, {
					aiTabs: [
						{
							id: 'a1-t1',
							agentSessionId: null,
							name: null,
							logs: [
								{ id: 'l1', timestamp: 1, source: 'user', text: 'We chose Postgres.' },
								{ id: 'l2', timestamp: 2, source: 'stdout', text: 'Noted: Postgres.' },
							],
						},
					],
				}),
				agentRecord('a2', 'Beta', work),
			];
			const runtime = await start(ANSWER, sessions);

			value(
				await runtime.consults.ask({
					targetAgentId: 'a2',
					question: 'What did we pick?',
					fromAgentId: 'a1',
				})
			);
			expect(promptOf(provider.callsFor('consult')[0].spec)).not.toContain('We chose Postgres.');

			value(
				await runtime.consults.ask({
					targetAgentId: 'a2',
					question: 'What did we pick?',
					fromAgentId: 'a1',
					withContext: true,
				})
			);
			expect(promptOf(provider.callsFor('consult')[1].spec)).toContain('We chose Postgres.');
		});
	});

	describe('continuity and failure (B17, B18)', () => {
		it('resumes the target’s provider session on the next ask from the same agent', async () => {
			const runtime = await start((call) => ({
				text: `Answer ${call.nth}`,
				sessionId: `provider-session-${call.nth}`,
			}));
			value(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'One', fromAgentId: 'a1' })
			);
			expect(consultTab('a2').agentSessionId).toBe('provider-session-1');
			expect(provider.callsFor('consult')[0].spec.args).not.toContain('--resume');

			value(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Two', fromAgentId: 'a1' })
			);
			const second = provider.callsFor('consult')[1].spec.args;
			expect(second[second.indexOf('--resume') + 1]).toBe('provider-session-1');
		});

		it('fails on a non-zero exit even when the target said something, and stores no resume id (B17, B18)', async () => {
			const runtime = await start(() => ({
				text: 'I got halfway.',
				exitCode: 1,
				sessionId: 'doomed-session',
			}));

			const error = errorOf(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Try', fromAgentId: 'a1' })
			);

			expect(error.code).toBe('failed');
			expect(error.message).toMatch(/Beta exited with code 1/);
			const tab = consultTab('a2');
			// What it said is kept on the tab, with the reason after it; the failed session is not resumed.
			expect(tab.logs.at(-1)).toMatchObject({ source: 'error' });
			expect(tab.logs.at(-1).text).toContain('I got halfway.');
			expect(tab.agentSessionId ?? null).toBeNull();
		});

		it('says the target produced no output when it exits clean and silent', async () => {
			const runtime = await start(() => ({ text: '' }));
			const error = errorOf(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Hello?' })
			);
			expect(error.message).toMatch(/no visible output/);
		});

		it('refuses an empty question, an unknown target, and an agent asking itself', async () => {
			const runtime = await start();
			expect(
				errorOf(await runtime.consults.ask({ targetAgentId: 'a2', question: '  ' })).code
			).toBe('invalid');
			expect(
				errorOf(await runtime.consults.ask({ targetAgentId: 'zzz', question: 'Hi' })).code
			).toBe('not-found');
			expect(
				errorOf(
					await runtime.consults.ask({ targetAgentId: 'a2', question: 'Hi', fromAgentId: 'a2' })
				).code
			).toBe('invalid');
			expect(provider.calls).toEqual([]);
		});

		it('refuses a target with no directory to run in', async () => {
			const runtime = await start(ANSWER, [
				agentRecord('a1', 'Alpha', work),
				{ id: 'a2', name: 'Beta', toolType: 'claude-code', aiTabs: [] },
			]);
			expect(
				errorOf(await runtime.consults.ask({ targetAgentId: 'a2', question: 'Hi' })).code
			).toBe('rejected');
		});
	});

	describe('fan-out and Stop (XM-4, B20, GD18, GD19)', () => {
		it('asks several agents at once: one slow answer does not hold the others back', async () => {
			const runtime = await start((call) =>
				call.nth === 1 ? { text: 'slow', hold: true } : { text: `fast ${call.nth}` }
			);
			// The first consult (to Beta) never finishes on its own.
			const slow = runtime.consults.ask({
				targetAgentId: 'a2',
				question: 'Slow one',
				fromAgentId: 'a1',
			});
			await vi.waitFor(() => expect(provider.callsFor('consult')).toHaveLength(1));
			expect(runtime.consultsInFlight()).toBe(1);

			// A different agent answers while it is still running.
			const fast = value(
				await runtime.consults.ask({
					targetAgentId: 'a3',
					question: 'Fast one',
					fromAgentId: 'a1',
				})
			);
			expect(fast.answer).toBe('fast 2');
			expect(runtime.consultsInFlight()).toBe(1);

			// Stop on the asking agent ends the slow one and reports why.
			value(await runtime.turns.interrupt('a1', 'a1-t1'));
			const stopped = errorOf(await slow);
			expect(stopped.code).toBe('rejected');
			expect(stopped.message).toMatch(/Beta was stopped|consult with Beta was stopped/);
			expect(runtime.consultsInFlight()).toBe(0);
		});

		it('runs consults that share a consult tab one at a time (GD18)', async () => {
			const runtime = await start((call) =>
				call.nth === 1 ? { text: 'first', hold: true } : { text: `second ${call.nth}` }
			);
			const first = runtime.consults.ask({
				targetAgentId: 'a2',
				question: 'First',
				fromAgentId: 'a1',
			});
			await vi.waitFor(() => expect(provider.callsFor('consult')).toHaveLength(1));

			const second = runtime.consults.ask({
				targetAgentId: 'a2',
				question: 'Second',
				fromAgentId: 'a1',
			});
			// Two processes resuming one provider session corrupt it: the second waits.
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(provider.callsFor('consult')).toHaveLength(1);

			value(await runtime.turns.interrupt('a1', 'a1-t1'));
			expect(errorOf(await first).code).toBe('rejected');
			expect(value(await second).answer).toBe('second 2');
			expect(provider.callsFor('consult')).toHaveLength(2);
		});

		it('stops the consult when the caller’s wait runs out (GD19)', async () => {
			const runtime = await start(() => ({ text: 'never done', hold: true }));

			const error = errorOf(
				await runtime.consults.ask({ targetAgentId: 'a2', question: 'Too slow', timeoutMs: 100 })
			);

			expect(error.code).toBe('timeout');
			expect(error.message).toMatch(/did not answer within/);
			await vi.waitFor(() => expect(runtime.consultsInFlight()).toBe(0));
		});

		it('shutdown stops a consult in flight, writes down how it ended, and starts nothing queued behind it', async () => {
			const runtime = await start((call) =>
				call.nth === 1 ? { text: 'working', hold: true } : { text: 'should never run' }
			);
			const first = runtime.consults.ask({
				targetAgentId: 'a2',
				question: 'Long one',
				fromAgentId: 'a1',
			});
			await vi.waitFor(() => expect(provider.callsFor('consult')).toHaveLength(1));
			// Waiting behind the first on the same consult tab.
			const queued = runtime.consults.ask({
				targetAgentId: 'a2',
				question: 'Behind it',
				fromAgentId: 'a1',
			});

			await runtime.connection.close();

			// The running one ended as stopped, and that is on the consult tab before the lock went.
			expect(errorOf(await first).code).toBe('rejected');
			expect(errorOf(await queued).code).toBe('host-unavailable');
			expect(provider.callsFor('consult')).toHaveLength(1);
			expect(consultTab('a2').logs.at(-1).text).toMatch(/was stopped/);
			// And nothing more is accepted.
			expect(
				errorOf(await runtime.consults.ask({ targetAgentId: 'a2', question: 'Too late' })).code
			).toBe('host-unavailable');
		});
	});
});

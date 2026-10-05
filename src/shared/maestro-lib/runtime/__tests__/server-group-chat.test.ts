/**
 * Group chats and consults over the detached host's wire: a real runtime on a temp data directory,
 * a fake provider, served by `startRuntimeServer` and read by the real `createWsMaestroClient`.
 *
 * This is the shape a TUI attached to `maestro-cli host` has: it holds no engine and no process,
 * only the client, so everything it learns about a round arrives as the desktop bridge's own
 * `groupChat:*` frames. The tests assert that a round driven through the wire reads the same as the
 * one the runtime ran, and that the verbs with no bridge message of their own (rename, delete) reach
 * the runtime through the IPC channels the desktop's UI calls.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createFakeGroupChatProvider,
	type FakeGroupChatProvider,
	type FakeScript,
} from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import { writeCliServerInfoTo } from '../../client/discovery';
import { requestHostStatus, requestHostStop } from '../../client/host-control';
import type { ClientResult, MaestroClient, MaestroEvent } from '../../client/types';
import { createWsMaestroClient } from '../../client/ws-client';
import { foldGroupChat, emptyGroupChat } from '../../groupchat/chat';
import { createMaestroRuntime, type MaestroRuntime, type RuntimeDeps } from '../index';
import { startRuntimeServer, type RuntimeServer } from '../server';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const TOKEN = 'test-token';
const SECRET = 'test-secret';
const BUNDLED_PROMPTS = path.resolve(__dirname, '../../../../prompts');

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}
function errorOf(result: ClientResult<unknown>) {
	if (result.ok) throw new Error('expected a failure');
	return result.error;
}

const agentRecord = (id: string, name: string, cwd: string) => ({
	id,
	name,
	toolType: 'claude-code',
	cwd,
	projectRoot: cwd,
	aiTabs: [{ id: `${id}-t1`, agentSessionId: null, name: null, logs: [] }],
	activeTabId: `${id}-t1`,
	unifiedTabOrder: [{ type: 'ai', id: `${id}-t1` }],
});

const ROUND: FakeScript = (call) => {
	switch (call.role) {
		case 'moderator':
			return { text: '@Alpha @Beta please look at this.' };
		case 'participant':
			return { text: `${call.participant} says: ship it.` };
		case 'synthesis':
			return { text: 'Agreed: ship it.' };
		default:
			return { text: 'The answer is 42.' };
	}
};

describe('group chats and consults over the wire', () => {
	let dir: string;
	let work: string;
	let runtime: MaestroRuntime;
	let server: RuntimeServer;
	let client: MaestroClient;
	let provider: FakeGroupChatProvider;
	let script: FakeScript;

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-server-gc-'));
		work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-server-gc-work-'));
		script = ROUND;
		provider = createFakeGroupChatProvider(work, (call) => script(call));
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({
				sessions: [agentRecord('a1', 'Alpha', work), agentRecord('a2', 'Beta', work)],
				activeSessionId: 'a1',
			})
		);
		let id = 0;
		let now = 1_000;
		const deps: Partial<RuntimeDeps> = {
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
		};
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'host',
			deps,
			turns: { bundledPromptsDir: BUNDLED_PROMPTS },
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		runtime = started.runtime;
		server = await startRuntimeServer({
			runtime,
			token: TOKEN,
			cliSecret: SECRET,
			onStopRequested: () => undefined,
		});
		writeCliServerInfoTo(dir, {
			port: server.port,
			token: TOKEN,
			pid: process.pid,
			startedAt: Date.now(),
			cliSecret: SECRET,
			hostKind: 'headless',
		});
		client = createWsMaestroClient({
			userDataDir: dir,
			reconcileIntervalMs: 0,
			heartbeatIntervalMs: 60_000,
		});
		value(await client.connection.connect());
	});

	afterEach(async () => {
		await client.connection.close();
		await server.close();
		await runtime.connection.close();
		fs.rmSync(dir, { recursive: true, force: true });
		fs.rmSync(work, { recursive: true, force: true });
	});

	/** A chat's events as THIS client received them, folded the way the TUI folds them. */
	function watchChat(chatId?: string) {
		const events: MaestroEvent[] = [];
		client.events.subscribe((event) => events.push(event), { types: ['groupChat'] });
		const idleCount = () =>
			events.filter(
				(event) =>
					event.type === 'groupChat' &&
					(chatId === undefined || event.chatId === chatId) &&
					event.event.kind === 'state' &&
					event.event.state === 'idle'
			).length;
		return {
			events,
			idle: (count = 1) =>
				vi.waitFor(() => expect(idleCount()).toBeGreaterThanOrEqual(count), {
					timeout: 10_000,
					interval: 20,
				}),
			folded: (id: string) =>
				foldGroupChat(
					emptyGroupChat(id),
					events.flatMap((event) =>
						event.type === 'groupChat' && event.chatId === id ? [event.event] : []
					)
				),
		};
	}

	it('runs a round a client started: the same events, then the same chat to read', async () => {
		const watch = watchChat();
		const { chatId } = value(
			await client.groupChats.create({ name: 'Release review', participantIds: ['a1', 'a2'] })
		);
		await watch.idle();

		// What the client was pushed folds into the chat the host reads back.
		const pushed = watch.folded(chatId);
		const read = value(await client.groupChats.get(chatId));
		expect(pushed.state).toBe('idle');
		expect(pushed.working).toEqual([]);
		expect(pushed.participants.map((p) => p.name).sort()).toEqual(['Alpha', 'Beta']);
		expect(pushed.lines.map((line) => `${line.from}: ${line.text}`)).toEqual(
			expect.arrayContaining([
				'Alpha: Alpha says: ship it.',
				'Beta: Beta says: ship it.',
				'moderator: Agreed: ship it.',
			])
		);
		// The read agrees with the push on every line it holds.
		for (const line of pushed.lines) {
			expect(read.lines.some((l) => l.from === line.from && l.text === line.text)).toBe(true);
		}
		expect(read).toMatchObject({
			id: chatId,
			name: 'Release review',
			moderatorProvider: 'claude-code',
			state: 'idle',
			archived: false,
		});
		expect(value(await client.groupChats.list()).map((chat) => chat.id)).toEqual([chatId]);
	});

	it('names the moderator by provider, as the desktop’s start request does', async () => {
		const watch = watchChat();
		const { chatId } = value(
			await client.groupChats.create({
				name: 'By agent',
				participantIds: ['a1'],
				moderatorAgentId: 'a2',
			})
		);
		await watch.idle();
		expect(value(await client.groupChats.get(chatId)).moderatorProvider).toBe('claude-code');
	});

	it('refuses a send while the room works, and stops the round on request', async () => {
		script = (call) =>
			call.role === 'participant' ? { text: 'working', hold: true } : ROUND(call);
		const watch = watchChat();
		const { chatId } = value(
			await client.groupChats.create({ name: 'Busy', participantIds: ['a1', 'a2'] })
		);
		await vi.waitFor(() => expect(provider.callsFor('participant')).toHaveLength(2), {
			timeout: 10_000,
		});

		expect(errorOf(await client.groupChats.send(chatId, 'more')).code).toBe('rejected');
		// The host's own counts: a round is work a stop would cut off.
		const report = await requestHostStatus(dir);
		expect(report.work.rounds).toBe(1);
		expect(report.work.turns).toBe(0);
		expect(await requestHostStop(dir, {})).toMatchObject({
			stopping: false,
			reason: 'work-in-flight',
		});

		value(await client.groupChats.stop(chatId));
		await watch.idle();
		expect((await requestHostStatus(dir)).work.rounds).toBe(0);
		expect(value(await client.groupChats.get(chatId)).state).toBe('idle');
	});

	it('renames and deletes through the channels the desktop’s own UI calls', async () => {
		const watch = watchChat();
		const { chatId } = value(
			await client.groupChats.create({ name: 'Old name', participantIds: ['a1'] })
		);
		await watch.idle();

		value(await client.groupChats.rename(chatId, 'New name'));
		expect(value(await runtime.groupChats.get(chatId)).name).toBe('New name');

		value(await client.groupChats.remove(chatId));
		expect(errorOf(await runtime.groupChats.get(chatId)).code).toBe('not-found');
		expect(value(await client.groupChats.list())).toEqual([]);
	});

	it('answers a consult over the wire, waiting as long as the answer takes', async () => {
		const answer = value(
			await client.consults.ask({
				targetAgentId: 'a2',
				question: 'What is the answer?',
				fromAgentId: 'a1',
			})
		);
		expect(answer).toEqual({ answer: 'The answer is 42.', agentName: 'Beta' });
		// The target's tabs are what they were: the exchange lives on a hidden tab.
		expect(value(await client.tabs.list('a2')).map((tab) => tab.id)).toEqual(['a2-t1']);
	});

	it('reports a stopped consult as stopped, not as the target failing', async () => {
		script = () => ({ text: 'working', hold: true });
		const pending = client.consults.ask({
			targetAgentId: 'a2',
			question: 'Long one',
			fromAgentId: 'a1',
		});
		await vi.waitFor(() => expect(provider.callsFor('consult')).toHaveLength(1), {
			timeout: 10_000,
		});
		expect((await requestHostStatus(dir)).work.consults).toBe(1);

		value(await client.turns.interrupt('a1', 'a1-t1'));

		const error = errorOf(await pending);
		expect(error.code).toBe('rejected');
		expect(error.message).toMatch(/stopped/);
	});

	it('fans one message out to several agents, each answering for itself (XM-4)', async () => {
		script = (call) => ({ text: `Answer from call ${call.nth}` });
		const answers = await Promise.all([
			client.consults.ask({ targetAgentId: 'a1', question: 'Q1', fromAgentId: undefined }),
			client.consults.ask({ targetAgentId: 'a2', question: 'Q2' }),
		]);
		const texts = answers.map((result) => value(result).answer).sort();
		expect(texts).toEqual(['Answer from call 1', 'Answer from call 2']);
		expect(answers.map((result) => value(result).agentName).sort()).toEqual(['Alpha', 'Beta']);
	});
});

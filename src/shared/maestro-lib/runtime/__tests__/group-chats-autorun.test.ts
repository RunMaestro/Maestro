/**
 * A participant's `!autorun` in a headless chat (GD12): the runtime launches the participant's Auto
 * Run through the Phase 7 service, closes the participant out with what the run said when it ends,
 * and ends the run when the chat is stopped.
 *
 * The run service is faked (its own suite covers it); the engine, the chat's storage, and the
 * provider turns are the real ones, over the same fake provider as the other group chat tests.
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
import type { AutoRunProgress } from '../../autorun/progress';
import { createEventBus, type EventBus } from '../../client/event-bus';
import type { ClientResult, MaestroEvent } from '../../client/types';
import { createGroupChatTurnMetrics } from '../../groupchat/turn-metrics';
import { resolveMaestroPaths } from '../../paths/resolve';
import { createSleepTracker } from '../../../sleepTracking';
import type { AgentRecord } from '../../store/records';
import { createBackgroundTurns } from '../background-turns';
import { createRuntimeGroupChats, type RuntimeGroupChats } from '../group-chats';
import { createProcessRegistry } from '../processes';

const BUNDLED_PROMPTS = path.resolve(__dirname, '../../../../prompts');

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
}

const progress = (overrides: Partial<AutoRunProgress> = {}): AutoRunProgress => ({
	isRunning: true,
	isStopping: false,
	documents: ['plan'],
	currentDocumentIndex: 0,
	currentDocTasksTotal: 3,
	currentDocTasksDone: 0,
	tasksTotal: 3,
	tasksDone: 0,
	loopEnabled: false,
	loopIteration: 0,
	...overrides,
});

describe('a participant’s !autorun in a headless chat', () => {
	let dir: string;
	let folder: string;
	let bus: EventBus;
	let chats: RuntimeGroupChats;
	let provider: FakeGroupChatProvider;
	let launches: Array<{ agentId: string; files: string[] }>;
	let stops: string[];
	let launchResult: ClientResult<void>;
	let script: FakeScript;
	let lines: string[];
	let states: string[];

	const emitRun = (agentId: string, state: AutoRunProgress | null) =>
		bus.emit({ type: 'autorun', agentId, event: { kind: 'state', at: 1, state } });

	const agents = (): AgentRecord[] => [
		{
			id: 'a1',
			name: 'Alpha',
			toolType: 'claude-code',
			cwd: dir,
			autoRunFolderPath: folder,
			aiTabs: [],
		},
		{ id: 'a2', name: 'Beta', toolType: 'claude-code', cwd: dir, aiTabs: [] },
	];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-gc-autorun-'));
		folder = path.join(dir, 'playbooks');
		fs.mkdirSync(folder);
		fs.writeFileSync(path.join(folder, 'plan.md'), '- [ ] one\n- [ ] two\n');
		fs.writeFileSync(path.join(folder, 'done.md'), '- [x] finished\n');
		launches = [];
		stops = [];
		lines = [];
		states = [];
		launchResult = { ok: true, value: undefined };
		script = (call) =>
			call.role === 'moderator' && call.nth === 1
				? { text: '!autorun @Alpha:plan.md' }
				: call.role === 'synthesis'
					? { text: 'All wrapped up.' }
					: { text: 'unexpected' };
		provider = createFakeGroupChatProvider(dir, (call) => script(call));
		bus = createEventBus('[test]');
		bus.subscribe(
			(event: MaestroEvent) => {
				if (event.type !== 'groupChat') return;
				if (event.event.kind === 'message') {
					lines.push(`${event.event.line.from}: ${event.event.line.text}`);
				}
				if (event.event.kind === 'state') states.push(event.event.state);
			},
			{ types: ['groupChat'] }
		);

		const paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: dir } });
		const registry = createProcessRegistry({ waitMs: 2_000 });
		const tracker = createSleepTracker();
		const metrics = createGroupChatTurnMetrics({
			spans: { begin: tracker.beginSpan, elapsedMs: tracker.elapsedMs },
		});
		const background = createBackgroundTurns({
			paths,
			registry,
			host: {},
			beginTurn: (id) => metrics.begin(id),
			deps: {
				runTurn: provider.runTurn,
				probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
			},
		});
		chats = createRuntimeGroupChats({
			paths,
			repository: {
				listAgents: () => agents(),
				getAgent: (id: string) => agents().find((agent) => agent.id === id),
			} as never,
			bus,
			registry,
			fence: () => ({ ok: true }),
			background,
			metrics,
			autoRun: {
				api: {
					launch: async (agentId, input) => {
						launches.push({ agentId, files: input.documents.map((d) => d.file) });
						return launchResult;
					},
					stop: async (agentId) => {
						stops.push(agentId);
						return { ok: true, value: undefined };
					},
				},
				holds: () => false,
			},
			options: { bundledPromptsDir: BUNDLED_PROMPTS },
		});
	});
	afterEach(async () => {
		await chats.stopAll();
		await chats.drain();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	/** Resolves once the room has gone idle after working. */
	const idle = () =>
		vi.waitFor(
			() => {
				const last = states.at(-1);
				expect(states).toContain('moderator-thinking');
				expect(last).toBe('idle');
			},
			{ timeout: 10_000, interval: 20 }
		);

	it('launches the named document, and closes the participant out with what the run did', async () => {
		const { chatId } = value(
			await chats.api.create({ name: 'Room', participantIds: ['a1'], message: 'Run the plan' })
		);
		await vi.waitFor(() => expect(launches).toHaveLength(1), { timeout: 10_000 });
		expect(launches[0]).toEqual({ agentId: 'a1', files: [path.join(folder, 'plan.md')] });

		// The run works, then ends: the last counts it reported are the summary.
		emitRun('a1', progress({ tasksDone: 1 }));
		emitRun('a1', progress({ tasksDone: 2, currentDocTasksDone: 2 }));
		emitRun('a1', null);

		await idle();
		const read = value(await chats.api.get(chatId));
		expect(read.lines.map((line) => `${line.from}: ${line.text}`)).toEqual(
			expect.arrayContaining([
				'Alpha: Auto Run complete: 2/3 tasks finished across 1 document(s).',
				'moderator: All wrapped up.',
			])
		);
		expect(read.state).toBe('idle');
	});

	it('runs every document with unchecked tasks when the directive names none', async () => {
		script = (call) =>
			call.role === 'moderator' && call.nth === 1
				? { text: '!autorun @Alpha' }
				: call.role === 'synthesis'
					? { text: 'Done.' }
					: { text: 'unexpected' };
		value(await chats.api.create({ name: 'Room', participantIds: ['a1'] }));
		await vi.waitFor(() => expect(launches).toHaveLength(1), { timeout: 10_000 });

		// done.md has nothing left to do.
		expect(launches[0].files).toEqual([path.join(folder, 'plan.md')]);
		emitRun('a1', null);
		await idle();
	});

	it('says why a run could not start, and the round carries on', async () => {
		launchResult = {
			ok: false,
			error: { code: 'rejected', message: 'The agent is busy.', method: 'autoRun.launch' },
		};
		const { chatId } = value(await chats.api.create({ name: 'Room', participantIds: ['a1'] }));

		await idle();
		const read = value(await chats.api.get(chatId));
		expect(read.lines.map((line) => `${line.from}: ${line.text}`)).toEqual(
			expect.arrayContaining([
				'Alpha: Auto Run could not start for Alpha: The agent is busy.',
				'moderator: All wrapped up.',
			])
		);
	});

	it('ends the run when the chat is stopped', async () => {
		const { chatId } = value(await chats.api.create({ name: 'Room', participantIds: ['a1'] }));
		await vi.waitFor(() => expect(launches).toHaveLength(1), { timeout: 10_000 });

		value(await chats.api.stop(chatId));

		expect(stops).toEqual(['a1']);
		// The run ending after the stop does not restart the round.
		emitRun('a1', progress({ isStopping: true, tasksDone: 1 }));
		emitRun('a1', null);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(provider.callsFor('synthesis')).toHaveLength(0);
	});

	it('says so, without launching, when the participant has no Auto Run folder', async () => {
		script = (call) =>
			call.role === 'moderator' && call.nth === 1
				? { text: '!autorun @Beta' }
				: call.role === 'synthesis'
					? { text: 'Done.' }
					: { text: 'unexpected' };
		value(await chats.api.create({ name: 'Room', participantIds: ['a2'] }));

		await idle();
		expect(launches).toEqual([]);
		// The engine says so to the room as it happens (it is a notice, not a line of the log).
		expect(lines.some((line) => /No Auto Run folder configured for @Beta/.test(line))).toBe(true);
	});
});

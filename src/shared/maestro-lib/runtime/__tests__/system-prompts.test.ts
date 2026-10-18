/**
 * The Maestro system prompt of a headless group chat round and a headless consult, tested at the
 * port: the spawn description the runner is handed. Delivering it to the provider is the
 * launcher's job (`background-turns.ts`), so it is not asserted here.
 *
 * A participant and a consulted agent carry the system prompt of the stored agent they stand
 * for, the same text that agent's own chat turn carries; the moderator carries the enabled plugin
 * sections alone, as the desktop's `buildPluginSystemPromptSections` builds them.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createFakeGroupChatProvider,
	type FakeScript,
} from '../../../../__tests__/shared/maestro-lib/run/fakeGroupChatProvider';
import { providerFor } from '../../../../__tests__/shared/maestro-lib/turns/fixtures';
import { createAgentRepository } from '../../agents/repository';
import { DEFAULT_TAB_DEFAULTS } from '../../agents/rules';
import { createEventBus } from '../../client/event-bus';
import type { ClientResult } from '../../client/types';
import type { GroupChatSpawn } from '../../groupchat/types';
import { resolveMaestroPaths } from '../../paths/resolve';
import { loadAgentSystemPrompt, loadPluginSectionsSystemPrompt } from '../../turns/context';
import { toTurnAgent } from '../../turns/records';
import type { BackgroundTurns } from '../background-turns';
import { createRuntimeConsults, type RuntimeConsultInput } from '../consults';
import { createMaestroRuntime, type MaestroRuntime, type RuntimeDeps } from '../index';

/** Every spawn a group chat runner was handed, in order. */
const groupChatSpawns = vi.hoisted(() => [] as GroupChatSpawn[]);

// The runtime's real launcher, with its group chat runner watched: what the engine hands it is
// the port under test.
vi.mock('../background-turns', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../background-turns')>();
	return {
		...actual,
		createBackgroundTurns: (options: Parameters<typeof actual.createBackgroundTurns>[0]) => {
			const real = actual.createBackgroundTurns(options);
			return {
				...real,
				groupChatRunner: (handlers: Parameters<typeof real.groupChatRunner>[0]) => {
					const runner = real.groupChatRunner(handlers);
					return {
						start: (spawn: GroupChatSpawn) => {
							groupChatSpawns.push(spawn);
							return runner.start(spawn);
						},
						stop: (processId: string) => runner.stop(processId),
					};
				},
			};
		},
	};
});

const T0 = Date.parse('2026-10-04T12:00:00Z');
const BUNDLED_PROMPTS = path.resolve(__dirname, '../../../../prompts');
/** A line of the Concerto section, which is not local-only and needs no setup. */
const CONCERTO = fs.readFileSync(path.join(BUNDLED_PROMPTS, 'concerto-system.md'), 'utf-8').trim();
const CONCERTO_LINE = CONCERTO.split('\n')
	.find((line) => line.trim().length > 20)!
	.trim();

function value<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
	return result.value;
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

const ROUND: FakeScript = (call) => {
	switch (call.role) {
		case 'moderator':
			return { text: '@Alpha please look at this and report back.' };
		case 'participant':
			return { text: `${call.participant} says: looks good.` };
		case 'synthesis':
			return { text: 'Done.' };
		default:
			return { text: 'unexpected' };
	}
};

let dir: string;
let work: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-sysprompt-'));
	work = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-runtime-sysprompt-work-'));
	groupChatSpawns.length = 0;
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(work, { recursive: true, force: true });
});

function writeStores(sessions: unknown[], settings: Record<string, unknown>): void {
	fs.writeFileSync(
		path.join(dir, 'maestro-sessions.json'),
		JSON.stringify({ sessions, activeSessionId: sessions.length ? 'a1' : '' }, null, '\t')
	);
	fs.writeFileSync(path.join(dir, 'maestro-settings.json'), JSON.stringify(settings));
}

/** What a stored agent's own system prompt is, read the way its chat turn reads it. */
async function ownSystemPrompt(record: ReturnType<typeof agentRecord>): Promise<string> {
	const agent = toTurnAgent(record as never);
	if (!agent) throw new Error('no agent');
	const text = await loadAgentSystemPrompt(agent, {
		paths: resolveMaestroPaths({ env: { MAESTRO_USER_DATA: dir } }),
		bundledPromptsDir: BUNDLED_PROMPTS,
		now: () => new Date(T0),
	});
	if (!text) throw new Error('no system prompt');
	return text;
}

describe('a headless group chat round', () => {
	let open: MaestroRuntime[];

	beforeEach(() => {
		open = [];
	});
	afterEach(async () => {
		for (const runtime of open) await runtime.connection.close();
	});

	async function runRound(settings: Record<string, unknown>) {
		const sessions = [agentRecord('a1', 'Alpha', work), agentRecord('a2', 'Beta', work)];
		writeStores(sessions, settings);
		const provider = createFakeGroupChatProvider(work, ROUND);
		let id = 0;
		let tick = 1_000;
		const deps: Partial<RuntimeDeps> = {
			pid: 100,
			now: () => T0,
			bootTime: () => T0 - 3_600_000,
			isPidAlive: (pid) => pid === 100,
			hostname: () => 'testhost',
			rules: { newId: () => `id-${++id}`, now: () => ++tick, random: () => 0 },
			checkCwd: () => null,
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			watchDirectory: () => ({ close: () => undefined }),
			probeBinary: async (binaryName) => ({ exists: true, path: `/fake/bin/${binaryName}` }),
			background: { runTurn: provider.runTurn },
		};
		const started = await createMaestroRuntime({
			dataDir: dir,
			mode: 'tui',
			deps,
			turns: { bundledPromptsDir: BUNDLED_PROMPTS },
		});
		if (!started.ok) throw new Error(`refused: ${started.refusal.message}`);
		const runtime = started.runtime;
		open.push(runtime);

		let idle = 0;
		runtime.events.subscribe(
			(event) => {
				if (
					event.type === 'groupChat' &&
					event.event.kind === 'state' &&
					event.event.state === 'idle'
				) {
					idle += 1;
				}
			},
			{ types: ['groupChat'] }
		);
		value(
			await runtime.groupChats.create({ name: 'Review', participantIds: ['a1'], message: 'Go' })
		);
		await vi.waitFor(
			() => {
				if (idle < 1) throw new Error('room not idle yet');
			},
			{ timeout: 10_000, interval: 20 }
		);
		const participant = groupChatSpawns.find((spawn) => spawn.processId.includes('participant'));
		const moderators = groupChatSpawns.filter((spawn) => spawn !== participant);
		if (!participant) throw new Error('no participant turn ran');
		return { sessions, participant, moderators };
	}

	it("gives a participant its agent's own system prompt, and the moderator the plugin sections", async () => {
		const { sessions, participant, moderators } = await runRound({
			encoreFeatures: { concerto: true },
		});

		expect(participant.appendSystemPrompt).toBe(await ownSystemPrompt(sessions[0]));
		expect(participant.appendSystemPrompt).toContain('Alpha');
		expect(participant.appendSystemPrompt).toContain(CONCERTO_LINE);

		// The opening turn and the synthesis: no agent behind them, so the sections alone.
		expect(moderators.length).toBeGreaterThanOrEqual(2);
		const sections = loadPluginSectionsSystemPrompt(
			{
				paths: resolveMaestroPaths({ env: { MAESTRO_USER_DATA: dir } }),
				bundledPromptsDir: BUNDLED_PROMPTS,
			},
			{ isSsh: false }
		);
		expect(sections).toContain(CONCERTO_LINE);
		for (const spawn of moderators) expect(spawn.appendSystemPrompt).toBe(sections);
	});

	it('gives the moderator nothing while no plugin section applies', async () => {
		const { sessions, participant, moderators } = await runRound({});
		expect(participant.appendSystemPrompt).toBe(await ownSystemPrompt(sessions[0]));
		for (const spawn of moderators) expect(spawn.appendSystemPrompt).toBeUndefined();
	});
});

describe('a headless consult', () => {
	const SESSIONS = () => [
		agentRecord('a1', 'Alpha', work),
		agentRecord('a2', 'Beta', work, { isPianola: true }),
	];

	/** The consult runtime over a real repository and a runner that records what it is handed. */
	async function consults(settings: Record<string, unknown> = {}) {
		writeStores(SESSIONS(), settings);
		const paths = resolveMaestroPaths({ env: { MAESTRO_USER_DATA: dir } });
		let id = 0;
		const repository = createAgentRepository({
			paths,
			bus: createEventBus('[test]'),
			context: { newId: () => `id-${++id}`, now: () => T0, random: () => 0 },
			readTabDefaults: async () => DEFAULT_TAB_DEFAULTS,
			checkCwd: () => null,
		});
		const loaded = await repository.load();
		if (!loaded.ok) throw new Error(loaded.failure.message);

		const spawns: GroupChatSpawn[] = [];
		const background = {
			resolveAgent: async (providerId: string) => providerFor(providerId),
			sshStore: { getSshRemotes: () => [], getSshRemoteById: () => undefined },
			groupChatRunner: () => {
				throw new Error('not used');
			},
			consultRunner: () => ({
				start: async (
					spawn: GroupChatSpawn,
					observer: { onEnd(end: { exitCode: number; readText(): string }): void }
				) => {
					spawns.push(spawn);
					setImmediate(() => observer.onEnd({ exitCode: 0, readText: () => 'Noted.' }));
					return { success: true, pid: 4242 };
				},
				stop: () => '',
			}),
			activeCount: () => 0,
			registeredCount: () => 0,
		} as unknown as BackgroundTurns;

		const runtime = createRuntimeConsults({
			paths,
			repository,
			fence: () => ({ ok: true }),
			background,
			historyWriter: { append: async () => ({ ok: true }) as never },
			now: () => T0,
			options: { bundledPromptsDir: BUNDLED_PROMPTS },
		});
		const ask = async (input: RuntimeConsultInput) => {
			value(await runtime.api.ask(input));
			return spawns[spawns.length - 1];
		};
		return { ask, repository };
	}

	it('gives the consulted agent its own system prompt', async () => {
		const { ask } = await consults({ encoreFeatures: { concerto: true, pianola: true } });
		const spawn = await ask({ targetAgentId: 'a2', question: 'Which branch?', fromAgentId: 'a1' });
		expect(spawn.appendSystemPrompt).toBe(await ownSystemPrompt(SESSIONS()[1]));
		// Beta is the Pianola manager, so its role section rides along, then the plugin section.
		expect(spawn.appendSystemPrompt).toContain('Pianola');
		expect(spawn.appendSystemPrompt).toContain(CONCERTO_LINE);
	});

	it('is read-only unless consults were made writable', async () => {
		const readOnly = await consults();
		expect((await readOnly.ask({ targetAgentId: 'a2', question: 'Look' })).readOnlyMode).toBe(true);

		const writable = await consults({ crossAgentMentionsWritable: true });
		expect((await writable.ask({ targetAgentId: 'a2', question: 'Fix' })).readOnlyMode).toBe(false);
	});

	it('runs a hand-off: the answer is forwarded, and it may write unless hand-offs were made read-only', async () => {
		const byDefault = await consults();
		const handoff = await byDefault.ask({
			targetAgentId: 'a2',
			question: 'Look into MNQ, then send what you find to @Beta',
			fromAgentId: 'a1',
			handoffAnswer: 'MNQ is up 2% on the week.',
		});
		expect(handoff.prompt).toContain('MNQ is up 2% on the week.');
		expect(handoff.readOnlyMode).toBe(false);
		// The consult switch does not govern a hand-off.
		const consult = await byDefault.ask({ targetAgentId: 'a2', question: 'Plain question' });
		expect(consult.prompt).not.toContain('MNQ is up 2% on the week.');
		expect(consult.readOnlyMode).toBe(true);

		const optedOut = await consults({
			crossAgentHandoffsWritable: false,
			crossAgentMentionsWritable: true,
		});
		const readOnlyHandoff = await optedOut.ask({
			targetAgentId: 'a2',
			question: 'Then send it to @Beta',
			handoffAnswer: 'Findings.',
		});
		expect(readOnlyHandoff.readOnlyMode).toBe(true);
	});
});

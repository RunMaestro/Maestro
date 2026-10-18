/**
 * @file kanban-conductor.test.ts
 * @description Tests for Phase 06's conductor session creation and reach sync
 * inside `examples/plugins/maestro-kanban/main.js`: turning a board's stored
 * conductor configuration (`kanban-conductor-config.test.ts`) and its resolved
 * reach (`kanban-conductor-settings.test.ts`) into a running agent -
 * `createConductor()`'s README + `sessions.create` + initial `sessions.update`
 * sequence, and `syncConductorReach()`'s debounced keep-in-sync behavior once
 * a conductor exists.
 *
 * `conductorScratchDir()` is a pure export, called straight through.
 * `createConductor()`, `resolveConductorSessionId()`, and `syncConductorReach()`
 * call `sdk.sessions.create/get/update` and `sdk.fs.write`, so they are
 * exercised end to end through `activate()` plus the `create-conductor`,
 * `conductor-config`, and `request-access` commands the panel posts, mirroring
 * `kanban-conductor-settings.test.ts`'s approach.
 *
 * Every scenario here runs on the Global board (`selected-board:
 * plugin.GLOBAL_BOARD_ID`) rather than a project board, because a project
 * board only ever shows that one project's own cards - proving "an ungranted
 * card's project is left out" needs at least two distinct projects visible on
 * the same board at once, which only the Global board's aggregation gives.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mainPath = require.resolve('../../../examples/plugins/maestro-kanban/main.js');

interface ConductorPayload {
	boardId: string | null;
	conductorId: string | null;
	conductorExists: boolean;
	conductorConnected: boolean;
	providerSupportsDirectories: boolean | null;
	reach: {
		granted: { projectPath: string; name: string }[];
		ungranted: { projectPath: string; name: string; sessionId: string }[];
	};
}

interface KanbanConductor {
	activate: (maestro: unknown) => Promise<void>;
	GLOBAL_BOARD_ID: string;
	CONDUCTOR_SCRATCH_DIR: string;
	conductorScratchDir: (boardId: string) => string;
}

/** Fresh module state per test: main.js keeps its card/config/conductor-id
 * maps in module-level variables, so the require cache entry must be dropped
 * before every require(). Mirrors every other kanban-*.test.ts's loadMain(). */
function loadMain(): KanbanConductor {
	delete require.cache[mainPath];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(mainPath) as KanbanConductor;
}

interface StubOptions {
	storage?: Record<string, string>;
	sessionsList?: () => Promise<unknown>;
	tabsList?: () => Promise<unknown>;
	agentsList?: () => Promise<unknown>;
	sessionsRequestAccess?: (sessionId: string) => Promise<unknown>;
	sessionsCreate?: (params: unknown) => Promise<unknown>;
	sessionsGet?: (id: string) => Promise<unknown>;
	sessionsUpdate?: (id: string, patch: unknown) => Promise<unknown>;
}

/** An in-memory `maestro.storage`/stubbed `maestro.sessions`/`maestro.tabs`/
 * `maestro.agents`/`maestro.fs`, extended from kanban-conductor-settings.test.ts's
 * createStubMaestro() with `sessions.create/get/update` (this file's whole
 * point) and a captured `events.on` map so a test can emit the session
 * events the reach-sync triggers answer to. `sessions.create`'s default
 * mints a fresh id and remembers it as "exists" for a later `sessions.get`,
 * so a created conductor still resolves on the very next snapshot unless a
 * test overrides that to simulate the session disappearing. */
function createStubMaestro(options: StubOptions = {}) {
	const storageStore = new Map<string, string>(Object.entries(options.storage ?? {}));
	const commandHandlers = new Map<string, (args?: unknown) => unknown>();
	const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
	const existingSessionIds = new Set<string>();
	let createCounter = 0;

	const maestro = {
		events: {
			on: vi.fn((topic: string, handler: (payload: unknown) => void) => {
				let set = eventHandlers.get(topic);
				if (!set) {
					set = new Set();
					eventHandlers.set(topic, set);
				}
				set.add(handler);
			}),
			subscribe: vi.fn(() => Promise.resolve({ ok: true })),
			unsubscribe: vi.fn(() => Promise.resolve({ ok: true })),
		},
		commands: {
			register: vi.fn((commandId: string, handler: (args?: unknown) => unknown) => {
				commandHandlers.set(commandId, handler);
			}),
		},
		sessions: {
			list: vi.fn(options.sessionsList ?? (() => Promise.resolve([]))),
			focus: vi.fn(() => Promise.resolve({ ok: true })),
			requestAccess: vi.fn(
				options.sessionsRequestAccess ?? (() => Promise.resolve({ granted: true }))
			),
			create: vi.fn(
				options.sessionsCreate ??
					((params: Record<string, unknown>) => {
						createCounter += 1;
						const id = 'conductor-' + createCounter;
						existingSessionIds.add(id);
						return Promise.resolve({ id, ...params });
					})
			),
			get: vi.fn(
				options.sessionsGet ??
					((id: string) => Promise.resolve(existingSessionIds.has(id) ? { id } : null))
			),
			update: vi.fn(options.sessionsUpdate ?? (() => Promise.resolve({ ok: true }))),
		},
		agents: {
			dispatch: vi.fn(() => Promise.resolve({ ok: true })),
			list: vi.fn(options.agentsList ?? (() => Promise.resolve([]))),
		},
		tabs: {
			list: vi.fn(options.tabsList ?? (() => Promise.resolve([]))),
		},
		ui: {
			panelPost: vi.fn(() => Promise.resolve({ ok: true })),
			togglePanel: vi.fn(() => Promise.resolve({ ok: true })),
		},
		notifications: {
			toast: vi.fn(() => Promise.resolve({ ok: true })),
		},
		fs: {
			read: vi.fn(() => Promise.reject(new Error('ENOENT'))),
			write: vi.fn(() => Promise.resolve({ ok: true })),
		},
		storage: {
			get: vi.fn((key: string) =>
				Promise.resolve(storageStore.has(key) ? storageStore.get(key) : null)
			),
			set: vi.fn((key: string, value: string) => {
				storageStore.set(key, value);
				return Promise.resolve({ ok: true });
			}),
			delete: vi.fn((key: string) => {
				storageStore.delete(key);
				return Promise.resolve({ ok: true });
			}),
			keys: vi.fn(() => Promise.resolve(Array.from(storageStore.keys()))),
		},
	};

	return { maestro, storageStore, commandHandlers, eventHandlers, existingSessionIds };
}

function emit(
	eventHandlers: Map<string, Set<(payload: unknown) => void>>,
	topic: string,
	payload: unknown
) {
	const set = eventHandlers.get(topic);
	if (!set) return;
	for (const handler of set) handler(payload);
}

function aiTab(overrides: Record<string, unknown> = {}) {
	return {
		id: 'tab-1',
		sessionId: 'session-1',
		type: 'ai',
		title: 'My Tab',
		status: 'idle',
		createdAt: 1,
		...overrides,
	};
}

/** The conductor payload of the last panel push. */
function lastConductor(panelPost: { mock: { calls: unknown[][] } }): ConductorPayload | null {
	const calls = panelPost.mock.calls;
	if (calls.length === 0) return null;
	return (calls[calls.length - 1]![1] as { conductor?: ConductorPayload }).conductor ?? null;
}

describe('maestro-kanban conductorScratchDir', () => {
	it('always resolves under the plugin’s own scratch root, never inside userData', () => {
		const plugin = loadMain();
		const projectScratch = plugin.conductorScratchDir('/Users/dev/projects/widgets');
		const globalScratch = plugin.conductorScratchDir(plugin.GLOBAL_BOARD_ID);
		for (const scratch of [projectScratch, globalScratch]) {
			expect(scratch.startsWith(plugin.CONDUCTOR_SCRATCH_DIR + '/')).toBe(true);
			expect(scratch).not.toContain('userData');
		}
	});
});

describe('maestro-kanban createConductor', () => {
	const projectA = '/Users/dev/projects/widgets';
	const projectB = '/Users/dev/projects/gadgets';

	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** The Global board, with one card per project, so both are visible on the
	 * same board at once - a project board only ever shows its own cards. */
	function globalStub(plugin: KanbanConductor, extra: StubOptions = {}) {
		return createStubMaestro({
			storage: { 'selected-board': plugin.GLOBAL_BOARD_ID, ...(extra.storage ?? {}) },
			sessionsList:
				extra.sessionsList ??
				(() =>
					Promise.resolve([
						{ id: 'session-a', title: 'Widget Agent', projectPath: projectA },
						{ id: 'session-b', title: 'Gadget Agent', projectPath: projectB },
					])),
			tabsList:
				extra.tabsList ??
				(() =>
					Promise.resolve([
						aiTab({ id: 'tab-a', sessionId: 'session-a', projectPath: projectA }),
						aiTab({ id: 'tab-b', sessionId: 'session-b', projectPath: projectB }),
					])),
			agentsList: extra.agentsList,
		});
	}

	it('writes the README, creates the session with the configured provider/model/effort, and grants only the already-approved project', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = globalStub(plugin);
		await plugin.activate(maestro);

		// Project A's card is approved before the conductor exists, so its
		// project is already in reach the moment the conductor is created.
		// Project B's card is never approved.
		await commandHandlers.get('request-access')!({ sessionId: 'session-a' });
		await commandHandlers.get('conductor-config')!({
			boardId: plugin.GLOBAL_BOARD_ID,
			agentId: 'claude-code',
			customModel: 'opus',
			customEffort: 'high',
		});

		const result = (await commandHandlers.get('create-conductor')!({
			boardId: plugin.GLOBAL_BOARD_ID,
		})) as { ok: boolean; conductorId: string };
		expect(result.ok).toBe(true);
		expect(result.conductorId).toBeTruthy();

		// The README is the only file this plugin ever writes into the
		// scratch folder directly.
		expect(maestro.fs.write).toHaveBeenCalledTimes(1);
		const [readmePath, readmeText] = (maestro.fs.write as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, string];
		expect(readmePath).toBe(plugin.conductorScratchDir(plugin.GLOBAL_BOARD_ID) + '/README.md');
		expect(readmeText).toContain('scratch');

		expect(maestro.sessions.create).toHaveBeenCalledWith({
			agentId: 'claude-code',
			title: 'Conductor: Global',
			cwd: plugin.conductorScratchDir(plugin.GLOBAL_BOARD_ID),
			customModel: 'opus',
			customEffort: 'high',
		});

		// Only project A (already granted) rides the initial reach grant;
		// project B's session was never approved, so its project is left out
		// of the sessions.update() payload entirely.
		expect(maestro.sessions.update).toHaveBeenCalledTimes(1);
		expect(maestro.sessions.update).toHaveBeenCalledWith(result.conductorId, {
			additionalDirectories: [{ path: projectA, read: true, write: false }],
		});

		const snapshot = lastConductor(maestro.ui.panelPost)!;
		expect(snapshot.conductorId).toBe(result.conductorId);
		expect(snapshot.conductorExists).toBe(true);
		expect(snapshot.conductorConnected).toBe(true);
		expect(snapshot.reach.granted).toEqual([{ projectPath: projectA, name: 'widgets' }]);
		expect(snapshot.reach.ungranted).toEqual([
			{ projectPath: projectB, name: 'gadgets', sessionId: 'session-b' },
		]);
	});

	it('granting the previously-ungranted project triggers exactly one debounced sessions.update, folding a burst of triggers into one', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers, eventHandlers } = globalStub(plugin);
		await plugin.activate(maestro);
		await commandHandlers.get('request-access')!({ sessionId: 'session-a' });
		await commandHandlers.get('conductor-config')!({
			boardId: plugin.GLOBAL_BOARD_ID,
			agentId: 'claude-code',
		});
		await commandHandlers.get('create-conductor')!({ boardId: plugin.GLOBAL_BOARD_ID });
		expect(maestro.sessions.update).toHaveBeenCalledTimes(1);

		// Two triggers inside the same debounce window: approving project B's
		// session (a grantedSessions.add() call site) and an unrelated
		// session.activated re-affirming project A (a scheduleReachSync()
		// trigger in its own right) - both must fold into one update.
		await commandHandlers.get('request-access')!({ sessionId: 'session-b' });
		emit(eventHandlers, 'session.activated', { sessionId: 'session-a' });

		// Still debouncing: nothing has been pushed to the host yet.
		expect(maestro.sessions.update).toHaveBeenCalledTimes(1);

		// REACH_SYNC_DEBOUNCE_MS (400ms in main.js) plus margin.
		await vi.advanceTimersByTimeAsync(450);

		expect(maestro.sessions.update).toHaveBeenCalledTimes(2);
		const lastCall = (maestro.sessions.update as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [
			string,
			{ additionalDirectories: { path: string; read: boolean; write: boolean }[] },
		];
		const paths = lastCall[1].additionalDirectories.map((entry) => entry.path).sort();
		expect(paths).toEqual([projectA, projectB].sort());

		const reach = lastConductor(maestro.ui.panelPost)!.reach;
		expect(reach.ungranted).toEqual([]);
		expect(reach.granted.map((entry) => entry.projectPath).sort()).toEqual(
			[projectA, projectB].sort()
		);
	});

	it('sends no update when the granted set has not actually changed since the last sync', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers, eventHandlers } = globalStub(plugin);
		await plugin.activate(maestro);
		await commandHandlers.get('request-access')!({ sessionId: 'session-a' });
		await commandHandlers.get('conductor-config')!({
			boardId: plugin.GLOBAL_BOARD_ID,
			agentId: 'claude-code',
		});
		await commandHandlers.get('create-conductor')!({ boardId: plugin.GLOBAL_BOARD_ID });
		expect(maestro.sessions.update).toHaveBeenCalledTimes(1);

		// Nothing about the granted set changed; re-affirming the same
		// session must not push a redundant sessions.update().
		emit(eventHandlers, 'session.activated', { sessionId: 'session-a' });
		await vi.advanceTimersByTimeAsync(450);

		expect(maestro.sessions.update).toHaveBeenCalledTimes(1);
	});

	it('treats a stored conductor id whose session no longer resolves as no conductor, not an error', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = globalStub(plugin);
		await plugin.activate(maestro);
		await commandHandlers.get('conductor-config')!({
			boardId: plugin.GLOBAL_BOARD_ID,
			agentId: 'claude-code',
		});
		await commandHandlers.get('create-conductor')!({ boardId: plugin.GLOBAL_BOARD_ID });
		expect(lastConductor(maestro.ui.panelPost)!.conductorExists).toBe(true);

		// The session is gone - deleted outside this plugin's knowledge.
		(maestro.sessions.get as ReturnType<typeof vi.fn>).mockImplementation(() =>
			Promise.resolve(null)
		);
		await commandHandlers.get('conductor-config')!({
			boardId: plugin.GLOBAL_BOARD_ID,
			customModel: 'sonnet',
		});

		const snapshot = lastConductor(maestro.ui.panelPost)!;
		expect(snapshot.conductorId).toBeNull();
		expect(snapshot.conductorExists).toBe(false);
		expect(snapshot.conductorConnected).toBe(false);
	});

	it('still creates and grants a provider with no native add-directory support, but the snapshot surfaces the degraded state', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro({
			storage: { 'selected-board': plugin.GLOBAL_BOARD_ID },
			sessionsList: () =>
				Promise.resolve([{ id: 'session-a', title: 'Widget Agent', projectPath: projectA }]),
			tabsList: () =>
				Promise.resolve([aiTab({ id: 'tab-a', sessionId: 'session-a', projectPath: projectA })]),
			agentsList: () =>
				Promise.resolve([{ id: 'a1', toolType: 'grok', supportsAdditionalDirectories: false }]),
		});
		await plugin.activate(maestro);
		await commandHandlers.get('request-access')!({ sessionId: 'session-a' });
		await commandHandlers.get('conductor-config')!({
			boardId: plugin.GLOBAL_BOARD_ID,
			agentId: 'grok',
		});

		const result = (await commandHandlers.get('create-conductor')!({
			boardId: plugin.GLOBAL_BOARD_ID,
		})) as { ok: boolean };
		expect(result.ok).toBe(true);

		// The directory grant is still sent - the host just has nowhere to put
		// it for this provider; this is the settings surface's cue, not a
		// behavior change.
		expect(maestro.sessions.update).toHaveBeenCalledWith(expect.any(String), {
			additionalDirectories: [{ path: projectA, read: true, write: false }],
		});

		expect(lastConductor(maestro.ui.panelPost)!.providerSupportsDirectories).toBe(false);
	});
});

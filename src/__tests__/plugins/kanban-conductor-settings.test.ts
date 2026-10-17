/**
 * @file kanban-conductor-settings.test.ts
 * @description Tests for Phase 06's conductor settings surface inside
 * `examples/plugins/maestro-kanban/main.js`: the panel section that lets a
 * user pick a provider from `agents.list()`, set a model and effort, and see
 * this board's resolved reach (which granted project roots a conductor would
 * receive, and which of its projects still need an "Allow Access" click).
 *
 * This is still the stored choice plus a read-only view of live state - none
 * of these tests ever call the `create-conductor` command, so no board here
 * has a stored conductor id and `conductorExists`/`conductorConnected` read
 * false on every snapshot the same way they would for a board nobody has
 * created a conductor for yet. Actually creating one (writing the README,
 * `sessions.create`, the initial `sessions.update` reach grant, and the
 * "conductor not connected" state after a revoke) is covered separately by
 * `kanban-conductor.test.ts`.
 *
 * `conductorConfigPatchFrom()` is a pure export, called straight through.
 * `conductorProviderOptions()`, `conductorReachForBoard()`,
 * `conductorSettingsSnapshot()` and `applyConductorConfig()` read live
 * runtime state and call `sdk.agents.list()` / `sdk.storage`, so they are
 * exercised end to end through `activate()` plus the `conductor-config` and
 * `request-access` commands the panel posts, mirroring
 * `kanban-aging.test.ts`'s board settings surface tests.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mainPath = require.resolve('../../../examples/plugins/maestro-kanban/main.js');

interface ConductorConfig {
	agentId: string | null;
	customModel: string | null;
	customEffort: string | null;
}

interface ConductorProvider {
	toolType: string;
	supportsAdditionalDirectories: boolean;
}

interface ConductorReachEntry {
	projectPath: string;
	name: string;
	sessionId?: string;
}

interface ConductorPayload {
	boardId: string | null;
	boardName: string;
	config: ConductorConfig;
	providers: ConductorProvider[];
	providerSupportsDirectories: boolean | null;
	reach: {
		granted: ConductorReachEntry[];
		grantedHidden: number;
		ungranted: ConductorReachEntry[];
		ungrantedHidden: number;
	};
	conductorId: string | null;
	conductorExists: boolean;
	conductorConnected: boolean;
}

interface KanbanConductorSettings {
	activate: (maestro: unknown) => Promise<void>;
	CONDUCTOR_REACH_LIMIT: number;
	conductorConfigPatchFrom: (source: Record<string, unknown>) => Partial<ConductorConfig>;
	conductorProviderSupportsDirectories: (
		providers: ConductorProvider[],
		agentId: string | null
	) => boolean | null;
}

/** Fresh module state per test: main.js keeps its card and config maps in
 * module-level variables, so the require cache entry must be dropped before
 * every require(). Mirrors kanban-aging.test.ts's loadMain(). */
function loadMain(): KanbanConductorSettings {
	delete require.cache[mainPath];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(mainPath) as KanbanConductorSettings;
}

interface StubOptions {
	storage?: Record<string, string>;
	tabsList?: () => Promise<unknown>;
	sessionsList?: () => Promise<unknown>;
	agentsList?: () => Promise<unknown>;
	sessionsRequestAccess?: (sessionId: string) => Promise<unknown>;
}

/** An in-memory `maestro.storage`/stubbed `maestro.sessions`/`maestro.tabs`/
 * `maestro.agents`, trimmed to what the conductor settings surface reads.
 * Mirrors kanban-aging.test.ts's createStubMaestro(). */
function createStubMaestro(options: StubOptions = {}) {
	const storageStore = new Map<string, string>(Object.entries(options.storage ?? {}));
	const commandHandlers = new Map<string, (args?: unknown) => unknown>();

	const maestro = {
		events: {
			on: vi.fn(),
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

	return { maestro, storageStore, commandHandlers };
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

describe('maestro-kanban conductorConfigPatchFrom', () => {
	it('keeps an absent field absent, so one control never restates the other two', () => {
		const plugin = loadMain();
		expect(plugin.conductorConfigPatchFrom({ agentId: 'claude-code' })).toEqual({
			agentId: 'claude-code',
		});
		expect(plugin.conductorConfigPatchFrom({})).toEqual({});
	});

	it('passes a given value through as-is, leaving the coercion to normalizeConductorConfig', () => {
		const plugin = loadMain();
		expect(
			plugin.conductorConfigPatchFrom({ agentId: '  codex  ', customModel: null, customEffort: 42 })
		).toEqual({ agentId: '  codex  ', customModel: null, customEffort: 42 });
	});
});

describe('maestro-kanban conductorProviderSupportsDirectories', () => {
	const providers: ConductorProvider[] = [
		{ toolType: 'claude-code', supportsAdditionalDirectories: true },
		{ toolType: 'grok', supportsAdditionalDirectories: false },
	];

	it('is null when no provider is configured yet', () => {
		const plugin = loadMain();
		expect(plugin.conductorProviderSupportsDirectories(providers, null)).toBeNull();
	});

	it('is true for a configured provider that natively supports added directories', () => {
		const plugin = loadMain();
		expect(plugin.conductorProviderSupportsDirectories(providers, 'claude-code')).toBe(true);
	});

	it('is false for a configured provider with no native add-directory support', () => {
		const plugin = loadMain();
		expect(plugin.conductorProviderSupportsDirectories(providers, 'grok')).toBe(false);
	});

	it('is null for a configured provider no longer in the running agents.list, rather than guessed', () => {
		const plugin = loadMain();
		expect(plugin.conductorProviderSupportsDirectories(providers, 'codex')).toBeNull();
	});
});

describe('maestro-kanban conductor settings surface', () => {
	const projectPath = '/Users/dev/projects/widgets';

	/** One board selected and one card on it, so `currentBoardId()` has an
	 * answer and the surface has something to configure. Mirrors
	 * kanban-aging.test.ts's settingsStub(). */
	function conductorStub(extra: StubOptions = {}) {
		return createStubMaestro({
			storage: { 'selected-board': projectPath, ...(extra.storage ?? {}) },
			sessionsList:
				extra.sessionsList ??
				(() => Promise.resolve([{ id: 'session-1', title: 'Widget Agent', projectPath }])),
			tabsList: extra.tabsList ?? (() => Promise.resolve([aiTab({ projectPath })])),
			agentsList: extra.agentsList,
			sessionsRequestAccess: extra.sessionsRequestAccess,
		});
	}

	it('rides the config, provider list, and resolved reach on every snapshot', async () => {
		const plugin = loadMain();
		const { maestro } = conductorStub({
			agentsList: () =>
				Promise.resolve([
					{
						id: 'agent-1',
						name: 'Claude',
						toolType: 'claude-code',
						supportsAdditionalDirectories: true,
					},
				]),
		});

		await plugin.activate(maestro);

		expect(lastConductor(maestro.ui.panelPost)).toEqual({
			boardId: projectPath,
			boardName: 'widgets',
			config: { agentId: null, customModel: null, customEffort: null },
			providers: [{ toolType: 'claude-code', supportsAdditionalDirectories: true }],
			// No provider is configured on this board yet, so there is nothing
			// to say about its directory support.
			providerSupportsDirectories: null,
			reach: {
				granted: [],
				grantedHidden: 0,
				// The stub's one card is never granted, so this board's only
				// project starts out needing an "Allow Access" click.
				ungranted: [{ projectPath, name: 'widgets', sessionId: 'session-1' }],
				ungrantedHidden: 0,
			},
			// No `create-conductor` call happened in this test, so this board
			// has no stored conductor id at all.
			conductorId: null,
			conductorExists: false,
			conductorConnected: false,
		});
	});

	it('offers one entry per distinct toolType, sorted, deduplicated across several agents', async () => {
		const plugin = loadMain();
		const { maestro } = conductorStub({
			agentsList: () =>
				Promise.resolve([
					{ id: 'a1', toolType: 'codex', supportsAdditionalDirectories: true },
					{ id: 'a2', toolType: 'claude-code', supportsAdditionalDirectories: true },
					{ id: 'a3', toolType: 'codex', supportsAdditionalDirectories: true },
					{ id: 'a4', toolType: 'grok' }, // supportsAdditionalDirectories omitted
					{ id: 'a5' }, // no toolType at all
				]),
		});

		await plugin.activate(maestro);

		expect(lastConductor(maestro.ui.panelPost)!.providers).toEqual([
			{ toolType: 'claude-code', supportsAdditionalDirectories: true },
			{ toolType: 'codex', supportsAdditionalDirectories: true },
			{ toolType: 'grok', supportsAdditionalDirectories: false },
		]);
	});

	it('reports providerSupportsDirectories for the configured provider once one is picked', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = conductorStub({
			agentsList: () =>
				Promise.resolve([
					{ id: 'a1', toolType: 'claude-code', supportsAdditionalDirectories: true },
					{ id: 'a2', toolType: 'grok', supportsAdditionalDirectories: false },
				]),
		});
		await plugin.activate(maestro);

		await commandHandlers.get('conductor-config')!({ boardId: projectPath, agentId: 'grok' });
		expect(lastConductor(maestro.ui.panelPost)!.providerSupportsDirectories).toBe(false);

		await commandHandlers.get('conductor-config')!({
			boardId: projectPath,
			agentId: 'claude-code',
		});
		expect(lastConductor(maestro.ui.panelPost)!.providerSupportsDirectories).toBe(true);
	});

	it('degrades to no providers when agents.list rejects, without breaking the rest of the snapshot', async () => {
		const plugin = loadMain();
		const { maestro } = conductorStub({
			agentsList: () => Promise.reject(new Error('boom')),
		});

		await plugin.activate(maestro);

		const conductor = lastConductor(maestro.ui.panelPost)!;
		expect(conductor.providers).toEqual([]);
		expect(conductor.boardId).toBe(projectPath);
	});

	it("lists a project under ungranted, with one card's session as the representative to approve", async () => {
		const plugin = loadMain();
		const { maestro } = conductorStub();

		await plugin.activate(maestro);

		const reach = lastConductor(maestro.ui.panelPost)!.reach;
		expect(reach.granted).toEqual([]);
		expect(reach.ungranted).toEqual([{ projectPath, name: 'widgets', sessionId: 'session-1' }]);
	});

	it('moves a project from ungranted to granted once its session is approved, with no new sessionId needed', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = conductorStub();
		await plugin.activate(maestro);

		await commandHandlers.get('request-access')!({ sessionId: 'session-1' });

		const reach = lastConductor(maestro.ui.panelPost)!.reach;
		expect(reach.ungranted).toEqual([]);
		expect(reach.granted).toEqual([{ projectPath, name: 'widgets' }]);
	});

	it('grants a whole project from just one of its several cards', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = conductorStub({
			sessionsList: () =>
				Promise.resolve([
					{ id: 'session-1', title: 'First', projectPath },
					{ id: 'session-2', title: 'Second', projectPath },
				]),
			tabsList: () =>
				Promise.resolve([
					aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath }),
					aiTab({ id: 'tab-2', sessionId: 'session-2', projectPath }),
				]),
		});
		await plugin.activate(maestro);
		expect(lastConductor(maestro.ui.panelPost)!.reach.ungranted).toHaveLength(1);

		// Only session-2 is approved; session-1 is never asked about.
		await commandHandlers.get('request-access')!({ sessionId: 'session-2' });

		const reach = lastConductor(maestro.ui.panelPost)!.reach;
		expect(reach.ungranted).toEqual([]);
		expect(reach.granted).toEqual([{ projectPath, name: 'widgets' }]);
	});

	it('caps each reach list and reports how many projects it is not showing', async () => {
		const plugin = loadMain();
		const total = plugin.CONDUCTOR_REACH_LIMIT + 5;
		const sessions = Array.from({ length: total }, (_, i) => ({
			id: 'session-' + i,
			title: 'Agent ' + i,
			projectPath: '/Users/dev/projects/p' + i,
		}));
		const tabs = sessions.map((s, i) =>
			aiTab({ id: 'tab-' + i, sessionId: s.id, projectPath: s.projectPath })
		);
		const { maestro } = createStubMaestro({
			// The unnamed pre-activation board shows every card, which is the
			// scenario that actually needs a cap (see CONDUCTOR_REACH_LIMIT).
			sessionsList: () => Promise.resolve(sessions),
			tabsList: () => Promise.resolve(tabs),
		});

		await plugin.activate(maestro);

		const reach = lastConductor(maestro.ui.panelPost)!.reach;
		expect(reach.ungranted).toHaveLength(plugin.CONDUCTOR_REACH_LIMIT);
		expect(reach.ungrantedHidden).toBe(5);
		expect(reach.granted).toEqual([]);
		expect(reach.grantedHidden).toBe(0);
	});

	it('persists the provider, model, and effort, and repaints in the same push', async () => {
		const plugin = loadMain();
		const { maestro, storageStore, commandHandlers } = conductorStub();
		await plugin.activate(maestro);
		const pushesBefore = maestro.ui.panelPost.mock.calls.length;

		const result = (await commandHandlers.get('conductor-config')!({
			boardId: projectPath,
			agentId: 'claude-code',
			customModel: 'opus',
		})) as { ok: boolean; config: ConductorConfig };

		expect(result.ok).toBe(true);
		expect(result.config).toEqual({
			agentId: 'claude-code',
			customModel: 'opus',
			customEffort: null,
		});
		expect(JSON.parse(storageStore.get('conductor-config') as string)).toEqual({
			[projectPath]: { agentId: 'claude-code', customModel: 'opus', customEffort: null },
		});
		// Every accepted change pushes a fresh snapshot, the same as
		// board-settings - this is what shows the saved choice right away.
		expect(maestro.ui.panelPost.mock.calls.length).toBe(pushesBefore + 1);
		expect(lastConductor(maestro.ui.panelPost)!.config.customModel).toBe('opus');
	});

	it('refuses a post aimed at a board the user has switched away from', async () => {
		const plugin = loadMain();
		const { maestro, storageStore, commandHandlers } = conductorStub();
		await plugin.activate(maestro);

		const result = (await commandHandlers.get('conductor-config')!({
			boardId: '/Users/dev/projects/other',
			agentId: 'codex',
		})) as { ok: boolean; reason: string };

		expect(result.ok).toBe(false);
		expect(result.reason).toContain('the board changed');
		expect(maestro.notifications.toast).toHaveBeenCalled();
		expect(storageStore.get('conductor-config')).toBeUndefined();
	});

	it('refuses a post with no board and one that names no setting it understands', async () => {
		const plugin = loadMain();
		const { maestro, storageStore, commandHandlers } = conductorStub();
		await plugin.activate(maestro);
		const conductorConfig = commandHandlers.get('conductor-config')!;

		const noBoard = (await conductorConfig({ agentId: 'codex' })) as {
			ok: boolean;
			reason: string;
		};
		expect(noBoard.ok).toBe(false);
		expect(noBoard.reason).toContain('no board on screen');

		const nothing = (await conductorConfig({ boardId: projectPath, somethingElse: true })) as {
			ok: boolean;
			reason: string;
		};
		expect(nothing.ok).toBe(false);
		expect(nothing.reason).toContain('no setting');
		expect(storageStore.get('conductor-config')).toBeUndefined();
	});

	it('keeps a conductor configuration change across a restart', async () => {
		const first = loadMain();
		const { maestro, storageStore, commandHandlers } = conductorStub();
		await first.activate(maestro);
		await commandHandlers.get('conductor-config')!({
			boardId: projectPath,
			agentId: 'claude-code',
			customEffort: 'high',
		});

		const second = loadMain();
		const next = createStubMaestro({ storage: Object.fromEntries(storageStore) });
		await second.activate(next.maestro);

		expect(lastConductor(next.maestro.ui.panelPost)).toMatchObject({
			config: { agentId: 'claude-code', customModel: null, customEffort: 'high' },
		});
	});
});

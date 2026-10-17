/**
 * @file kanban-main.test.ts
 * @description Tests for `examples/plugins/maestro-kanban/main.js`, the
 * sandbox entry. `examples/plugins/agent-flow/` (the template this suite was
 * supposed to be modeled on) does not exist in this checkout, so this harness
 * loads `main.js` as a plain CommonJS module via `createRequire` and drives
 * it with a hand-built stub `maestro` SDK that mirrors the method shapes in
 * `buildSdk()` (`src/main/plugins/plugin-sandbox-entry.ts`), rather than the
 * full JSON-RPC sandbox realm used by `transcription-service.test.ts`. The
 * real sandbox only changes how `maestro.*` calls are transported (RPC vs.
 * direct call); `main.js` only ever calls methods, which is all this harness
 * needs to exercise.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mainPath = require.resolve('../../../examples/plugins/maestro-kanban/main.js');

/** Fresh module state per test: main.js keeps its card model in module-level
 * variables, so the cache entry must be dropped before every require(). */
function loadMain() {
	delete require.cache[mainPath];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(mainPath);
}

interface StubOverrides {
	sessionsList?: () => Promise<unknown>;
	tabsList?: () => Promise<unknown>;
	sessionsFocus?: (sessionId: string, tabId?: string) => Promise<unknown>;
}

function createStubMaestro(overrides: StubOverrides = {}) {
	const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
	const commandHandlers = new Map<string, (args?: unknown) => unknown>();

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
			list: vi.fn(overrides.sessionsList ?? (() => Promise.resolve([]))),
			focus: vi.fn(overrides.sessionsFocus ?? (() => Promise.resolve({ ok: true }))),
		},
		tabs: {
			list: vi.fn(overrides.tabsList ?? (() => Promise.resolve([]))),
		},
		ui: {
			panelPost: vi.fn(() => Promise.resolve({ ok: true })),
			togglePanel: vi.fn(() => Promise.resolve({ ok: true })),
		},
		notifications: {
			toast: vi.fn(() => Promise.resolve({ ok: true })),
		},
		// No test in this file exercises a real board or placement file; a
		// missing file / empty store is enough to keep every card on its
		// deriveColumn() landing spot, same as before placement persistence
		// existed. See kanban-persistence.test.ts for the storage-backed cases.
		fs: {
			read: vi.fn(() => Promise.reject(new Error('ENOENT: no such file or directory'))),
			write: vi.fn(() => Promise.resolve({ ok: true })),
		},
		storage: {
			get: vi.fn(() => Promise.resolve(null)),
			set: vi.fn(() => Promise.resolve({ ok: true })),
			delete: vi.fn(() => Promise.resolve({ ok: true })),
			keys: vi.fn(() => Promise.resolve([])),
		},
	};

	return { maestro, eventHandlers, commandHandlers };
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

function findCard(snapshot: { columns: { id: string; cards: { key: string }[] }[] }, key: string) {
	for (const column of snapshot.columns) {
		const card = column.cards.find((c) => c.key === key);
		if (card) return { card, columnId: column.id };
	}
	return undefined;
}

describe('maestro-kanban main.js', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('builds one card per AI tab and zero cards for terminal tabs', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro({
			tabsList: () =>
				Promise.resolve([
					aiTab({ id: 'tab-1', sessionId: 'session-1' }),
					aiTab({ id: 'tab-2', sessionId: 'session-2' }),
					{ id: 'term-1', sessionId: 'session-1', type: 'terminal', status: 'idle' },
				]),
		});

		await plugin.activate(maestro);

		expect(maestro.ui.panelPost).toHaveBeenCalledTimes(1);
		const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as {
			columns: { id: string; cards: { key: string }[] }[];
		};
		const allCards = snapshot.columns.flatMap((c) => c.cards);
		expect(allCards).toHaveLength(2);
		expect(allCards.map((c) => c.key).sort()).toEqual(['session-1::tab-1', 'session-2::tab-2']);
	});

	it('maps live, error, and idle tab statuses to the expected columns', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro({
			tabsList: () =>
				Promise.resolve([
					aiTab({ id: 'tab-busy', sessionId: 'session-1', status: 'busy' }),
					aiTab({ id: 'tab-error', sessionId: 'session-2', status: 'error' }),
					aiTab({ id: 'tab-idle', sessionId: 'session-3', status: 'idle' }),
				]),
		});

		await plugin.activate(maestro);

		const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as {
			columns: { id: string; cards: { key: string }[] }[];
		};
		expect(findCard(snapshot, 'session-1::tab-busy')?.columnId).toBe('in-progress');
		expect(findCard(snapshot, 'session-2::tab-error')?.columnId).toBe('blocked');
		expect(findCard(snapshot, 'session-3::tab-idle')?.columnId).toBe('backlog');
	});

	it("drops a removed session's cards on session.removed", async () => {
		const plugin = loadMain();
		const { maestro, eventHandlers } = createStubMaestro({
			tabsList: () =>
				Promise.resolve([
					aiTab({ id: 'tab-1', sessionId: 'session-1' }),
					aiTab({ id: 'tab-2', sessionId: 'session-2' }),
				]),
		});

		await plugin.activate(maestro);
		maestro.ui.panelPost.mockClear();

		emit(eventHandlers, 'session.removed', { sessionId: 'session-1' });
		await vi.advanceTimersByTimeAsync(50);

		expect(maestro.ui.panelPost).toHaveBeenCalledTimes(1);
		const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as {
			columns: { id: string; cards: { key: string }[] }[];
		};
		const allCards = snapshot.columns.flatMap((c) => c.cards);
		expect(allCards.map((c) => c.key)).toEqual(['session-2::tab-2']);
		// session.removed never triggers a tabs.list() re-read.
		expect(maestro.tabs.list).toHaveBeenCalledTimes(1);
	});

	it('coalesces a burst of agent.statusChanged events into one tabs.list re-read and one panelPost', async () => {
		const plugin = loadMain();
		let status = 'idle';
		const { maestro, eventHandlers } = createStubMaestro({
			tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1', status })]),
		});

		await plugin.activate(maestro);
		maestro.ui.panelPost.mockClear();
		maestro.tabs.list.mockClear();
		status = 'busy';

		// agent.statusChanged carries the session id in `tabId`, per the host
		// facts this plugin is built against.
		emit(eventHandlers, 'agent.statusChanged', {
			agentId: 'claude-code',
			tabId: 'session-1',
			status: 'busy',
		});
		emit(eventHandlers, 'agent.statusChanged', {
			agentId: 'claude-code',
			tabId: 'session-1',
			status: 'busy',
		});
		emit(eventHandlers, 'agent.statusChanged', {
			agentId: 'claude-code',
			tabId: 'session-1',
			status: 'busy',
		});

		await vi.advanceTimersByTimeAsync(150 + 50);

		expect(maestro.tabs.list).toHaveBeenCalledTimes(1);
		expect(maestro.ui.panelPost).toHaveBeenCalledTimes(1);
		const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as {
			columns: { id: string; cards: { key: string }[] }[];
		};
		expect(findCard(snapshot, 'session-1::tab-1')?.columnId).toBe('in-progress');
	});

	it('reaches sessions.focus with the right (sessionId, tabId) from the panel focus command', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro();

		await plugin.activate(maestro);

		const focus = commandHandlers.get('focus');
		expect(focus).toBeTypeOf('function');
		await focus!({ sessionId: 'session-9', tabId: 'tab-9' });

		expect(maestro.sessions.focus).toHaveBeenCalledWith('session-9', 'tab-9');
	});

	it('does not throw out of activate when tabs.list is rejected', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro({
			tabsList: () => Promise.reject(new Error('RPC down')),
		});

		await expect(plugin.activate(maestro)).resolves.toBeUndefined();
	});

	it('trims an oversized model to a snapshot under the 64 KB panel budget', async () => {
		const plugin = loadMain();
		const manyTabs = Array.from({ length: 2000 }, (_, i) =>
			aiTab({
				id: 'tab-' + i,
				sessionId: 'session-' + i,
				title: 'A reasonably long tab title for session number ' + i,
				projectPath: '/Users/someone/projects/a-fairly-long-project-path-' + i,
				createdAt: i,
			})
		);
		const { maestro } = createStubMaestro({
			tabsList: () => Promise.resolve(manyTabs),
		});

		await plugin.activate(maestro);

		expect(maestro.ui.panelPost).toHaveBeenCalledTimes(1);
		const snapshot = maestro.ui.panelPost.mock.calls[0]![1];
		expect(JSON.stringify(snapshot).length).toBeLessThan(64 * 1024);
		expect(maestro.notifications.toast).toHaveBeenCalledTimes(1);
	});
});

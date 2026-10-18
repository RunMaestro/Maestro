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
	sessionsRequestAccess?: (sessionId: string) => Promise<unknown>;
	transcriptsRead?: (params: unknown) => Promise<unknown>;
	agentsList?: () => Promise<unknown>;
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
			requestAccess: vi.fn(
				overrides.sessionsRequestAccess ?? (() => Promise.resolve({ granted: true }))
			),
		},
		tabs: {
			list: vi.fn(overrides.tabsList ?? (() => Promise.resolve([]))),
		},
		transcripts: {
			read: vi.fn(overrides.transcriptsRead ?? (() => Promise.resolve([]))),
		},
		// The conductor settings surface reads this on every snapshot (see
		// conductorProviderOptions() in main.js); no test here exercises the
		// provider picker itself, so an empty list is enough to keep it out of
		// the way, same as the other no-op defaults above.
		agents: {
			list: vi.fn(overrides.agentsList ?? (() => Promise.resolve([]))),
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

	it('every card starts out not access-granted, before anything asks for access', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro({
			tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
		});

		await plugin.activate(maestro);

		const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as {
			columns: { id: string; cards: { key: string; accessGranted: boolean }[] }[];
		};
		expect(findCard(snapshot, 'session-1::tab-1')?.card.accessGranted).toBe(false);
	});

	it('an approved request-access grants the session and the next snapshot reflects it', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro({
			tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			sessionsRequestAccess: () => Promise.resolve({ granted: true }),
		});

		await plugin.activate(maestro);
		maestro.ui.panelPost.mockClear();

		const requestAccess = commandHandlers.get('request-access');
		expect(requestAccess).toBeTypeOf('function');
		const result = await requestAccess!({ sessionId: 'session-1' });

		expect(maestro.sessions.requestAccess).toHaveBeenCalledWith('session-1');
		expect(result).toEqual({ ok: true, granted: true });
		// A fresh snapshot is pushed off the back of the approval, with no
		// re-click needed to clear the card's "not connected" marker.
		expect(maestro.ui.panelPost).toHaveBeenCalledTimes(1);
		const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as {
			columns: { id: string; cards: { key: string; accessGranted: boolean }[] }[];
		};
		expect(findCard(snapshot, 'session-1::tab-1')?.card.accessGranted).toBe(true);
	});

	it('a declined request-access leaves the card ungranted and pushes no false grant', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro({
			tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			sessionsRequestAccess: () => Promise.resolve({ granted: false }),
		});

		await plugin.activate(maestro);

		const requestAccess = commandHandlers.get('request-access');
		const result = await requestAccess!({ sessionId: 'session-1' });

		expect(result).toEqual({ ok: true, granted: false });
		const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
			columns: { id: string; cards: { key: string; accessGranted: boolean }[] }[];
		};
		expect(findCard(snapshot, 'session-1::tab-1')?.card.accessGranted).toBe(false);
	});

	it('a rejected sessions.requestAccess call is reported rather than thrown, and grants nothing', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro({
			tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			sessionsRequestAccess: () => Promise.reject(new Error('rate limited')),
		});

		await plugin.activate(maestro);

		const requestAccess = commandHandlers.get('request-access');
		const result = await requestAccess!({ sessionId: 'session-1' });

		expect(result).toEqual({ ok: false, granted: false });
		const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
			columns: { id: string; cards: { key: string; accessGranted: boolean }[] }[];
		};
		expect(findCard(snapshot, 'session-1::tab-1')?.card.accessGranted).toBe(false);
	});

	it('request-access with no sessionId is a no-op', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro();

		await plugin.activate(maestro);

		const requestAccess = commandHandlers.get('request-access');
		const result = await requestAccess!({});

		expect(result).toEqual({ ok: false, granted: false });
		expect(maestro.sessions.requestAccess).not.toHaveBeenCalled();
	});

	// Phase 04 card notes: a description and a comment thread, stored in
	// plugin storage keyed by card key via the `card-note` command. Unlike
	// request-access, these never touch grantedSessions - they are this
	// plugin's own data and work identically on a granted or ungranted card.
	describe('card-note command', () => {
		it('every card starts with an empty description and no comments', async () => {
			const plugin = loadMain();
			const { maestro } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});

			await plugin.activate(maestro);

			const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as {
				columns: {
					id: string;
					cards: { key: string; description: string; comments: unknown[]; lastCommentAt: null }[];
				}[];
			};
			const card = findCard(snapshot, 'session-1::tab-1')?.card;
			expect(card?.description).toBe('');
			expect(card?.comments).toEqual([]);
			expect(card?.lastCommentAt).toBeNull();
		});

		it('writes a description, persists it, and the next snapshot reflects it', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});

			await plugin.activate(maestro);
			maestro.ui.panelPost.mockClear();

			const cardNote = commandHandlers.get('card-note');
			expect(cardNote).toBeTypeOf('function');
			const result = await cardNote!({
				cardKey: 'session-1::tab-1',
				action: 'description',
				description: 'Needs a follow-up PR.',
			});

			expect(result).toEqual({ ok: true });
			expect(maestro.storage.set).toHaveBeenCalledWith(
				'card-notes',
				JSON.stringify({
					'session-1::tab-1': {
						description: 'Needs a follow-up PR.',
						comments: [],
						lastCommentAt: null,
					},
				})
			);
			// Pushed with no re-click needed to see the save land.
			expect(maestro.ui.panelPost).toHaveBeenCalledTimes(1);
			const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as {
				columns: { id: string; cards: { key: string; description: string }[] }[];
			};
			expect(findCard(snapshot, 'session-1::tab-1')?.card.description).toBe(
				'Needs a follow-up PR.'
			);
		});

		it('appends comments in order and stamps lastCommentAt with the newest one', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});

			await plugin.activate(maestro);
			const cardNote = commandHandlers.get('card-note')!;

			vi.setSystemTime(1000);
			await cardNote({ cardKey: 'session-1::tab-1', action: 'comment', body: 'First' });
			vi.setSystemTime(2000);
			const second = await cardNote({
				cardKey: 'session-1::tab-1',
				action: 'comment',
				body: '  Second  ',
			});

			expect(second).toEqual({ ok: true });
			const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
				columns: {
					id: string;
					cards: {
						key: string;
						comments: { id: string; body: string; createdAt: number }[];
						lastCommentAt: number;
					}[];
				}[];
			};
			const card = findCard(snapshot, 'session-1::tab-1')?.card;
			// Appended, rendered newest last: the array is in insertion order.
			expect(card?.comments.map((c) => c.body)).toEqual(['First', 'Second']);
			expect(card?.comments[0]!.createdAt).toBe(1000);
			expect(card?.comments[1]!.createdAt).toBe(2000);
			expect(card?.comments[0]!.id).not.toBe(card?.comments[1]!.id);
			expect(card?.lastCommentAt).toBe(2000);
		});

		it('rejects a card-note call with no cardKey, and touches neither storage nor the comment thread', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});

			await plugin.activate(maestro);
			maestro.storage.set.mockClear();
			const cardNote = commandHandlers.get('card-note')!;

			const result = await cardNote({ action: 'comment', body: 'Orphaned' });

			expect(result).toEqual({ ok: false, error: 'cardKey is required' });
			expect(maestro.storage.set).not.toHaveBeenCalled();
		});

		it('rejects an unknown action without writing anything', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = createStubMaestro();
			await plugin.activate(maestro);
			maestro.storage.set.mockClear();
			const cardNote = commandHandlers.get('card-note')!;

			const result = await cardNote({ cardKey: 'session-1::tab-1', action: 'delete-everything' });

			expect(result).toEqual({ ok: false, error: 'unknown action' });
			expect(maestro.storage.set).not.toHaveBeenCalled();
		});

		it('writes a description and a comment on a card this plugin has not been granted access to', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});

			await plugin.activate(maestro);
			const cardNote = commandHandlers.get('card-note')!;

			const descriptionResult = await cardNote({
				cardKey: 'session-1::tab-1',
				action: 'description',
				description: 'Still works ungranted.',
			});
			const commentResult = await cardNote({
				cardKey: 'session-1::tab-1',
				action: 'comment',
				body: 'Also works ungranted.',
			});

			expect(descriptionResult).toEqual({ ok: true });
			expect(commentResult).toEqual({ ok: true });
			const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
				columns: {
					id: string;
					cards: {
						key: string;
						accessGranted: boolean;
						description: string;
						comments: unknown[];
					}[];
				}[];
			};
			const card = findCard(snapshot, 'session-1::tab-1')?.card;
			expect(card?.accessGranted).toBe(false);
			expect(card?.description).toBe('Still works ungranted.');
			expect(card?.comments).toHaveLength(1);
		});

		it('notes survive a restart: a fresh activation reads back what a previous one wrote', async () => {
			const store = new Map<string, string>();
			const sharedStorage = {
				get: vi.fn((key: string) => Promise.resolve(store.has(key) ? store.get(key)! : null)),
				set: vi.fn((key: string, value: string) => {
					store.set(key, value);
					return Promise.resolve({ ok: true });
				}),
				delete: vi.fn((key: string) => {
					store.delete(key);
					return Promise.resolve({ ok: true });
				}),
				keys: vi.fn(() => Promise.resolve(Array.from(store.keys()))),
			};

			const firstPlugin = loadMain();
			const { maestro: firstMaestro, commandHandlers: firstCommands } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});
			firstMaestro.storage = sharedStorage;
			await firstPlugin.activate(firstMaestro);
			await firstCommands.get('card-note')!({
				cardKey: 'session-1::tab-1',
				action: 'description',
				description: 'Survives restart.',
			});
			await firstPlugin.deactivate();

			const secondPlugin = loadMain();
			const { maestro: secondMaestro } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});
			secondMaestro.storage = sharedStorage;
			await secondPlugin.activate(secondMaestro);

			const snapshot = secondMaestro.ui.panelPost.mock.calls.at(-1)![1] as {
				columns: { id: string; cards: { key: string; description: string }[] }[];
			};
			expect(findCard(snapshot, 'session-1::tab-1')?.card.description).toBe('Survives restart.');
		});
	});

	it('does not throw out of activate when tabs.list is rejected', async () => {
		const plugin = loadMain();
		const { maestro } = createStubMaestro({
			tabsList: () => Promise.reject(new Error('RPC down')),
		});

		await expect(plugin.activate(maestro)).resolves.toBeUndefined();
	});

	// Phase 08 honest failure states. A refused tabs.list() leaves the card
	// model exactly as it was, which on screen is indistinguishable from a
	// board where nothing happened - so the snapshot has to say so.
	describe('card-model staleness', () => {
		it('rides a cardsStale notice naming tabs.list when the seed read is refused', async () => {
			const plugin = loadMain();
			const { maestro } = createStubMaestro({
				tabsList: () => Promise.reject(new Error('RPC down')),
			});

			await plugin.activate(maestro);

			const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
				cardsStale: { call: string; message: string } | null;
			};
			expect(snapshot.cardsStale).toEqual({ call: 'tabs.list', message: 'RPC down' });
		});

		it('names sessions.list when only that read is refused, since the titles are stale too', async () => {
			const plugin = loadMain();
			const { maestro } = createStubMaestro({
				sessionsList: () => Promise.reject(new Error('capability sessions:list not granted')),
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});

			await plugin.activate(maestro);

			const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
				cardsStale: { call: string; message: string } | null;
				columns: { cards: { key: string }[] }[];
			};
			expect(snapshot.cardsStale).toEqual({
				call: 'sessions.list',
				message: 'capability sessions:list not granted',
			});
			// Degraded, not blank: the cards tabs.list() did return are still drawn.
			expect(snapshot.columns.flatMap((c) => c.cards).map((c) => c.key)).toEqual([
				'session-1::tab-1',
			]);
		});

		it('leaves cardsStale null when both reads succeed', async () => {
			const plugin = loadMain();
			const { maestro } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});

			await plugin.activate(maestro);

			const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
				cardsStale: unknown;
			};
			expect(snapshot.cardsStale).toBeNull();
		});

		it('pushes the notice from a failed background refresh, and clears it on the next good one', async () => {
			const plugin = loadMain();
			let failNext = false;
			const { maestro, eventHandlers } = createStubMaestro({
				tabsList: () =>
					failNext
						? Promise.reject(new Error('RPC down'))
						: Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});

			await plugin.activate(maestro);
			maestro.ui.panelPost.mockClear();

			failNext = true;
			emit(eventHandlers, 'agent.statusChanged', { tabId: 'session-1', status: 'busy' });
			await vi.advanceTimersByTimeAsync(200);

			const failedSnapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
				cardsStale: { call: string } | null;
				columns: { cards: { key: string }[] }[];
			};
			expect(failedSnapshot.cardsStale).toEqual({ call: 'tabs.list', message: 'RPC down' });
			// The card the last good read produced is still on the board.
			expect(failedSnapshot.columns.flatMap((c) => c.cards)).toHaveLength(1);

			failNext = false;
			emit(eventHandlers, 'agent.statusChanged', { tabId: 'session-1', status: 'idle' });
			await vi.advanceTimersByTimeAsync(200);

			const recoveredSnapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
				cardsStale: unknown;
			};
			expect(recoveredSnapshot.cardsStale).toBeNull();
		});
	});

	it("switches the panel's resolved columns to the activated session's project board", async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const slug = plugin.projectBoardSlug(projectPath) as string;
		const boardPath = '~/.maestro/kanban-boards/' + slug + '.yaml';
		const boardYaml =
			'version: 1\n' +
			'project: ' +
			projectPath +
			'\n' +
			'columns:\n' +
			'  - id: backlog\n' +
			'    title: Inbox\n' +
			'  - id: doing\n' +
			'    title: Doing\n' +
			'    wip_limit: 1\n' +
			'  - id: done\n' +
			'    title: Done\n' +
			'    terminal: true\n';
		const { maestro, eventHandlers } = createStubMaestro({
			sessionsList: () => Promise.resolve([{ id: 'session-1', title: 'Widgets', projectPath }]),
			tabsList: () =>
				Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath })]),
		});
		maestro.fs.read = vi.fn((path: string) => {
			if (path === boardPath) return Promise.resolve(boardYaml);
			return Promise.reject(new Error('ENOENT: no such file or directory'));
		});

		await plugin.activate(maestro);
		const initialSnapshot = maestro.ui.panelPost.mock.calls[0]![1] as {
			columns: { id: string; title: string }[];
		};
		// Before any session.activated event, the panel falls back to
		// DEFAULT_COLUMNS rather than guessing which project is "active".
		expect(initialSnapshot.columns.map((c) => c.id)).toEqual([
			'backlog',
			'in-progress',
			'review',
			'blocked',
			'done',
		]);

		maestro.ui.panelPost.mockClear();
		emit(eventHandlers, 'session.activated', { sessionId: 'session-1' });
		await vi.advanceTimersByTimeAsync(150 + 50);

		expect(maestro.ui.panelPost).toHaveBeenCalledTimes(1);
		const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as {
			columns: { id: string; title: string; wipLimit?: number; cards: { key: string }[] }[];
			boardError: unknown;
		};
		expect(
			snapshot.columns.map((c) => ({ id: c.id, title: c.title, wipLimit: c.wipLimit }))
		).toEqual([
			{ id: 'backlog', title: 'Inbox', wipLimit: undefined },
			{ id: 'doing', title: 'Doing', wipLimit: 1 },
			{ id: 'done', title: 'Done', wipLimit: undefined },
		]);
		expect(findCard(snapshot, 'session-1::tab-1')?.columnId).toBe('backlog');
		expect(snapshot.boardError).toBeNull();
	});

	it('surfaces a board parse failure as boardError with the message and the file path', async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const slug = plugin.projectBoardSlug(projectPath) as string;
		const boardPath = '~/.maestro/kanban-boards/' + slug + '.yaml';
		// Missing the required `version` key.
		const brokenYaml =
			'project: ' + projectPath + '\ncolumns:\n  - id: backlog\n    title: Backlog\n';
		const { maestro, eventHandlers } = createStubMaestro({
			sessionsList: () => Promise.resolve([{ id: 'session-1', title: 'Widgets', projectPath }]),
			tabsList: () =>
				Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath })]),
		});
		maestro.fs.read = vi.fn((path: string) => {
			if (path === boardPath) return Promise.resolve(brokenYaml);
			return Promise.reject(new Error('ENOENT: no such file or directory'));
		});

		await plugin.activate(maestro);
		maestro.ui.panelPost.mockClear();
		emit(eventHandlers, 'session.activated', { sessionId: 'session-1' });
		await vi.advanceTimersByTimeAsync(150 + 50);

		const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as {
			boardError: { message: string; path: string } | null;
		};
		expect(snapshot.boardError).toEqual({ message: 'version is required', path: boardPath });
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

	it('reports projectBoardMissing only for an active project with no board file yet', async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const { maestro, eventHandlers } = createStubMaestro({
			sessionsList: () => Promise.resolve([{ id: 'session-1', title: 'Widgets', projectPath }]),
			tabsList: () =>
				Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath })]),
		});

		await plugin.activate(maestro);
		const beforeActivation = maestro.ui.panelPost.mock.calls[0]![1] as {
			activeProjectPath: string | null;
			projectBoardMissing: boolean;
		};
		expect(beforeActivation.activeProjectPath).toBeNull();
		expect(beforeActivation.projectBoardMissing).toBe(false);

		maestro.ui.panelPost.mockClear();
		emit(eventHandlers, 'session.activated', { sessionId: 'session-1' });
		await vi.advanceTimersByTimeAsync(150 + 50);

		const afterActivation = maestro.ui.panelPost.mock.calls[0]![1] as {
			activeProjectPath: string | null;
			projectBoardMissing: boolean;
		};
		expect(afterActivation.activeProjectPath).toBe(projectPath);
		expect(afterActivation.projectBoardMissing).toBe(true);
	});

	it("does not report projectBoardMissing when the active project's board file fails to parse", async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const { maestro, eventHandlers } = createStubMaestro({
			sessionsList: () => Promise.resolve([{ id: 'session-1', title: 'Widgets', projectPath }]),
			tabsList: () =>
				Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1', projectPath })]),
		});
		const boardPath =
			'~/.maestro/kanban-boards/' + (plugin.projectBoardSlug(projectPath) as string) + '.yaml';
		maestro.fs.read = vi.fn((path: string) => {
			if (path === boardPath) return Promise.resolve('columns:\n  - id: backlog\n    title: X\n');
			return Promise.reject(new Error('ENOENT: no such file or directory'));
		});

		await plugin.activate(maestro);
		emit(eventHandlers, 'session.activated', { sessionId: 'session-1' });
		await vi.advanceTimersByTimeAsync(150 + 50);

		const snapshot = maestro.ui.panelPost.mock.calls[
			maestro.ui.panelPost.mock.calls.length - 1
		]![1] as {
			projectBoardMissing: boolean;
			boardError: unknown;
		};
		expect(snapshot.boardError).not.toBeNull();
		expect(snapshot.projectBoardMissing).toBe(false);
	});

	it('writes a default board file for the active project via write-default-board and reports success', async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const { maestro, commandHandlers } = createStubMaestro();
		const boardPath =
			'~/.maestro/kanban-boards/' + (plugin.projectBoardSlug(projectPath) as string) + '.yaml';

		await plugin.activate(maestro);
		maestro.ui.panelPost.mockClear();
		maestro.notifications.toast.mockClear();

		const writeDefaultBoard = commandHandlers.get('write-default-board');
		expect(writeDefaultBoard).toBeTypeOf('function');
		const result = await writeDefaultBoard!({ projectPath: projectPath });

		expect(result).toEqual({ ok: true, path: boardPath });
		expect(maestro.fs.write).toHaveBeenCalledTimes(1);
		const [writtenPath, writtenText] = (maestro.fs.write as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, string];
		expect(writtenPath).toBe(boardPath);
		expect(writtenText).toContain('version: 1');
		expect(writtenText).toContain('project: ' + projectPath);
		expect(writtenText).toContain('id: backlog');
		expect(maestro.notifications.toast).toHaveBeenCalledWith('Wrote default board to ' + boardPath);
		// A fresh panel push reflects the just-written board immediately.
		expect(maestro.ui.panelPost).toHaveBeenCalledTimes(1);
	});

	it('refuses to overwrite an existing board file via write-default-board', async () => {
		const plugin = loadMain();
		const projectPath = '/Users/dev/projects/widgets';
		const { maestro, commandHandlers } = createStubMaestro();
		const boardPath =
			'~/.maestro/kanban-boards/' + (plugin.projectBoardSlug(projectPath) as string) + '.yaml';
		maestro.fs.read = vi.fn((path: string) => {
			if (path === boardPath)
				return Promise.resolve(
					'version: 1\nproject: ' + projectPath + '\ncolumns:\n  - id: x\n    title: X\n'
				);
			return Promise.reject(new Error('ENOENT: no such file or directory'));
		});

		await plugin.activate(maestro);

		const writeDefaultBoard = commandHandlers.get('write-default-board');
		const result = await writeDefaultBoard!({ projectPath: projectPath });

		expect(result).toEqual({
			ok: false,
			error: 'A board file already exists at ' + boardPath,
		});
		expect(maestro.fs.write).not.toHaveBeenCalled();
	});

	it('reports failure from write-default-board when no project path is supplied', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro();

		await plugin.activate(maestro);

		const writeDefaultBoard = commandHandlers.get('write-default-board');
		const result = await writeDefaultBoard!({});

		expect(result).toEqual({ ok: false });
		expect(maestro.fs.write).not.toHaveBeenCalled();
	});

	// Phase 04 History excerpt: maestro.transcripts.read is only ever called
	// through the 'read-history' command, for a session a detail pane is open
	// on - never for every card in a snapshot, never on a timer.
	describe('read-history command', () => {
		it('does not call transcripts.read for an ungranted session', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});
			await plugin.activate(maestro);

			const readHistory = commandHandlers.get('read-history');
			expect(readHistory).toBeTypeOf('function');
			const result = await readHistory!({ sessionId: 'session-1' });

			expect(result).toEqual({ ok: false, error: 'not granted' });
			expect(maestro.transcripts.read).not.toHaveBeenCalled();
		});

		it('read-history with no sessionId is a no-op', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = createStubMaestro();
			await plugin.activate(maestro);

			const readHistory = commandHandlers.get('read-history');
			const result = await readHistory!({});

			expect(result).toEqual({ ok: false });
			expect(maestro.transcripts.read).not.toHaveBeenCalled();
		});

		it('reads the allowlisted fields for a granted session and carries the excerpt on the next snapshot', async () => {
			const plugin = loadMain();
			const rows = [{ summary: 'Fixed the thing', timestamp: 100, type: 'text', success: true }];
			const { maestro, commandHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
				transcriptsRead: () => Promise.resolve(rows),
			});
			await plugin.activate(maestro);
			await commandHandlers.get('request-access')!({ sessionId: 'session-1' });
			maestro.ui.panelPost.mockClear();

			const result = await commandHandlers.get('read-history')!({ sessionId: 'session-1' });

			expect(result).toEqual({ ok: true });
			expect(maestro.transcripts.read).toHaveBeenCalledWith({
				sessionId: 'session-1',
				fields: ['summary', 'timestamp', 'type', 'success'],
				limit: 8,
			});
			expect(maestro.ui.panelPost).toHaveBeenCalledTimes(1);
			const snapshot = maestro.ui.panelPost.mock.calls[0]![1] as {
				historyExcerpt: { sessionId: string; status: string; rows: unknown[]; error: null } | null;
			};
			expect(snapshot.historyExcerpt).toEqual({
				sessionId: 'session-1',
				status: 'loaded',
				rows,
				error: null,
			});
		});

		it('serves the cached excerpt within the TTL instead of reading again', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});
			await plugin.activate(maestro);
			await commandHandlers.get('request-access')!({ sessionId: 'session-1' });

			await commandHandlers.get('read-history')!({ sessionId: 'session-1' });
			await commandHandlers.get('read-history')!({ sessionId: 'session-1' });

			expect(maestro.transcripts.read).toHaveBeenCalledTimes(1);
		});

		it('a denial naming a revoked grant drops the card back to ungranted, with no History error rendered', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
				transcriptsRead: () =>
					Promise.reject(
						new Error(
							'transcripts.read: session session-1 is not granted to this plugin ' +
								'(the plugin must have created it, or you must approve it)'
						)
					),
			});
			await plugin.activate(maestro);
			await commandHandlers.get('request-access')!({ sessionId: 'session-1' });
			maestro.ui.panelPost.mockClear();

			await commandHandlers.get('read-history')!({ sessionId: 'session-1' });

			const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
				historyExcerpt: unknown;
				columns: { cards: { key: string; accessGranted: boolean }[] }[];
			};
			expect(findCard(snapshot, 'session-1::tab-1')?.card.accessGranted).toBe(false);
			expect(snapshot.historyExcerpt).toBeNull();
		});

		it('a denial for any other reason renders a specific "History not available" state, without touching the grant', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
				transcriptsRead: () => Promise.reject(new Error('rate limited')),
			});
			await plugin.activate(maestro);
			await commandHandlers.get('request-access')!({ sessionId: 'session-1' });
			maestro.ui.panelPost.mockClear();

			await commandHandlers.get('read-history')!({ sessionId: 'session-1' });

			const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
				historyExcerpt: { sessionId: string; status: string; error: string } | null;
				columns: { cards: { key: string; accessGranted: boolean }[] }[];
			};
			expect(snapshot.historyExcerpt).toEqual({
				sessionId: 'session-1',
				status: 'error',
				rows: [],
				error: 'rate limited',
			});
			expect(findCard(snapshot, 'session-1::tab-1')?.card.accessGranted).toBe(true);
		});

		it("re-reads on that session's agent.completed event when its pane is open, and pushes the refreshed excerpt", async () => {
			const plugin = loadMain();
			let rows = [{ summary: 'First', timestamp: 1, type: 'text', success: true }];
			const { maestro, commandHandlers, eventHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
				transcriptsRead: () => Promise.resolve(rows),
			});
			await plugin.activate(maestro);
			await commandHandlers.get('request-access')!({ sessionId: 'session-1' });
			await commandHandlers.get('read-history')!({ sessionId: 'session-1' });
			expect(maestro.transcripts.read).toHaveBeenCalledTimes(1);
			maestro.ui.panelPost.mockClear();

			rows = [{ summary: 'Second', timestamp: 2, type: 'text', success: true }];
			emit(eventHandlers, 'agent.completed', { sessionId: 'session-1' });
			await vi.advanceTimersByTimeAsync(0);

			expect(maestro.transcripts.read).toHaveBeenCalledTimes(2);
			const pushed = maestro.ui.panelPost.mock.calls
				.map((call) => call[1] as { historyExcerpt: { rows: unknown[] } | null })
				.find((snapshot) => snapshot.historyExcerpt && snapshot.historyExcerpt.rows.length > 0);
			expect(pushed?.historyExcerpt?.rows).toEqual(rows);
		});

		it('does not re-read on agent.completed for a session whose History has never been read', async () => {
			const plugin = loadMain();
			const { maestro, eventHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});
			await plugin.activate(maestro);

			emit(eventHandlers, 'agent.completed', { sessionId: 'session-1' });
			await vi.advanceTimersByTimeAsync(0);

			expect(maestro.transcripts.read).not.toHaveBeenCalled();
		});

		it('close-history stops the agent.completed re-read for the session the pane left', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers, eventHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});
			await plugin.activate(maestro);
			await commandHandlers.get('request-access')!({ sessionId: 'session-1' });
			await commandHandlers.get('read-history')!({ sessionId: 'session-1' });
			expect(maestro.transcripts.read).toHaveBeenCalledTimes(1);

			await commandHandlers.get('close-history')!();
			emit(eventHandlers, 'agent.completed', { sessionId: 'session-1' });
			await vi.advanceTimersByTimeAsync(0);

			expect(maestro.transcripts.read).toHaveBeenCalledTimes(1);
		});
	});
});

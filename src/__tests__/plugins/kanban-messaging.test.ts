/**
 * @file kanban-messaging.test.ts
 * @description Dedicated coverage for Phase 04's message box: the
 * `send-message` command in `examples/plugins/maestro-kanban/main.js` (the
 * sandbox side, driven the same way `kanban-main.test.ts` drives it, with a
 * hand-built stub `maestro` SDK extended with `agents.dispatch`) and the
 * detail pane's composer in `panel.html` (the DOM side, driven through
 * `src/__tests__/helpers/kanbanPanel.ts`, shared with `kanban-panel.test.ts`
 * and `kanban-drag.test.ts`).
 *
 * `read-history` and `card-note` already have full describe blocks in
 * `kanban-main.test.ts` (cache TTL, event-driven re-reads, denial handling,
 * restart persistence); this file does not re-derive every edge case there,
 * only the ones this phase's playbook entry calls out by name alongside
 * messaging: that an ungranted card never reads History, that a granted
 * card's read respects the allowlist and the cache, and that descriptions
 * and comments round-trip regardless of grant state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import {
	findCardElement,
	loadPanel,
	makeCard,
	pushSnapshot,
	snapshotWith,
	teardownPanel,
	type SnapshotCard,
} from '../helpers/kanbanPanel';

const require = createRequire(import.meta.url);
const mainPath = require.resolve('../../../examples/plugins/maestro-kanban/main.js');

/** Fresh module state per test: main.js keeps its card/grant/outcome model in
 * module-level variables, so the require cache entry must be dropped before
 * every require(). Mirrors kanban-main.test.ts's loadMain(). */
function loadMain() {
	delete require.cache[mainPath];
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	return require(mainPath);
}

interface StubOverrides {
	tabsList?: () => Promise<unknown>;
	sessionsRequestAccess?: (sessionId: string) => Promise<unknown>;
	transcriptsRead?: (params: unknown) => Promise<unknown>;
	agentsDispatch?: (sessionId: string, prompt: string, opts: unknown) => Promise<unknown>;
}

/** Mirrors kanban-main.test.ts's createStubMaestro, plus `maestro.agents`:
 * that file's stub predates the send-message task and never needed it. */
function createStubMaestro(overrides: StubOverrides = {}) {
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
			list: vi.fn(() => Promise.resolve([])),
			focus: vi.fn(() => Promise.resolve({ ok: true })),
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
		agents: {
			dispatch: vi.fn(overrides.agentsDispatch ?? (() => Promise.resolve({ ok: true }))),
			list: vi.fn(() => Promise.resolve([])),
		},
		ui: {
			panelPost: vi.fn((_panelId: string, _message: unknown) => Promise.resolve({ ok: true })),
			togglePanel: vi.fn(() => Promise.resolve({ ok: true })),
		},
		notifications: {
			toast: vi.fn(() => Promise.resolve({ ok: true })),
		},
		fs: {
			// Parameters spelled out, not inferred: a test that swaps in its own
			// fs.read (a real board file) assigns a (path) => ... mock, which a
			// no-arg inferred default would reject.
			read: vi.fn(
				(_path: string): Promise<string> =>
					Promise.reject(new Error('ENOENT: no such file or directory'))
			),
			write: vi.fn((_path: string, _contents: string) => Promise.resolve({ ok: true })),
		},
		storage: {
			// Same reason as fs above: the shared-store tests assign a keyed mock.
			get: vi.fn((_key: string): Promise<string | null> => Promise.resolve(null)),
			set: vi.fn((_key: string, _value: string) => Promise.resolve({ ok: true })),
			delete: vi.fn((_key: string) => Promise.resolve({ ok: true })),
			keys: vi.fn((): Promise<string[]> => Promise.resolve([])),
		},
	};

	return { maestro, commandHandlers };
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

// Generic over the column shape so each call site keeps the card fields it
// cast the snapshot to. A fixed `cards: { key: string }[]` would widen every
// card back to its key and hide a typo in any other field behind TS2339.
function findCard<Column extends { id?: string; cards: { key: string }[] }>(
	snapshot: { columns: Column[] },
	key: string
): { card: Column['cards'][number]; columnId: Column['id'] } | undefined {
	for (const column of snapshot.columns) {
		const card = column.cards.find((c) => c.key === key);
		if (card) return { card, columnId: column.id };
	}
	return undefined;
}

describe('send-message command (sandbox)', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('dispatches with exactly (sessionId, prompt, { tabId }) on a granted card, and no extra keys', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro({
			tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
		});
		await plugin.activate(maestro);
		await commandHandlers.get('request-access')!({ sessionId: 'session-1' });

		const sendMessage = commandHandlers.get('send-message');
		expect(sendMessage).toBeTypeOf('function');
		const result = await sendMessage!({
			cardKey: 'session-1::tab-1',
			sessionId: 'session-1',
			tabId: 'tab-1',
			prompt: 'Status update please',
		});

		expect(result).toEqual({ ok: true, error: null });
		expect(maestro.agents.dispatch).toHaveBeenCalledTimes(1);
		expect(maestro.agents.dispatch).toHaveBeenCalledWith('session-1', 'Status update please', {
			tabId: 'tab-1',
		});
		// Already granted by the explicit request-access above: send-message
		// itself must not ask again.
		expect(maestro.sessions.requestAccess).toHaveBeenCalledTimes(1);
	});

	it('the first send on an ungranted card requests access once and dispatches only after { granted: true }', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro({
			tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			sessionsRequestAccess: () => Promise.resolve({ granted: true }),
		});
		await plugin.activate(maestro);

		const result = await commandHandlers.get('send-message')!({
			cardKey: 'session-1::tab-1',
			sessionId: 'session-1',
			tabId: 'tab-1',
			prompt: 'First message',
		});

		expect(maestro.sessions.requestAccess).toHaveBeenCalledTimes(1);
		expect(maestro.sessions.requestAccess).toHaveBeenCalledWith('session-1');
		expect(maestro.agents.dispatch).toHaveBeenCalledTimes(1);
		expect(maestro.agents.dispatch).toHaveBeenCalledWith('session-1', 'First message', {
			tabId: 'tab-1',
		});
		expect(result).toEqual({ ok: true, error: null });
		const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
			columns: { cards: { key: string; accessGranted: boolean }[] }[];
		};
		expect(findCard(snapshot, 'session-1::tab-1')?.card.accessGranted).toBe(true);
	});

	it('a declined access request leaves the message unsent with "access not granted", and never dispatches', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro({
			tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			sessionsRequestAccess: () => Promise.resolve({ granted: false }),
		});
		await plugin.activate(maestro);

		const result = await commandHandlers.get('send-message')!({
			cardKey: 'session-1::tab-1',
			sessionId: 'session-1',
			tabId: 'tab-1',
			prompt: 'Never leaves',
		});

		expect(maestro.agents.dispatch).not.toHaveBeenCalled();
		expect(result).toEqual({ ok: false, error: 'access not granted' });
		const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
			columns: {
				cards: {
					key: string;
					accessGranted: boolean;
					messageOutcome: { status: string; error: string } | null;
				}[];
			}[];
		};
		const card = findCard(snapshot, 'session-1::tab-1')?.card;
		expect(card?.accessGranted).toBe(false);
		expect(card?.messageOutcome).toMatchObject({ status: 'failed', error: 'access not granted' });
	});

	it('a dispatch denied for a revoked grant drops the session back to ungranted', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro({
			tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			agentsDispatch: () =>
				Promise.reject(
					new Error(
						'agents.dispatch: session session-1 is not granted to this plugin ' +
							'(the plugin must have created it, or you must approve it)'
					)
				),
		});
		await plugin.activate(maestro);
		await commandHandlers.get('request-access')!({ sessionId: 'session-1' });
		maestro.ui.panelPost.mockClear();

		// Command handlers are registered as (args?: unknown) => unknown, so the
		// awaited result is `unknown`; name the send-message reply shape to read
		// its fields rather than compare the whole object like the cases above.
		const result = (await commandHandlers.get('send-message')!({
			cardKey: 'session-1::tab-1',
			sessionId: 'session-1',
			tabId: 'tab-1',
			prompt: 'Revoked mid-flight',
		})) as { ok: boolean; error: string | null };

		expect(result.ok).toBe(false);
		expect(result.error).toContain('is not granted to this plugin');
		const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
			columns: {
				cards: {
					key: string;
					accessGranted: boolean;
					messageOutcome: { status: string } | null;
				}[];
			}[];
		};
		const card = findCard(snapshot, 'session-1::tab-1')?.card;
		expect(card?.accessGranted).toBe(false);
		expect(card?.messageOutcome?.status).toBe('failed');
	});

	it("a dispatch rejected for any other reason marks the message failed with the host's exact error text, and the grant is untouched", async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro({
			tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			agentsDispatch: () => Promise.reject(new Error('Rate limit exceeded for agents.dispatch')),
		});
		await plugin.activate(maestro);
		await commandHandlers.get('request-access')!({ sessionId: 'session-1' });
		maestro.ui.panelPost.mockClear();

		const result = await commandHandlers.get('send-message')!({
			cardKey: 'session-1::tab-1',
			sessionId: 'session-1',
			tabId: 'tab-1',
			prompt: 'Over the cap',
		});

		expect(result).toEqual({ ok: false, error: 'Rate limit exceeded for agents.dispatch' });
		const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
			columns: {
				cards: {
					key: string;
					accessGranted: boolean;
					messageOutcome: { status: string; error: string; at: number } | null;
				}[];
			}[];
		};
		const card = findCard(snapshot, 'session-1::tab-1')?.card;
		// Not a grant denial: the card stays connected, same as today.
		expect(card?.accessGranted).toBe(true);
		expect(card?.messageOutcome).toEqual({
			status: 'failed',
			error: 'Rate limit exceeded for agents.dispatch',
			at: expect.any(Number) as unknown as number,
		});
	});

	it('missing args is a no-op naming what is required, and never dispatches or requests access', async () => {
		const plugin = loadMain();
		const { maestro, commandHandlers } = createStubMaestro();
		await plugin.activate(maestro);

		const result = await commandHandlers.get('send-message')!({ cardKey: 'session-1::tab-1' });

		expect(result).toEqual({
			ok: false,
			error: 'cardKey, sessionId, tabId and prompt are required',
		});
		expect(maestro.agents.dispatch).not.toHaveBeenCalled();
		expect(maestro.sessions.requestAccess).not.toHaveBeenCalled();
	});

	// Phase 04's playbook entry calls these two out by name alongside
	// messaging; the exhaustive TTL/event/denial cases already live in
	// kanban-main.test.ts's `read-history command` describe block.
	describe('History reads alongside a message-capable card', () => {
		it('an ungranted card never calls transcripts.read even when its pane asks for History', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});
			await plugin.activate(maestro);

			const result = await commandHandlers.get('read-history')!({ sessionId: 'session-1' });

			expect(result).toEqual({ ok: false, error: 'not granted' });
			expect(maestro.transcripts.read).not.toHaveBeenCalled();
		});

		it('a granted card requests only the allowlisted fields and the configured limit, and serves the TTL cache on the next ask', async () => {
			const plugin = loadMain();
			const rows = [{ summary: 'Did a thing', timestamp: 1, type: 'text', success: true }];
			const { maestro, commandHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
				transcriptsRead: () => Promise.resolve(rows),
			});
			await plugin.activate(maestro);
			await commandHandlers.get('request-access')!({ sessionId: 'session-1' });

			await commandHandlers.get('read-history')!({ sessionId: 'session-1' });
			await commandHandlers.get('read-history')!({ sessionId: 'session-1' });

			expect(maestro.transcripts.read).toHaveBeenCalledTimes(1);
			expect(maestro.transcripts.read).toHaveBeenCalledWith({
				sessionId: 'session-1',
				fields: ['summary', 'timestamp', 'type', 'success'],
				limit: 8,
			});
		});
	});

	// Descriptions and comments are this plugin's own storage and never
	// gated by accessGranted; kanban-main.test.ts's `card-note command`
	// describe block covers the write-path edge cases in depth, so this is
	// just the round-trip-through-storage assertion this task calls for.
	describe('Descriptions and comments round-trip alongside messaging', () => {
		it('round-trip through storage on a granted card, and a comment stamps lastCommentAt', async () => {
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
			await firstCommands.get('request-access')!({ sessionId: 'session-1' });
			vi.setSystemTime(5000);
			await firstCommands.get('card-note')!({
				cardKey: 'session-1::tab-1',
				action: 'description',
				description: 'Granted card note.',
			});
			await firstCommands.get('card-note')!({
				cardKey: 'session-1::tab-1',
				action: 'comment',
				body: 'Granted comment.',
			});
			await firstPlugin.deactivate();

			const secondPlugin = loadMain();
			const { maestro: secondMaestro } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});
			secondMaestro.storage = sharedStorage;
			await secondPlugin.activate(secondMaestro);

			const snapshot = secondMaestro.ui.panelPost.mock.calls.at(-1)![1] as {
				columns: {
					cards: {
						key: string;
						description: string;
						comments: { body: string }[];
						lastCommentAt: number | null;
					}[];
				}[];
			};
			const card = findCard(snapshot, 'session-1::tab-1')?.card;
			expect(card?.description).toBe('Granted card note.');
			expect(card?.comments.map((c) => c.body)).toEqual(['Granted comment.']);
			expect(card?.lastCommentAt).toBe(5000);
		});

		it('round-trip through storage on an ungranted card too, with no grant needed', async () => {
			const plugin = loadMain();
			const { maestro, commandHandlers } = createStubMaestro({
				tabsList: () => Promise.resolve([aiTab({ id: 'tab-1', sessionId: 'session-1' })]),
			});
			await plugin.activate(maestro);

			await commandHandlers.get('card-note')!({
				cardKey: 'session-1::tab-1',
				action: 'description',
				description: 'Ungranted card note.',
			});
			await commandHandlers.get('card-note')!({
				cardKey: 'session-1::tab-1',
				action: 'comment',
				body: 'Ungranted comment.',
			});

			const snapshot = maestro.ui.panelPost.mock.calls.at(-1)![1] as {
				columns: {
					cards: {
						key: string;
						accessGranted: boolean;
						description: string;
						comments: { body: string }[];
						lastCommentAt: number | null;
					}[];
				}[];
			};
			const card = findCard(snapshot, 'session-1::tab-1')?.card;
			expect(card?.accessGranted).toBe(false);
			expect(card?.description).toBe('Ungranted card note.');
			expect(card?.comments.map((c) => c.body)).toEqual(['Ungranted comment.']);
			expect(card?.lastCommentAt).not.toBeNull();
		});
	});
});

describe('message composer (panel)', () => {
	beforeEach(() => {
		loadPanel();
	});

	afterEach(() => {
		teardownPanel();
	});

	function openComposerOn(card: SnapshotCard) {
		pushSnapshot(snapshotWith({ backlog: [card] }));
		findCardElement(card.title!).click();
	}

	function composerInput() {
		return document.getElementById('detail-composer-input') as HTMLTextAreaElement;
	}

	function composerSend() {
		return document.getElementById('detail-composer-send') as HTMLButtonElement;
	}

	function composerStatus() {
		return document.getElementById('detail-composer-status');
	}

	it('posts send-message with exactly cardKey, sessionId, tabId and prompt on Send', () => {
		openComposerOn(
			makeCard({
				title: 'Send Me',
				key: 'session-9::tab-9',
				sessionId: 'session-9',
				tabId: 'tab-9',
			})
		);
		composerInput().value = 'Please check the build';

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		composerSend().click();

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
		expect(postMessageSpy.mock.calls[0]![0]).toEqual({
			type: 'maestro:invokeCommand',
			commandId: 'send-message',
			args: {
				cardKey: 'session-9::tab-9',
				sessionId: 'session-9',
				tabId: 'tab-9',
				prompt: 'Please check the build',
			},
		});
	});

	it('refuses a second send while one is in flight for the same card', () => {
		openComposerOn(makeCard({ title: 'One At A Time' }));
		composerInput().value = 'First attempt';

		const postMessageSpy = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		// Raw dispatchEvent, not .click(): this exercises submitCardMessage's
		// own "one in-flight send per card" guard rather than relying on the
		// Send button's `disabled` attribute to block the second interaction.
		composerSend().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		composerSend().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

		expect(postMessageSpy).toHaveBeenCalledTimes(1);
	});

	it('disables the field and button and shows "Sending..." while a send is outstanding', () => {
		openComposerOn(makeCard({ title: 'In Flight' }));
		composerInput().value = 'Hold on';
		vi.spyOn(window, 'postMessage').mockImplementation(() => {});

		composerSend().click();

		expect(composerInput().disabled).toBe(true);
		expect(composerSend().disabled).toBe(true);
		expect(composerStatus()?.hidden).toBe(false);
		expect(composerStatus()?.textContent).toBe('Sending...');
	});

	it('clears the field and re-enables Send on a sent outcome', () => {
		const card = makeCard({
			title: 'Resolves Sent',
			key: 'session-4::tab-4',
			sessionId: 'session-4',
			tabId: 'tab-4',
		});
		openComposerOn(card);
		composerInput().value = 'On its way';
		vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		composerSend().click();

		pushSnapshot(
			snapshotWith({
				backlog: [{ ...card, messageOutcome: { status: 'sent', error: null, at: 123 } }],
			})
		);

		expect(composerInput().value).toBe('');
		expect(composerSend().textContent).toBe('Send');
		expect(composerSend().disabled).toBe(false);
		expect(composerStatus()?.hidden).toBe(true);
	});

	it("shows Retry and the host's exact error text on a failed outcome, leaving the text in place", () => {
		const card = makeCard({
			title: 'Resolves Failed',
			key: 'session-5::tab-5',
			sessionId: 'session-5',
			tabId: 'tab-5',
		});
		openComposerOn(card);
		composerInput().value = 'Try me';
		vi.spyOn(window, 'postMessage').mockImplementation(() => {});
		composerSend().click();

		pushSnapshot(
			snapshotWith({
				backlog: [
					{
						...card,
						messageOutcome: {
							status: 'failed',
							error: 'Not trusted (unsigned plugin).',
							at: 456,
						},
					},
				],
			})
		);

		expect(composerInput().value).toBe('Try me');
		expect(composerSend().textContent).toBe('Retry');
		expect(composerStatus()?.hidden).toBe(false);
		expect(composerStatus()?.textContent).toBe('Not trusted (unsigned plugin).');
	});
});

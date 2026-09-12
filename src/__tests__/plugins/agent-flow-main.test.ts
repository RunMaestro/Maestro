/**
 * Agent Flow plugin sandbox logic (`examples/plugins/agent-flow/main.js`).
 *
 * The file is plain CommonJS with no `require` calls (it runs through
 * `new vm.Script` inside the plugin utilityProcess), so it can be loaded here
 * directly with `createRequire` and driven through a stub `maestro` SDK.
 *
 * Covers the Phase 1 overlay wiring: the `overlay` command toggling the plugin's
 * own panel, the panel-posted `jump` message reaching `sessions.focus`, and the
 * metadata-only `session.activated` topic riding along in snapshots.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const MAIN_JS = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'../../../examples/plugins/agent-flow/main.js'
);

type EventHandler = (payload: unknown, meta?: unknown) => void;
type CommandHandler = (args?: unknown) => void;

interface SeedSession {
	id: string;
	title?: string;
	agentId?: string;
	status?: string;
}

interface Stub {
	sdk: Record<string, unknown>;
	emit: (topic: string, payload: unknown) => void;
	run: (commandId: string, args?: unknown) => void;
	panelPost: ReturnType<typeof vi.fn>;
	togglePanel: ReturnType<typeof vi.fn>;
	closePanel: ReturnType<typeof vi.fn>;
	focus: ReturnType<typeof vi.fn>;
	/** Latest snapshot pushed to the panel. */
	snapshot: () => Record<string, unknown> | undefined;
}

function makeStub(seed: SeedSession[] = []): Stub {
	const events = new Map<string, EventHandler[]>();
	const commands = new Map<string, CommandHandler>();
	const panelPost = vi.fn(() => Promise.resolve(undefined));
	const togglePanel = vi.fn(() => Promise.resolve(undefined));
	const closePanel = vi.fn(() => Promise.resolve(undefined));
	const focus = vi.fn(() => Promise.resolve(undefined));

	return {
		sdk: {
			events: {
				on: (topic: string, handler: EventHandler) => {
					const list = events.get(topic) ?? [];
					list.push(handler);
					events.set(topic, list);
				},
				subscribe: () => Promise.resolve(undefined),
			},
			commands: {
				register: (id: string, handler: CommandHandler) => commands.set(id, handler),
			},
			ui: { panelPost, togglePanel, closePanel },
			sessions: { list: () => Promise.resolve(seed), focus },
		},
		emit: (topic, payload) => (events.get(topic) ?? []).forEach((h) => h(payload, undefined)),
		run: (commandId, args) => commands.get(commandId)?.(args),
		panelPost,
		togglePanel,
		closePanel,
		focus,
		snapshot: () => {
			const call = panelPost.mock.calls[panelPost.mock.calls.length - 1] as
				| [string, Record<string, unknown>]
				| undefined;
			return call?.[1];
		},
	};
}

describe('agent-flow plugin main.js', () => {
	let plugin: { activate: (sdk: unknown) => void; deactivate: () => void };
	let stub: Stub;

	beforeEach(() => {
		const require = createRequire(import.meta.url);
		// Fresh module state per test: the file keeps its model in module scope.
		delete require.cache[require.resolve(MAIN_JS)];
		plugin = require(MAIN_JS);
		stub = makeStub();
		plugin.activate(stub.sdk);
	});

	afterEach(() => {
		plugin.deactivate();
	});

	it('toggles its own panel from the overlay command', () => {
		stub.run('overlay');
		expect(stub.togglePanel).toHaveBeenCalledWith('flow');
	});

	it('focuses a session when the panel posts a jump message', () => {
		stub.run('jump', { sessionId: 's1' });
		expect(stub.focus).toHaveBeenCalledWith('s1', undefined);

		stub.run('jump', { sessionId: 's2', tabId: 't9' });
		expect(stub.focus).toHaveBeenLastCalledWith('s2', 't9');
	});

	it('ignores a malformed jump message instead of calling the host', () => {
		stub.run('jump', undefined);
		stub.run('jump', {});
		stub.run('jump', { sessionId: '' });
		stub.run('jump', { sessionId: 42 });
		expect(stub.focus).not.toHaveBeenCalled();
	});

	it('drops a non-string tabId rather than forwarding it', () => {
		stub.run('jump', { sessionId: 's1', tabId: 7 });
		expect(stub.focus).toHaveBeenCalledWith('s1', undefined);
	});

	it('dismisses the overlay after a successful jump', async () => {
		stub.run('jump', { sessionId: 's1' });
		// closePanel is chained off the focus promise, so let the microtask settle.
		await Promise.resolve();
		await Promise.resolve();
		expect(stub.focus).toHaveBeenCalledWith('s1', undefined);
		expect(stub.closePanel).toHaveBeenCalledWith('flow');
	});

	it('leaves the overlay up when the jump is rejected', async () => {
		stub.focus.mockResolvedValueOnce(false);
		stub.run('jump', { sessionId: 'nope' });
		await Promise.resolve();
		await Promise.resolve();
		expect(stub.focus).toHaveBeenCalledWith('nope', undefined);
		expect(stub.closePanel).not.toHaveBeenCalled();
	});

	it('carries the activated session id in snapshots', () => {
		stub.emit('session.created', { sessionId: 's1', title: 'One', agentId: 'a1' });
		stub.emit('session.activated', { sessionId: 's1' });
		stub.run('sync');
		expect(stub.snapshot()?.focusedSessionId).toBe('s1');

		stub.emit('session.activated', { sessionId: 's2' });
		stub.run('sync');
		expect(stub.snapshot()?.focusedSessionId).toBe('s2');
	});

	it('clears the highlight when the focused session is removed', () => {
		stub.emit('session.activated', { sessionId: 's1' });
		stub.emit('session.removed', { sessionId: 's1' });
		stub.run('sync');
		expect(stub.snapshot()?.focusedSessionId).toBe('');
	});

	it('keeps the highlight when a different session is removed', () => {
		stub.emit('session.activated', { sessionId: 's1' });
		stub.emit('session.removed', { sessionId: 's2' });
		stub.run('sync');
		expect(stub.snapshot()?.focusedSessionId).toBe('s1');
	});

	it('ignores a malformed session.activated payload', () => {
		stub.emit('session.activated', { sessionId: 's1' });
		stub.emit('session.activated', { sessionId: 42 });
		stub.emit('session.activated', null);
		stub.run('sync');
		expect(stub.snapshot()?.focusedSessionId).toBe('s1');
	});

	describe('lazy lane seeding', () => {
		const SEED: SeedSession[] = [
			{ id: 's1', title: 'One', agentId: 'a1', status: 'idle' },
			{ id: 's2', title: 'Two', agentId: 'a2', status: 'idle' },
			{ id: 's3', title: 'Three', agentId: 'a3', status: 'idle' },
		];

		/** Re-activate against a stubbed session list and let the seed promise settle. */
		async function activateWithSessions(seed: SeedSession[]): Promise<void> {
			plugin.deactivate();
			stub = makeStub(seed);
			plugin.activate(stub.sdk);
			// sessions.list() resolves on a microtask; let the seed handler run.
			await Promise.resolve();
			await Promise.resolve();
		}

		function lanes(): Array<Record<string, unknown>> {
			stub.run('sync');
			return (stub.snapshot()?.lanes as Array<Record<string, unknown>>) ?? [];
		}

		it('creates no lanes for the sessions listed at activate', async () => {
			await activateWithSessions(SEED);
			expect(lanes()).toHaveLength(0);
		});

		it('materializes a lane carrying the seeded title on the first tool activity', async () => {
			await activateWithSessions(SEED);
			stub.emit('tool.executed', { sessionId: 's2', toolName: 'Read', timestamp: 1000 });

			const shown = lanes();
			expect(shown).toHaveLength(1);
			expect(shown[0].sessionId).toBe('s2');
			expect(shown[0].title).toBe('Two');
			expect(shown[0].agentId).toBe('a2');
		});

		it('does not create a lane for a metadata-only update to a never-active session', async () => {
			await activateWithSessions(SEED);
			stub.emit('session.updated', { sessionId: 's1', title: 'Renamed', status: 'busy' });
			stub.emit('session.created', { sessionId: 's9', title: 'Brand new', agentId: 'a9' });
			expect(lanes()).toHaveLength(0);

			// The metadata was still recorded: activity later shows the new title.
			stub.emit('tool.executed', { sessionId: 's1', toolName: 'Bash', timestamp: 1000 });
			const shown = lanes();
			expect(shown).toHaveLength(1);
			expect(shown[0].title).toBe('Renamed');
		});

		// CodeRabbit/Greptile on PR #1354: event handlers are registered before
		// sessions.list() resolves, so an event landing in that window carries
		// NEWER metadata than the list snapshot. The seed used to overwrite it.
		it('does not let the startup seed clobber metadata an event already set', async () => {
			plugin.deactivate();
			stub = makeStub(SEED);
			plugin.activate(stub.sdk);
			// Fires BEFORE the sessions.list() promise settles.
			stub.emit('session.updated', { sessionId: 's1', title: 'Renamed mid-flight' });
			await Promise.resolve();
			await Promise.resolve();

			stub.emit('tool.executed', { sessionId: 's1', toolName: 'Read', timestamp: 1000 });
			const shown = lanes();
			expect(shown).toHaveLength(1);
			// The stale list entry says "One"; the event said "Renamed mid-flight".
			expect(shown[0].title).toBe('Renamed mid-flight');
			// A field the event did NOT carry still comes from the seed.
			expect(shown[0].agentId).toBe('a1');
		});

		// CodeRabbit on PR #1354: session.created recorded the status into the meta
		// map but never copied it onto an already-live lane, so the lane displayed a
		// stale status until some later session.updated happened to arrive.
		it('copies status onto an existing lane on session.created', async () => {
			await activateWithSessions(SEED);
			stub.emit('tool.executed', { sessionId: 's1', toolName: 'Read', timestamp: 1000 });
			expect(lanes()[0].status).toBe('idle');

			stub.emit('session.created', { sessionId: 's1', title: 'One', status: 'busy' });
			expect(lanes()[0].status).toBe('busy');
		});

		it('gives the focused session a lane so the highlight has a target', async () => {
			await activateWithSessions(SEED);
			stub.emit('session.activated', { sessionId: 's3' });

			const shown = lanes();
			expect(shown).toHaveLength(1);
			expect(shown[0].sessionId).toBe('s3');
			expect(shown[0].title).toBe('Three');
			expect(stub.snapshot()?.focusedSessionId).toBe('s3');
		});
	});
});

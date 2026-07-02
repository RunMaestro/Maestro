/**
 * Tests for WindowRegistry - the single source of truth for window<->session
 * ownership. The registry only tracks BrowserWindows it is handed, so these
 * tests pass minimal fake BrowserWindow objects (just the methods the registry
 * calls: getBounds / isDestroyed).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { WindowRegistry, type WindowRegistryChange } from '../window-registry';

/** A fake BrowserWindow exposing only what the registry touches. */
function makeWindow(
	bounds: { x: number; y: number; width: number; height: number } = {
		x: 0,
		y: 0,
		width: 800,
		height: 600,
	},
	destroyed = false
): BrowserWindow {
	return {
		getBounds: vi.fn(() => bounds),
		isDestroyed: vi.fn(() => destroyed),
	} as unknown as BrowserWindow;
}

describe('WindowRegistry', () => {
	let registry: WindowRegistry;

	beforeEach(() => {
		registry = new WindowRegistry();
	});

	describe('create / get / remove', () => {
		it('registers a window with the supplied ID and defaults', () => {
			const bw = makeWindow();
			const id = registry.create({ windowId: 'w1', browserWindow: bw });

			expect(id).toBe('w1');
			const entry = registry.get('w1');
			expect(entry).toBeDefined();
			expect(entry?.id).toBe('w1');
			expect(entry?.browserWindow).toBe(bw);
			expect(entry?.sessionIds).toEqual([]);
			expect(entry?.isMain).toBe(false);
			// Panels default to expanded for a fresh window.
			expect(entry?.leftPanelCollapsed).toBe(false);
			expect(entry?.rightPanelCollapsed).toBe(false);
		});

		it('carries the panel-collapse state supplied at create time (layout restore)', () => {
			registry.create({
				windowId: 'w1',
				browserWindow: makeWindow(),
				leftPanelCollapsed: true,
				rightPanelCollapsed: false,
			});
			const entry = registry.get('w1');
			expect(entry?.leftPanelCollapsed).toBe(true);
			expect(entry?.rightPanelCollapsed).toBe(false);
		});

		it('generates a UUID when no windowId is supplied', () => {
			const id = registry.create({ browserWindow: makeWindow() });
			expect(id).toMatch(/^[0-9a-f-]{36}$/);
			expect(registry.get(id)).toBeDefined();
		});

		it('copies sessionIds so external mutation does not leak in', () => {
			const sessions = ['a', 'b'];
			registry.create({ windowId: 'w1', sessionIds: sessions, browserWindow: makeWindow() });
			sessions.push('c');
			expect(registry.get('w1')?.sessionIds).toEqual(['a', 'b']);
		});

		it('getAll returns every registered window', () => {
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			registry.create({ windowId: 'w2', browserWindow: makeWindow() });
			expect(registry.getAll().map((w) => w.id)).toEqual(['w1', 'w2']);
		});

		it('remove deletes the window', () => {
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			registry.remove('w1');
			expect(registry.get('w1')).toBeUndefined();
			expect(registry.getAll()).toHaveLength(0);
		});

		it('remove is a no-op for an unknown window', () => {
			const listener = vi.fn();
			registry.onChange(listener);
			registry.remove('nope');
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('getPrimary', () => {
		it('returns the isMain window', () => {
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			registry.create({ windowId: 'main', isMain: true, browserWindow: makeWindow() });
			expect(registry.getPrimary()?.id).toBe('main');
		});

		it('returns undefined when no primary is registered', () => {
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			expect(registry.getPrimary()).toBeUndefined();
		});
	});

	describe('getWindowForSession', () => {
		it('returns the owning window ID', () => {
			registry.create({ windowId: 'w1', sessionIds: ['s1', 's2'], browserWindow: makeWindow() });
			registry.create({ windowId: 'w2', sessionIds: ['s3'], browserWindow: makeWindow() });
			expect(registry.getWindowForSession('s2')).toBe('w1');
			expect(registry.getWindowForSession('s3')).toBe('w2');
		});

		it('returns null when no window owns the session', () => {
			registry.create({ windowId: 'w1', sessionIds: ['s1'], browserWindow: makeWindow() });
			expect(registry.getWindowForSession('ghost')).toBeNull();
		});
	});

	describe('setSessionsForWindow', () => {
		it('replaces the session list and emits a change', () => {
			const listener = vi.fn();
			registry.create({ windowId: 'w1', sessionIds: ['s1'], browserWindow: makeWindow() });
			registry.onChange(listener);

			registry.setSessionsForWindow('w1', ['s2', 's3']);

			expect(registry.get('w1')?.sessionIds).toEqual(['s2', 's3']);
			expect(listener).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'sessions-changed', windowId: 'w1' })
			);
		});

		it('is a no-op for an unknown window', () => {
			const listener = vi.fn();
			registry.onChange(listener);
			registry.setSessionsForWindow('nope', ['s1']);
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('setName', () => {
		it('sets a trimmed name and emits name-changed', () => {
			const listener = vi.fn();
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			registry.onChange(listener);

			registry.setName('w1', '  My Window  ');

			expect(registry.get('w1')?.name).toBe('My Window');
			expect(listener).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'name-changed', windowId: 'w1' })
			);
		});

		it('clears the name back to undefined for an empty/whitespace value', () => {
			registry.create({ windowId: 'w1', name: 'Old', browserWindow: makeWindow() });
			registry.setName('w1', '   ');
			expect(registry.get('w1')?.name).toBeUndefined();
		});

		it('does not emit when the name is unchanged', () => {
			registry.create({ windowId: 'w1', name: 'Same', browserWindow: makeWindow() });
			const listener = vi.fn();
			registry.onChange(listener);
			registry.setName('w1', 'Same');
			expect(listener).not.toHaveBeenCalled();
		});

		it('is a no-op for an unknown window', () => {
			const listener = vi.fn();
			registry.onChange(listener);
			registry.setName('nope', 'X');
			expect(listener).not.toHaveBeenCalled();
		});

		it('carries the name supplied at create time', () => {
			registry.create({ windowId: 'w1', name: 'Preset', browserWindow: makeWindow() });
			expect(registry.get('w1')?.name).toBe('Preset');
		});
	});

	describe('setPanelState', () => {
		it('applies provided fields (partial merge) and emits panel-changed', () => {
			const listener = vi.fn();
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			registry.onChange(listener);

			registry.setPanelState('w1', { leftPanelCollapsed: true });
			expect(registry.get('w1')?.leftPanelCollapsed).toBe(true);
			// Omitted field left untouched (still the create default).
			expect(registry.get('w1')?.rightPanelCollapsed).toBe(false);
			expect(listener).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'panel-changed', windowId: 'w1' })
			);
		});

		it('does not emit when the value is unchanged (no redundant persist)', () => {
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			const listener = vi.fn();
			registry.onChange(listener);
			// leftPanelCollapsed already defaults to false.
			registry.setPanelState('w1', { leftPanelCollapsed: false });
			expect(listener).not.toHaveBeenCalled();
		});

		it('is a no-op for an unknown window', () => {
			const listener = vi.fn();
			registry.onChange(listener);
			registry.setPanelState('nope', { leftPanelCollapsed: true });
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('moveSession', () => {
		beforeEach(() => {
			registry.create({ windowId: 'w1', sessionIds: ['s1', 's2'], browserWindow: makeWindow() });
			registry.create({ windowId: 'w2', sessionIds: [], browserWindow: makeWindow() });
		});

		it('moves a session between windows', () => {
			registry.moveSession('s1', 'w1', 'w2');
			expect(registry.get('w1')?.sessionIds).toEqual(['s2']);
			expect(registry.get('w2')?.sessionIds).toEqual(['s1']);
			expect(registry.getWindowForSession('s1')).toBe('w2');
		});

		it('does not duplicate a session already in the destination', () => {
			registry.setSessionsForWindow('w2', ['s1']);
			registry.moveSession('s1', 'w1', 'w2');
			expect(registry.get('w2')?.sessionIds).toEqual(['s1']);
		});

		it('emits a session-moved change', () => {
			const listener = vi.fn();
			registry.onChange(listener);
			registry.moveSession('s1', 'w1', 'w2');
			expect(listener).toHaveBeenCalledWith(
				expect.objectContaining({
					type: 'session-moved',
					sessionId: 's1',
					fromWindowId: 'w1',
					toWindowId: 'w2',
				})
			);
		});

		it('is a no-op when either window is unknown', () => {
			registry.moveSession('s1', 'w1', 'ghost');
			expect(registry.get('w1')?.sessionIds).toEqual(['s1', 's2']);
		});

		it('strips the session from every window, not just the named source', () => {
			// s1 has somehow ended up in both w1 and w2 (e.g. a prior stale move).
			registry.setSessionsForWindow('w2', ['s1']);
			registry.create({ windowId: 'w3', sessionIds: [], browserWindow: makeWindow() });

			registry.moveSession('s1', 'w1', 'w3');

			expect(registry.get('w1')?.sessionIds).toEqual(['s2']);
			expect(registry.get('w2')?.sessionIds).toEqual([]);
			expect(registry.get('w3')?.sessionIds).toEqual(['s1']);
			expect(registry.getWindowForSession('s1')).toBe('w3');
		});
	});

	describe('moveSession race conditions', () => {
		beforeEach(() => {
			registry.create({ windowId: 'w1', sessionIds: ['s1'], browserWindow: makeWindow() });
			registry.create({ windowId: 'w2', sessionIds: [], browserWindow: makeWindow() });
			registry.create({ windowId: 'w3', sessionIds: [], browserWindow: makeWindow() });
		});

		/** Assert every session is owned by exactly one window (no dups, no orphans). */
		function expectSingleOwnership(sessionIds: string[]): void {
			for (const sessionId of sessionIds) {
				const owners = registry
					.getAll()
					.filter((w) => w.sessionIds.includes(sessionId))
					.map((w) => w.id);
				expect(owners).toHaveLength(1);
			}
		}

		it('keeps a consistent ownership map when overlapping moves use a stale source', () => {
			// The first move relocates s1 to w2. The second move fires with the now-stale
			// fromWindowId 'w1' (the renderer captured it before the first move landed)
			// and aims at w3. A naive implementation would leave s1 owned by BOTH w2 and w3.
			registry.moveSession('s1', 'w1', 'w2');
			registry.moveSession('s1', 'w1', 'w3');

			expectSingleOwnership(['s1']);
			expect(registry.getWindowForSession('s1')).toBe('w3');
			expect(registry.get('w2')?.sessionIds).toEqual([]);
		});

		it('converges to a single owner under many overlapping moves of the same agent', () => {
			const targets = ['w2', 'w3', 'w1', 'w3', 'w2', 'w1', 'w3'];
			// Every move claims 'w1' as the source - all but the first are stale.
			for (const target of targets) {
				registry.moveSession('s1', 'w1', target);
			}

			expectSingleOwnership(['s1']);
			// The last move wins.
			expect(registry.getWindowForSession('s1')).toBe('w3');
		});

		it('serializes a re-entrant move triggered from a session-moved listener', () => {
			// A listener reacts to the first move by immediately moving s1 onward. The
			// queue must apply that nested move after the current one fully settles, so
			// the map never interleaves and the final ownership is consistent.
			let reentered = false;
			registry.onChange((change) => {
				if (change.type === 'session-moved' && change.toWindowId === 'w2' && !reentered) {
					reentered = true;
					registry.moveSession('s1', 'w2', 'w3');
				}
			});

			registry.moveSession('s1', 'w1', 'w2');

			expectSingleOwnership(['s1']);
			expect(registry.getWindowForSession('s1')).toBe('w3');
			expect(registry.get('w2')?.sessionIds).toEqual([]);
		});
	});

	describe('registerSession', () => {
		beforeEach(() => {
			registry.create({
				windowId: 'main',
				isMain: true,
				sessionIds: ['m1'],
				browserWindow: makeWindow(),
			});
			registry.create({ windowId: 'w2', sessionIds: [], browserWindow: makeWindow() });
		});

		it('claims a new agent for the given window and emits sessions-changed', () => {
			const listener = vi.fn();
			registry.onChange(listener);

			registry.registerSession('w2', 'fresh');

			expect(registry.get('w2')?.sessionIds).toEqual(['fresh']);
			expect(registry.getWindowForSession('fresh')).toBe('w2');
			expect(listener).toHaveBeenCalledWith(
				expect.objectContaining({ type: 'sessions-changed', windowId: 'w2' })
			);
		});

		it('strips the agent from every other window (single ownership)', () => {
			// 'fresh' is somehow already owned by the primary (e.g. a stale claim).
			registry.setSessionsForWindow('main', ['m1', 'fresh']);

			registry.registerSession('w2', 'fresh');

			expect(registry.get('main')?.sessionIds).toEqual(['m1']);
			expect(registry.get('w2')?.sessionIds).toEqual(['fresh']);
			expect(registry.getWindowForSession('fresh')).toBe('w2');
		});

		it('is a no-op (no change) when the window already solely owns the agent', () => {
			registry.registerSession('w2', 'fresh');
			const listener = vi.fn();
			registry.onChange(listener);

			registry.registerSession('w2', 'fresh');

			expect(registry.get('w2')?.sessionIds).toEqual(['fresh']);
			expect(listener).not.toHaveBeenCalled();
		});

		it('is a no-op for an unknown window', () => {
			const listener = vi.fn();
			registry.onChange(listener);

			registry.registerSession('ghost', 'fresh');

			expect(registry.getWindowForSession('fresh')).toBeNull();
			expect(listener).not.toHaveBeenCalled();
		});
	});

	describe('reclaimSessionsToPrimary', () => {
		it('moves every session from a secondary window into the primary', () => {
			registry.create({
				windowId: 'main',
				isMain: true,
				sessionIds: ['m1'],
				browserWindow: makeWindow(),
			});
			registry.create({ windowId: 'w2', sessionIds: ['s1', 's2'], browserWindow: makeWindow() });

			const result = registry.reclaimSessionsToPrimary('w2');

			expect(result).toEqual({ movedSessionIds: ['s1', 's2'], primaryWindowId: 'main' });
			expect(registry.get('main')?.sessionIds).toEqual(['m1', 's1', 's2']);
			expect(registry.get('w2')?.sessionIds).toEqual([]);
			expect(registry.getWindowForSession('s1')).toBe('main');
			expect(registry.getWindowForSession('s2')).toBe('main');
		});

		it('emits a session-moved change per reclaimed session', () => {
			registry.create({ windowId: 'main', isMain: true, browserWindow: makeWindow() });
			registry.create({ windowId: 'w2', sessionIds: ['s1', 's2'], browserWindow: makeWindow() });
			const listener = vi.fn();
			registry.onChange(listener);

			registry.reclaimSessionsToPrimary('w2');

			const moves = listener.mock.calls
				.map((c) => c[0] as WindowRegistryChange)
				.filter((c) => c.type === 'session-moved');
			expect(moves).toEqual([
				expect.objectContaining({ sessionId: 's1', fromWindowId: 'w2', toWindowId: 'main' }),
				expect.objectContaining({ sessionId: 's2', fromWindowId: 'w2', toWindowId: 'main' }),
			]);
		});

		it('returns an empty move list (with the primary id) when the window owns nothing', () => {
			registry.create({ windowId: 'main', isMain: true, browserWindow: makeWindow() });
			registry.create({ windowId: 'w2', sessionIds: [], browserWindow: makeWindow() });

			expect(registry.reclaimSessionsToPrimary('w2')).toEqual({
				movedSessionIds: [],
				primaryWindowId: 'main',
			});
		});

		it('returns null for an unknown window', () => {
			registry.create({ windowId: 'main', isMain: true, browserWindow: makeWindow() });
			expect(registry.reclaimSessionsToPrimary('ghost')).toBeNull();
		});

		it('returns null when asked to reclaim the primary itself', () => {
			registry.create({
				windowId: 'main',
				isMain: true,
				sessionIds: ['m1'],
				browserWindow: makeWindow(),
			});
			expect(registry.reclaimSessionsToPrimary('main')).toBeNull();
			expect(registry.get('main')?.sessionIds).toEqual(['m1']);
		});

		it('returns null when no primary is registered', () => {
			registry.create({ windowId: 'w2', sessionIds: ['s1'], browserWindow: makeWindow() });
			expect(registry.reclaimSessionsToPrimary('w2')).toBeNull();
			expect(registry.get('w2')?.sessionIds).toEqual(['s1']);
		});

		it('does not duplicate a session the primary already owns', () => {
			registry.create({
				windowId: 'main',
				isMain: true,
				sessionIds: ['s1'],
				browserWindow: makeWindow(),
			});
			registry.create({ windowId: 'w2', sessionIds: ['s1', 's2'], browserWindow: makeWindow() });

			registry.reclaimSessionsToPrimary('w2');

			expect(registry.get('main')?.sessionIds).toEqual(['s1', 's2']);
			expect(registry.get('w2')?.sessionIds).toEqual([]);
		});
	});

	describe('findWindowAtPoint', () => {
		it('returns the window whose bounds contain the point', () => {
			registry.create({
				windowId: 'left',
				browserWindow: makeWindow({ x: 0, y: 0, width: 500, height: 500 }),
			});
			registry.create({
				windowId: 'right',
				browserWindow: makeWindow({ x: 600, y: 0, width: 500, height: 500 }),
			});
			expect(registry.findWindowAtPoint(700, 250)).toBe('right');
			expect(registry.findWindowAtPoint(100, 100)).toBe('left');
		});

		it('returns null when the point is outside every window', () => {
			registry.create({
				windowId: 'w1',
				browserWindow: makeWindow({ x: 0, y: 0, width: 100, height: 100 }),
			});
			expect(registry.findWindowAtPoint(5000, 5000)).toBeNull();
		});

		it('treats the right/bottom edges as exclusive', () => {
			registry.create({
				windowId: 'w1',
				browserWindow: makeWindow({ x: 0, y: 0, width: 100, height: 100 }),
			});
			// Top-left corner is inside; the bottom-right corner is not.
			expect(registry.findWindowAtPoint(0, 0)).toBe('w1');
			expect(registry.findWindowAtPoint(100, 100)).toBeNull();
		});

		it('skips destroyed windows', () => {
			registry.create({
				windowId: 'dead',
				browserWindow: makeWindow({ x: 0, y: 0, width: 500, height: 500 }, true),
			});
			expect(registry.findWindowAtPoint(100, 100)).toBeNull();
		});
	});

	describe('change signal', () => {
		it('emits on create and remove with the window ID', () => {
			const changes: WindowRegistryChange[] = [];
			registry.onChange((c) => changes.push(c));

			const id = registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			registry.remove(id);

			expect(changes).toEqual([
				{ type: 'created', windowId: 'w1' },
				{ type: 'removed', windowId: 'w1' },
			]);
		});

		it('onChange returns an unsubscribe that stops further notifications', () => {
			const listener = vi.fn();
			const unsubscribe = registry.onChange(listener);
			unsubscribe();
			registry.create({ windowId: 'w1', browserWindow: makeWindow() });
			expect(listener).not.toHaveBeenCalled();
		});
	});
});

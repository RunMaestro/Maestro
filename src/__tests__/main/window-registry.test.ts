/**
 * Tests for the WindowRegistry's window-kind queries: feature windows (the
 * cadenza HUD, Quick Chat, floating widgets) own no agents and must never pass
 * for an app window in the multi-window machinery.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { WindowRegistry, type WindowKind } from '../../main/window-registry';

const FEATURE_WINDOW_KINDS: WindowKind[] = ['cadenza-hud', 'quick-chat', 'floating-widget'];

function makeWindow(): BrowserWindow {
	return {
		getBounds: vi.fn(() => ({ x: 0, y: 0, width: 800, height: 600 })),
		isDestroyed: vi.fn(() => false),
	} as unknown as BrowserWindow;
}

describe('WindowRegistry window kinds', () => {
	let registry: WindowRegistry;

	beforeEach(() => {
		registry = new WindowRegistry();
	});

	it('defaults a registered window to the app kind', () => {
		const id = registry.create({ browserWindow: makeWindow(), isMain: true });

		expect(registry.get(id)?.kind).toBe('app');
	});

	it.each(FEATURE_WINDOW_KINDS)('leaves a %s window out of getAppWindows', (kind) => {
		const appId = registry.create({ browserWindow: makeWindow(), isMain: true });
		const featureId = registry.create({ browserWindow: makeWindow(), kind });

		expect(registry.getAppWindows().map((entry) => entry.id)).toEqual([appId]);
		expect(registry.getByKind(kind)?.id).toBe(featureId);
		expect(registry.getPrimary()?.id).toBe(appId);
	});

	it.each(FEATURE_WINDOW_KINDS)('reports a %s window as a feature window', (kind) => {
		const featureWin = makeWindow();
		registry.create({ browserWindow: featureWin, kind });

		expect(registry.isFeatureWindow(featureWin)).toBe(true);
	});

	it('does not report an app window or an untracked window as a feature window', () => {
		const appWin = makeWindow();
		registry.create({ browserWindow: appWin, isMain: true });

		expect(registry.isFeatureWindow(appWin)).toBe(false);
		expect(registry.isFeatureWindow(makeWindow())).toBe(false);
	});

	it('stops reporting a feature window once it is removed', () => {
		const featureWin = makeWindow();
		const id = registry.create({ browserWindow: featureWin, kind: 'floating-widget' });

		registry.remove(id);

		expect(registry.isFeatureWindow(featureWin)).toBe(false);
	});
});

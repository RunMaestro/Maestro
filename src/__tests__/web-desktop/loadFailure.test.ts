/**
 * Unit tests for the web-desktop load-failure policy.
 *
 * Regression cover for #1387: a tab left open across a Maestro rebuild holds a
 * stale module graph, so the first lazily-imported chunk 404s. That used to hit
 * index.html's boot error handler, which wiped #root and blamed the user's
 * Wi-Fi. The policy here must instead reload once (stale asset), and must leave
 * a running app alone for unrelated rejections.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	RELOAD_COOLDOWN_MS,
	decideLoadFailureAction,
	installLoadFailureHandler,
	isStaleAssetFailure,
	markBooted,
	markReloadAttempt,
	readLastReloadAt,
} from '../../web-desktop/loadFailure';

/** Minimal in-memory Storage stand-in. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (k: string) => map.get(k) ?? null,
		setItem: (k: string, v: string) => void map.set(k, v),
		removeItem: (k: string) => void map.delete(k),
		clear: () => map.clear(),
		key: (i: number) => Array.from(map.keys())[i] ?? null,
		get length() {
			return map.size;
		},
	} as Storage;
}

describe('isStaleAssetFailure', () => {
	// The exact strings each engine produces when a hashed chunk is gone. These
	// are the only signal available - none of the engines expose an error code.
	it.each([
		// Chromium/Edge - the message from the #1387 report, verbatim.
		'Failed to fetch dynamically imported module: http://192.168.178.109:41713/f30ef190/desktop/assets/dist-Bwv2dFcV.js',
		// Firefox
		'error loading dynamically imported module',
		// Safari/WebKit
		'Importing a module script failed.',
		// Vite preload helper for a missing CSS chunk
		'Unable to preload CSS for /assets/Modal-a1b2c3.css',
	])('recognizes %s', (message) => {
		expect(isStaleAssetFailure(new Error(message))).toBe(true);
	});

	it('reads the message off non-Error rejection reasons', () => {
		expect(isStaleAssetFailure('Failed to fetch dynamically imported module: /a.js')).toBe(true);
		expect(isStaleAssetFailure({ message: 'Importing a module script failed.' })).toBe(true);
	});

	it('does not claim unrelated failures', () => {
		expect(isStaleAssetFailure(new Error('Cannot read properties of undefined'))).toBe(false);
		expect(isStaleAssetFailure(new TypeError('NetworkError when attempting to fetch'))).toBe(false);
		expect(isStaleAssetFailure(undefined)).toBe(false);
		expect(isStaleAssetFailure(null)).toBe(false);
	});
});

describe('decideLoadFailureAction', () => {
	const staleError = new Error('Failed to fetch dynamically imported module: /assets/x-abc.js');

	it('reloads on a stale asset when no reload has been attempted', () => {
		expect(decideLoadFailureAction(staleError, { booted: true, now: 1000, lastReloadAt: 0 })).toBe(
			'reload'
		);
	});

	it('reloads on a stale asset that fails before the app has booted', () => {
		expect(decideLoadFailureAction(staleError, { booted: false, now: 1000, lastReloadAt: 0 })).toBe(
			'reload'
		);
	});

	it('stops reloading and shows the error when a reload just happened', () => {
		expect(
			decideLoadFailureAction(staleError, {
				booted: true,
				now: 1_000_000,
				lastReloadAt: 1_000_000 - (RELOAD_COOLDOWN_MS - 1),
			})
		).toBe('show-error');
	});

	it('allows a fresh auto-reload once the cooldown has elapsed', () => {
		// A long-lived tab can legitimately meet a second rebuild hours later.
		expect(
			decideLoadFailureAction(staleError, {
				booted: true,
				now: 10_000_000,
				lastReloadAt: 10_000_000 - (RELOAD_COOLDOWN_MS + 1),
			})
		).toBe('reload');
	});

	it('ignores unrelated rejections once the app is running', () => {
		// The core of #1387: never tear down a mounted app over an app-level
		// rejection - the React error boundary handles those in context.
		expect(
			decideLoadFailureAction(new Error('some app bug'), {
				booted: true,
				now: 1000,
				lastReloadAt: 0,
			})
		).toBe('ignore');
	});

	it('shows the error surface for unrelated failures before boot', () => {
		expect(
			decideLoadFailureAction(new Error('SyntaxError: unexpected token'), {
				booted: false,
				now: 1000,
				lastReloadAt: 0,
			})
		).toBe('show-error');
	});
});

describe('reload guard storage', () => {
	it('round-trips the reload timestamp', () => {
		const storage = fakeStorage();
		expect(readLastReloadAt(storage)).toBe(0);
		markReloadAttempt(1234, storage);
		expect(readLastReloadAt(storage)).toBe(1234);
	});

	it('treats a corrupt value as no reload', () => {
		expect(readLastReloadAt(fakeStorage({ 'maestro:stale-asset-reload-at': 'nope' }))).toBe(0);
	});

	it('never throws when storage is unavailable or blocked', () => {
		const blocked = {
			getItem: () => {
				throw new Error('blocked');
			},
			setItem: () => {
				throw new Error('blocked');
			},
		} as unknown as Storage;
		expect(readLastReloadAt(blocked)).toBe(0);
		expect(() => markReloadAttempt(1, blocked)).not.toThrow();
		expect(readLastReloadAt(undefined)).toBe(0);
		expect(() => markReloadAttempt(1, undefined)).not.toThrow();
	});
});

describe('installLoadFailureHandler', () => {
	interface TestWindow {
		__maestroShowBootError?: ReturnType<typeof vi.fn>;
		__maestroHandleLoadFailure?: (reason: unknown) => void;
		__maestroBooted?: boolean;
	}

	const testWindow = () => window as unknown as TestWindow;
	let reload: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.restoreAllMocks();
		window.sessionStorage.clear();
		delete testWindow().__maestroBooted;
		delete testWindow().__maestroHandleLoadFailure;
		reload = vi.fn();
		// jsdom's location.reload is not writable; redefine it for the test.
		Object.defineProperty(window, 'location', {
			configurable: true,
			value: { ...window.location, reload },
		});
		testWindow().__maestroShowBootError = vi.fn();
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		installLoadFailureHandler();
	});

	const fire = (reason: unknown) => testWindow().__maestroHandleLoadFailure?.(reason);

	it('reloads once on a stale chunk and records the attempt', () => {
		markBooted();
		fire(new Error('Failed to fetch dynamically imported module: /assets/x-abc.js'));

		expect(reload).toHaveBeenCalledTimes(1);
		expect(testWindow().__maestroShowBootError).not.toHaveBeenCalled();
		expect(readLastReloadAt(window.sessionStorage)).toBeGreaterThan(0);
	});

	it('shows a stale-asset specific hint instead of reloading in a loop', () => {
		markBooted();
		fire(new Error('Failed to fetch dynamically imported module: /assets/x-abc.js'));
		reload.mockClear();

		// Second failure inside the cooldown: stop reloading, explain honestly.
		fire(new Error('Failed to fetch dynamically imported module: /assets/y-def.js'));

		expect(reload).not.toHaveBeenCalled();
		const [, , hint] = testWindow().__maestroShowBootError!.mock.calls[0];
		expect(hint).toMatch(/updated or restarted/i);
		// The misleading network copy must not be what the user sees here.
		expect(hint).not.toMatch(/Wi-Fi/i);
	});

	it('leaves a mounted app untouched on an unrelated rejection', () => {
		markBooted();
		fire(new Error('some app-level bug'));

		expect(reload).not.toHaveBeenCalled();
		expect(testWindow().__maestroShowBootError).not.toHaveBeenCalled();
	});

	it('still surfaces unrelated failures that happen before boot', () => {
		fire(new Error('SyntaxError: unexpected token'));

		expect(reload).not.toHaveBeenCalled();
		expect(testWindow().__maestroShowBootError).toHaveBeenCalledTimes(1);
		// No stale-asset hint - falls through to the inline default (network).
		expect(testWindow().__maestroShowBootError!.mock.calls[0][2]).toBeUndefined();
	});
});

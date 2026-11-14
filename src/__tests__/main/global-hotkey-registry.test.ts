/**
 * @file global-hotkey-registry.test.ts
 *
 * The named global hotkey registry: several ids at once, per-id failure that
 * does not take the others down, conflict detection between two Maestro
 * hotkeys, rebinding, and that the migrated `showMaestro` hotkey still behaves
 * exactly as it did when it was the only one.
 *
 * The Electron `globalShortcut` API is injected as a backend, so nothing here
 * needs a main process. `keysToAccelerator` is exercised through the registry
 * rather than in isolation, because the property that matters is what ends up
 * bound.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('electron', () => ({
	app: { show: vi.fn() },
	BrowserWindow: class {},
	globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
}));

vi.mock('../../shared/platformDetection', () => ({
	isMacOS: () => true,
	isWindows: () => false,
	isLinux: () => false,
}));

import {
	GlobalHotkeyRegistry,
	keysToAccelerator,
	type GlobalShortcutBackend,
} from '../../main/global-hotkey-manager';
import { SHOW_MAESTRO_HOTKEY_ID } from '../../shared/global-hotkeys';

// ---------------------------------------------------------------------------
// Fake backend
// ---------------------------------------------------------------------------

class FakeBackend implements GlobalShortcutBackend {
	readonly bound = new Map<string, () => void>();
	/** Accelerators the "OS" refuses. */
	readonly refuse = new Set<string>();
	/** Accelerators whose registration throws. */
	readonly explode = new Set<string>();
	readonly unregistered: string[] = [];

	register(accelerator: string, callback: () => void): boolean {
		if (this.explode.has(accelerator)) throw new Error('boom');
		if (this.refuse.has(accelerator)) return false;
		this.bound.set(accelerator, callback);
		return true;
	}

	unregister(accelerator: string): void {
		this.unregistered.push(accelerator);
		this.bound.delete(accelerator);
	}

	fire(accelerator: string): void {
		this.bound.get(accelerator)?.();
	}
}

describe('keysToAccelerator', () => {
	it('translates modifiers and upper-cases single letters', () => {
		expect(keysToAccelerator(['Meta', 'Shift', 'm'])).toBe('Command+Shift+M');
		expect(keysToAccelerator(['Alt', 'Ctrl', 'F5'])).toBe('Alt+Control+F5');
	});

	it('returns null without a non-modifier key', () => {
		expect(keysToAccelerator([])).toBeNull();
		expect(keysToAccelerator(['Meta', 'Shift'])).toBeNull();
	});
});

describe('GlobalHotkeyRegistry', () => {
	let backend: FakeBackend;
	let registry: GlobalHotkeyRegistry;

	beforeEach(() => {
		backend = new FakeBackend();
		registry = new GlobalHotkeyRegistry(backend);
	});

	it('registers several ids independently and routes each to its own handler', () => {
		const show = vi.fn();
		const voice = vi.fn();
		registry.define(SHOW_MAESTRO_HOTKEY_ID, show);
		registry.define('voiceConductor', voice);

		expect(registry.setKeys(SHOW_MAESTRO_HOTKEY_ID, ['Meta', 'Shift', 'm']).registered).toBe(true);
		expect(registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']).registered).toBe(true);

		backend.fire('Command+Shift+M');
		backend.fire('Command+Alt+V');
		expect(show).toHaveBeenCalledTimes(1);
		expect(voice).toHaveBeenCalledTimes(1);
	});

	it('fails one id without disturbing the others', () => {
		backend.refuse.add('Command+Alt+V');
		registry.setKeys(SHOW_MAESTRO_HOTKEY_ID, ['Meta', 'Shift', 'm']);
		const failed = registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']);

		expect(failed.registered).toBe(false);
		expect(failed.reason).toBe('os-conflict');
		expect(registry.status(SHOW_MAESTRO_HOTKEY_ID)?.registered).toBe(true);
		expect(backend.bound.has('Command+Shift+M')).toBe(true);
	});

	it('reports a registration that threw as its own reason', () => {
		backend.explode.add('Command+Alt+V');
		const status = registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']);
		expect(status.reason).toBe('register-error');
		expect(status.message).toContain('boom');
	});

	it('detects a conflict between two Maestro hotkeys and names the holder', () => {
		registry.setKeys(SHOW_MAESTRO_HOTKEY_ID, ['Meta', 'Alt', 'v']);
		const clash = registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']);

		expect(clash.registered).toBe(false);
		expect(clash.reason).toBe('maestro-conflict');
		expect(clash.conflictsWith).toBe(SHOW_MAESTRO_HOTKEY_ID);
		// The first hotkey keeps the combo rather than silently losing it.
		expect(registry.status(SHOW_MAESTRO_HOTKEY_ID)?.registered).toBe(true);
	});

	it('lets an id rebind onto the combo it already holds', () => {
		registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']);
		const again = registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']);
		expect(again.registered).toBe(true);
		expect(again.reason).toBeUndefined();
	});

	it('releases the previous combo on rebind', () => {
		registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']);
		registry.setKeys('voiceConductor', ['Meta', 'Alt', 'b']);

		expect(backend.unregistered).toContain('Command+Alt+V');
		expect(backend.bound.has('Command+Alt+V')).toBe(false);
		expect(backend.bound.has('Command+Alt+B')).toBe(true);
	});

	it('frees a combo for another id once the first releases it', () => {
		registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']);
		registry.setKeys('voiceConductor', []);
		const second = registry.setKeys('voiceCurrentAgent', ['Meta', 'Alt', 'v']);
		expect(second.registered).toBe(true);
	});

	it('treats an empty key array as a deliberate clear, not a failure', () => {
		const failures: string[] = [];
		registry.onFailure((status) => failures.push(status.id));
		const status = registry.setKeys('voiceConductor', []);

		expect(status.registered).toBe(false);
		expect(status.reason).toBeUndefined();
		expect(failures).toEqual([]);
	});

	it('rejects a modifier-only combo with a distinct reason', () => {
		const status = registry.setKeys('voiceConductor', ['Meta', 'Shift']);
		expect(status.reason).toBe('invalid-accelerator');
	});

	it('reports every failure through one listener with the failing id', () => {
		backend.refuse.add('Command+Alt+V');
		const seen: Array<{ id: string; reason?: string }> = [];
		registry.onFailure((status) => seen.push({ id: status.id, reason: status.reason }));

		registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']);
		expect(seen).toEqual([{ id: 'voiceConductor', reason: 'os-conflict' }]);
	});

	it('survives a failure listener that throws', () => {
		backend.refuse.add('Command+Alt+V');
		registry.onFailure(() => {
			throw new Error('window gone');
		});
		expect(() => registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v'])).not.toThrow();
	});

	it('binds a handler defined after the keys were set', () => {
		backend.refuse.add('Command+Alt+V');
		registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']);
		backend.refuse.clear();

		const handler = vi.fn();
		registry.define('voiceConductor', handler);

		expect(registry.status('voiceConductor')?.registered).toBe(true);
		backend.fire('Command+Alt+V');
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('routes to the handler live, so a redefine takes effect on the next press', () => {
		const first = vi.fn();
		const second = vi.fn();
		registry.define('voiceConductor', first);
		registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']);
		registry.define('voiceConductor', second);

		backend.fire('Command+Alt+V');
		expect(first).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledTimes(1);
	});

	it('disposeAll releases every combo', () => {
		registry.setKeys(SHOW_MAESTRO_HOTKEY_ID, ['Meta', 'Shift', 'm']);
		registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']);
		registry.disposeAll();

		expect(backend.bound.size).toBe(0);
		expect(registry.allStatuses().every((status) => !status.registered)).toBe(true);
	});

	it('remove forgets the id entirely', () => {
		registry.define('voiceConductor', vi.fn());
		registry.setKeys('voiceConductor', ['Meta', 'Alt', 'v']);
		registry.remove('voiceConductor');

		expect(registry.status('voiceConductor')).toBeNull();
		expect(backend.bound.has('Command+Alt+V')).toBe(false);
	});

	describe('migrated showMaestro behaviour', () => {
		it('binds, rebinds, and clears exactly as the singleton did', () => {
			const summon = vi.fn();
			registry.define(SHOW_MAESTRO_HOTKEY_ID, summon);

			expect(registry.setKeys(SHOW_MAESTRO_HOTKEY_ID, ['Meta', 'Shift', 'm']).registered).toBe(
				true
			);
			backend.fire('Command+Shift+M');
			expect(summon).toHaveBeenCalledTimes(1);

			registry.setKeys(SHOW_MAESTRO_HOTKEY_ID, ['Meta', 'Shift', 'k']);
			backend.fire('Command+Shift+M');
			expect(summon).toHaveBeenCalledTimes(1);
			backend.fire('Command+Shift+K');
			expect(summon).toHaveBeenCalledTimes(2);

			registry.setKeys(SHOW_MAESTRO_HOTKEY_ID, []);
			expect(backend.bound.size).toBe(0);
		});
	});
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

let nextBrowserWindowId = 1;
const browserWindowOptions: unknown[] = [];

class MockBrowserWindow {
	id: number;

	constructor(options: unknown) {
		this.id = nextBrowserWindowId;
		nextBrowserWindowId += 1;
		browserWindowOptions.push(options);
	}
}

vi.mock('electron', () => ({
	BrowserWindow: MockBrowserWindow,
}));

describe('WindowRegistry', () => {
	beforeEach(() => {
		nextBrowserWindowId = 1;
		browserWindowOptions.length = 0;
	});

	it('creates the first window as the primary window', async () => {
		const { WindowRegistry } = await import('../../main/window-registry');
		const registry = new WindowRegistry();

		const entry = registry.create({
			width: 1200,
			height: 800,
			sessionIds: ['session-1'],
		});

		expect(entry.isMain).toBe(true);
		expect(entry.sessionIds).toEqual(['session-1']);
		expect(registry.getPrimary()).toBe(entry);
		expect(registry.get('1')).toBe(entry);
		expect(browserWindowOptions).toEqual([{ width: 1200, height: 800 }]);
	});

	it('tracks secondary windows by explicit id', async () => {
		const { WindowRegistry } = await import('../../main/window-registry');
		const registry = new WindowRegistry();

		const primary = registry.create({ id: 'primary' });
		const secondary = registry.create({ id: 'secondary', sessionIds: ['session-2'] });

		expect(registry.getAll()).toEqual([primary, secondary]);
		expect(registry.getPrimary()).toBe(primary);
		expect(secondary.isMain).toBe(false);
		expect(registry.getWindowForSession('session-2')).toBe('secondary');
	});

	it('keeps session ownership unique when assigning sessions', async () => {
		const { WindowRegistry } = await import('../../main/window-registry');
		const registry = new WindowRegistry();

		const primary = registry.create({ id: 'primary', sessionIds: ['session-1', 'session-2'] });
		const secondary = registry.create({ id: 'secondary' });

		registry.setSessionsForWindow('secondary', ['session-2', 'session-3', 'session-3']);

		expect(primary.sessionIds).toEqual(['session-1']);
		expect(secondary.sessionIds).toEqual(['session-2', 'session-3']);
		expect(registry.getWindowForSession('session-2')).toBe('secondary');
	});

	it('moves a session between windows without duplicating it', async () => {
		const { WindowRegistry } = await import('../../main/window-registry');
		const registry = new WindowRegistry();

		const primary = registry.create({ id: 'primary', sessionIds: ['session-1', 'session-2'] });
		const secondary = registry.create({ id: 'secondary', sessionIds: ['session-3'] });

		registry.moveSession('session-2', 'primary', 'secondary');
		registry.moveSession('session-2', 'primary', 'secondary');

		expect(primary.sessionIds).toEqual(['session-1']);
		expect(secondary.sessionIds).toEqual(['session-3', 'session-2']);
		expect(registry.getWindowForSession('session-2')).toBe('secondary');
	});

	it('removes windows and clears the primary reference when the main window is removed', async () => {
		const { WindowRegistry } = await import('../../main/window-registry');
		const registry = new WindowRegistry();

		registry.create({ id: 'primary' });
		registry.create({ id: 'secondary' });

		registry.remove('secondary');
		expect(registry.get('secondary')).toBeUndefined();
		expect(registry.getPrimary()).toBeDefined();

		registry.remove('primary');
		expect(registry.getPrimary()).toBeUndefined();
	});

	it('throws for duplicate windows and unknown move targets', async () => {
		const { WindowRegistry } = await import('../../main/window-registry');
		const registry = new WindowRegistry();

		registry.create({ id: 'primary' });

		expect(() => registry.create({ id: 'primary' })).toThrow('Window already registered: primary');
		expect(() => registry.moveSession('session-1', 'missing', 'primary')).toThrow(
			'Source window not registered: missing'
		);
		expect(() => registry.moveSession('session-1', 'primary', 'missing')).toThrow(
			'Destination window not registered: missing'
		);
	});
});

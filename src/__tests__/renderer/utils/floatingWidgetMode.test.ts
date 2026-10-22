import { afterEach, describe, expect, it, vi } from 'vitest';

const web = vi.hoisted(() => ({ value: false }));
vi.mock('../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => web.value }));

import { floatingWidgetsAvailable } from '../../../renderer/utils/floatingWidgetMode';

const maestro = window.maestro as unknown as Record<string, unknown>;
const original = maestro.floatingWidgets;

afterEach(() => {
	web.value = false;
	maestro.floatingWidgets = original;
});

describe('floatingWidgetsAvailable', () => {
	it('is true in the desktop app when the preload exposes the API', () => {
		maestro.floatingWidgets = {};
		expect(floatingWidgetsAvailable()).toBe(true);
	});

	it('is false in the desktop app when the API is absent', () => {
		maestro.floatingWidgets = undefined;
		expect(floatingWidgetsAvailable()).toBe(false);
	});

	it('is false in the web-desktop browser even when the API is present', () => {
		web.value = true;
		maestro.floatingWidgets = {};
		expect(floatingWidgetsAvailable()).toBe(false);
	});

	it('is false in the web-desktop browser when the API is absent', () => {
		web.value = true;
		maestro.floatingWidgets = undefined;
		expect(floatingWidgetsAvailable()).toBe(false);
	});
});

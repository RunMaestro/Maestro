import { afterEach, describe, expect, it, vi } from 'vitest';

const web = vi.hoisted(() => ({ value: false }));
vi.mock('../../../renderer/utils/runtimeContext', () => ({ isWebDesktop: () => web.value }));

import { canOpenComputerHistory } from '../../../renderer/utils/computerHistoryAvailability';

afterEach(() => {
	web.value = false;
});

describe('canOpenComputerHistory', () => {
	it('needs the Encore flag on', () => {
		expect(canOpenComputerHistory({ computerHistory: true })).toBe(true);
		expect(canOpenComputerHistory({ computerHistory: false })).toBe(false);
		expect(canOpenComputerHistory({})).toBe(false);
		expect(canOpenComputerHistory(undefined)).toBe(false);
	});

	it('is never offered in the web-desktop browser, whose bridge denies the channels', () => {
		web.value = true;
		expect(canOpenComputerHistory({ computerHistory: true })).toBe(false);
	});
});

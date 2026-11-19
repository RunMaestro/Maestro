import { describe, it, expect, vi, beforeEach } from 'vitest';

const settings = new Map<string, unknown>();
let initialized = true;

vi.mock('../../../main/utils/cliDetection', () => ({
	resolveGhPath: vi.fn(async (custom?: string) => custom ?? '/usr/local/bin/gh'),
}));
vi.mock('../../../main/stores/instances', () => ({ isInitialized: () => initialized }));
vi.mock('../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: (key: string) => settings.get(key) }),
}));

import { resolveConfiguredGhCommand } from '../../../main/utils/gh-command';
import { resolveGhPath } from '../../../main/utils/cliDetection';

describe('resolveConfiguredGhCommand', () => {
	beforeEach(() => {
		settings.clear();
		initialized = true;
		vi.clearAllMocks();
	});

	it('uses the configured gh path, trimmed', async () => {
		settings.set('ghPath', '  /opt/gh  ');
		expect(await resolveConfiguredGhCommand()).toBe('/opt/gh');
		expect(resolveGhPath).toHaveBeenCalledWith('/opt/gh');
	});

	it('auto-detects when the setting is blank or not a string', async () => {
		settings.set('ghPath', '   ');
		expect(await resolveConfiguredGhCommand()).toBe('/usr/local/bin/gh');
		settings.set('ghPath', 42);
		expect(await resolveConfiguredGhCommand()).toBe('/usr/local/bin/gh');
	});

	it('auto-detects without touching the stores before they are initialised', async () => {
		initialized = false;
		settings.set('ghPath', '/opt/gh');
		expect(await resolveConfiguredGhCommand()).toBe('/usr/local/bin/gh');
		expect(resolveGhPath).toHaveBeenCalledWith();
	});
});

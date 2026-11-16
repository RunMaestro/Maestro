import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetACappellaTransport = vi.fn();

vi.mock('electron', () => ({
	ipcMain: { handle: vi.fn() },
}));

vi.mock('../../../../main/acappella', () => ({
	getACappellaTransport: () => mockGetACappellaTransport(),
}));

import { setVoiceDiscovery } from '../../../../main/ipc/handlers/acappella-devices';
import { ACAPPELLA_DISABLED_ERROR } from '../../../../shared/acappella/feature-flag';

describe('setVoiceDiscovery', () => {
	const start = vi.fn().mockResolvedValue(undefined);
	const stop = vi.fn().mockResolvedValue(undefined);
	const discoveryStatus = vi.fn().mockReturnValue({ state: 'disabled' });
	let enabled = false;

	beforeEach(() => {
		enabled = false;
		start.mockClear();
		stop.mockClear();
		discoveryStatus.mockClear();
		mockGetACappellaTransport.mockReturnValue({
			featureEnabled: () => enabled,
			discovery: { start, stop },
			discoveryStatus,
		});
	});

	it('refuses to start discovery when aCappella is disabled', async () => {
		await expect(setVoiceDiscovery(true)).rejects.toThrow(ACAPPELLA_DISABLED_ERROR);
		expect(start).not.toHaveBeenCalled();
	});

	it('allows stopping discovery even when aCappella is disabled', async () => {
		await expect(setVoiceDiscovery(false)).resolves.toEqual({ state: 'disabled' });
		expect(stop).toHaveBeenCalledTimes(1);
	});

	it('starts discovery when aCappella is enabled', async () => {
		enabled = true;
		await expect(setVoiceDiscovery(true)).resolves.toEqual({ state: 'disabled' });
		expect(start).toHaveBeenCalledTimes(1);
	});
});

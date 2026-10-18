import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toggleInAppToasts } from '../../../renderer/services/inAppToasts';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';

vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

describe('toggleInAppToasts', () => {
	beforeEach(() => {
		vi.mocked(notifyCenterFlash).mockClear();
		useSettingsStore.setState({ toastDuration: 10, toastDurationBeforeOff: 20 });
	});

	it('turns toasts off and acknowledges with a center flash, not a toast', () => {
		expect(toggleInAppToasts()).toBe(false);
		expect(useSettingsStore.getState().toastDuration).toBe(-1);
		expect(notifyCenterFlash).toHaveBeenCalledWith(
			expect.objectContaining({ message: 'In-App Toasts: OFF' })
		);
	});

	it('turns toasts back on at the duration they had before', () => {
		toggleInAppToasts();
		expect(toggleInAppToasts()).toBe(true);
		expect(useSettingsStore.getState().toastDuration).toBe(10);
		expect(notifyCenterFlash).toHaveBeenLastCalledWith(
			expect.objectContaining({ message: 'In-App Toasts: ON' })
		);
	});
});

/**
 * @file launchFromSettings.test.ts
 *
 * Settings sits above every other modal in the stacking order, so a modal
 * launched from inside it has to dismiss Settings first or it renders behind
 * the settings surface and looks like nothing happened. These tests pin both
 * halves of that contract: Settings closes, and it closes BEFORE the launcher
 * runs (a launcher that reopens Settings, e.g. a deep link back into a tab,
 * must win).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { launchFromSettings } from '../../../renderer/utils/launchFromSettings';
import { useModalStore } from '../../../renderer/stores/modalStore';

describe('launchFromSettings', () => {
	beforeEach(() => {
		useModalStore.getState().closeAll();
	});

	it('closes the settings modal before running the launcher', () => {
		useModalStore.getState().openModal('settings', { tab: 'general' });
		const openedWhileSettingsClosed = vi.fn(() => useModalStore.getState().isOpen('settings'));

		launchFromSettings(() => {
			openedWhileSettingsClosed();
			useModalStore.getState().openModal('pianolaModal');
		});

		expect(openedWhileSettingsClosed).toHaveReturnedWith(false);
		expect(useModalStore.getState().isOpen('settings')).toBe(false);
		expect(useModalStore.getState().isOpen('pianolaModal')).toBe(true);
	});

	it('still runs the launcher when settings was never open', () => {
		const open = vi.fn();

		launchFromSettings(open);

		expect(open).toHaveBeenCalledTimes(1);
		expect(useModalStore.getState().isOpen('settings')).toBe(false);
	});
});

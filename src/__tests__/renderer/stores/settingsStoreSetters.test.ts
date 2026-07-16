import { describe, expect, it, vi } from 'vitest';
import {
	createInputAndLayoutSetters,
	createShellAndAppearanceSetters,
} from '../../../renderer/stores/settingsStoreSetters';

describe('createShellAndAppearanceSetters', () => {
	it('updates and persists each supplied value through the explicit boundary', () => {
		const set = vi.fn();
		const persist = vi.fn();
		const setters = createShellAndAppearanceSetters(set, persist);

		setters.setDefaultShell('fish');
		setters.setFontSize(16);
		setters.setActiveThemeId('dracula');

		expect(set).toHaveBeenNthCalledWith(1, { defaultShell: 'fish' });
		expect(set).toHaveBeenNthCalledWith(2, { fontSize: 16 });
		expect(set).toHaveBeenNthCalledWith(3, { activeThemeId: 'dracula' });
		expect(persist).toHaveBeenNthCalledWith(1, 'defaultShell', 'fish');
		expect(persist).toHaveBeenNthCalledWith(2, 'fontSize', 16);
		expect(persist).toHaveBeenNthCalledWith(3, 'activeThemeId', 'dracula');
	});
});

describe('createInputAndLayoutSetters', () => {
	it('preserves normalization and explicit persistence for layout actions', () => {
		const set = vi.fn();
		const persist = vi.fn();
		const setters = createInputAndLayoutSetters(set, persist, () => ({}));

		setters.setSynopsisDebounceSeconds(1.8);
		setters.setLeftSidebarWidth(900);
		setters.setRightPanelWidth(0);

		expect(set).toHaveBeenNthCalledWith(1, { synopsisDebounceSeconds: 2 });
		expect(persist).toHaveBeenNthCalledWith(1, 'synopsisDebounceSeconds', 2);
		expect(set).toHaveBeenNthCalledWith(2, { leftSidebarWidth: 600 });
		expect(persist).toHaveBeenNthCalledWith(2, 'leftSidebarWidth', 600);
		expect(persist).toHaveBeenNthCalledWith(3, 'rightPanelWidth', 360);
	});
});

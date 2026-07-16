import { describe, expect, it, vi } from 'vitest';
import { createShellAndAppearanceSetters } from '../../../renderer/stores/settingsStoreSetters';

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

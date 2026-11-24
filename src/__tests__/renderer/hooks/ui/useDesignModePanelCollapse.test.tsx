/**
 * `useDesignModePanelCollapse` - the side bars fold while Design Mode is up in
 * a tab the user is looking at, and only what the hook closed comes back.
 *
 * The restore rules themselves are pinned in sidePanelCollapse.test.ts; this
 * file is about WHEN the hook folds and unfolds: the flag, the setting, a
 * switch between two tabs, and unmount.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { useDesignModePanelCollapse } from '../../../../renderer/hooks/ui/useDesignModePanelCollapse';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useUIStore } from '../../../../renderer/stores/uiStore';
import { resetStore } from '../../../helpers';

function bars() {
	const { leftSidebarOpen, rightPanelOpen } = useUIStore.getState();
	return { left: leftSidebarOpen, right: rightPanelOpen };
}

describe('useDesignModePanelCollapse', () => {
	beforeEach(() => {
		resetStore(useUIStore);
		useSettingsStore.setState({ designModeCollapsePanels: true });
	});

	it('leaves the bars alone while Design Mode is not up', () => {
		renderHook(() => useDesignModePanelCollapse(false));

		expect(bars()).toEqual({ left: true, right: true });
	});

	it('folds the bars when Design Mode comes up and brings them back when it goes down', () => {
		const { rerender } = renderHook(({ shown }) => useDesignModePanelCollapse(shown), {
			initialProps: { shown: false },
		});

		rerender({ shown: true });
		expect(bars()).toEqual({ left: false, right: false });

		rerender({ shown: false });
		expect(bars()).toEqual({ left: true, right: true });
	});

	it('folds at mount when Design Mode is already up (a restored tab)', () => {
		renderHook(() => useDesignModePanelCollapse(true));

		expect(bars()).toEqual({ left: false, right: false });
	});

	it('brings the bars back when the tab unmounts', () => {
		const { unmount } = renderHook(() => useDesignModePanelCollapse(true));
		expect(bars()).toEqual({ left: false, right: false });

		unmount();

		expect(bars()).toEqual({ left: true, right: true });
	});

	it('does not fight a bar the user opened while Design Mode was up', () => {
		const { rerender } = renderHook(({ shown }) => useDesignModePanelCollapse(shown), {
			initialProps: { shown: true },
		});

		// The user opens the Right Bar to reach History, then closes it again.
		act(() => useUIStore.getState().setRightPanelOpen(true));
		act(() => useUIStore.getState().setRightPanelOpen(false));
		rerender({ shown: false });

		// The Left Bar is given back; the Right Bar is where the user left it.
		expect(bars()).toEqual({ left: true, right: false });
	});

	it('folds nothing when the setting is off', () => {
		useSettingsStore.setState({ designModeCollapsePanels: false });

		renderHook(() => useDesignModePanelCollapse(true));

		expect(bars()).toEqual({ left: true, right: true });
	});

	it('follows the setting while Design Mode is up', () => {
		renderHook(() => useDesignModePanelCollapse(true));
		expect(bars()).toEqual({ left: false, right: false });

		act(() => useSettingsStore.setState({ designModeCollapsePanels: false }));
		expect(bars()).toEqual({ left: true, right: true });

		act(() => useSettingsStore.setState({ designModeCollapsePanels: true }));
		expect(bars()).toEqual({ left: false, right: false });
	});

	it('hands the fold from one tab to the next without leaving the bars open', () => {
		// Two browser tabs, Design Mode on in both; switching tabs un-shows one and
		// shows the other in the same commit. React runs the old tab's cleanup
		// before the new tab's effect, so the second fold sees the bars open again
		// and owns them, and the last tab to go down gives them back.
		function Tab({ shown }: { shown: boolean }) {
			useDesignModePanelCollapse(shown);
			return null;
		}
		const { rerender } = render(
			<>
				<Tab shown={true} />
				<Tab shown={false} />
			</>
		);
		expect(bars()).toEqual({ left: false, right: false });

		rerender(
			<>
				<Tab shown={false} />
				<Tab shown={true} />
			</>
		);
		expect(bars()).toEqual({ left: false, right: false });

		rerender(
			<>
				<Tab shown={false} />
				<Tab shown={false} />
			</>
		);
		expect(bars()).toEqual({ left: true, right: true });
	});
});

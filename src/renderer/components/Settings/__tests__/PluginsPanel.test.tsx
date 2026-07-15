/**
 * @file PluginsPanel.test.tsx
 * @description Regression guard: the panel must subscribe to the main-process
 * `plugins:changed` broadcast and reload its list when it fires. The host-owned
 * consent window mints the grant and the main process enables the plugin out of
 * band (no return value to the panel), so without this subscription the toggle
 * stays stale after the user approves a code-tier plugin's permission prompt.
 */

import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, cleanup } from '@testing-library/react';

// Isolate PluginsPanel from children that also hit the plugin bridge on mount.
vi.mock('../PluginActivityView', () => ({ PluginActivityView: () => null }));
vi.mock('../PluginPanelHost', () => ({ PluginPanelHost: () => null }));
vi.mock('../../plugins/PluginPanelSlot', () => ({ PluginPanelSlot: () => null }));
vi.mock('../../../stores/notificationStore', () => ({ notifyToast: vi.fn() }));

import { PluginsPanel } from '../PluginsPanel';
import { THEMES } from '../../../constants/themes';

const theme = THEMES.dracula;

let onChangedCb: (() => void) | null = null;

const bridge = {
	list: vi.fn(),
	contributions: vi.fn(),
	onChanged: vi.fn(),
	setEnabled: vi.fn(),
	requestConsent: vi.fn(),
	invokeCommand: vi.fn(),
	revokeGrants: vi.fn(),
};

beforeEach(() => {
	window.maestro.plugins = bridge as unknown as typeof window.maestro.plugins;
	onChangedCb = null;
	vi.clearAllMocks();
	bridge.list.mockResolvedValue({ plugins: [] });
	bridge.contributions.mockResolvedValue(null);
	bridge.onChanged.mockImplementation((cb: () => void) => {
		onChangedCb = cb;
		return () => {};
	});
});

afterEach(() => cleanup());

describe('PluginsPanel - plugins:changed subscription', () => {
	it('subscribes to onChanged and reloads the list when the event fires', async () => {
		render(<PluginsPanel theme={theme} />);

		// Initial mount triggers exactly one load.
		await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(1));
		expect(bridge.onChanged).toHaveBeenCalledTimes(1);
		expect(onChangedCb).toBeTypeOf('function');

		// Main process broadcasts plugins:changed (e.g. consent just enabled a plugin).
		onChangedCb!();

		// The panel must re-fetch so the toggle reflects the new enabled state.
		await waitFor(() => expect(bridge.list).toHaveBeenCalledTimes(2));
	});

	it('unsubscribes on unmount (no leaked listener)', async () => {
		const unsubscribe = vi.fn();
		bridge.onChanged.mockImplementation((cb: () => void) => {
			onChangedCb = cb;
			return unsubscribe;
		});

		const { unmount } = render(<PluginsPanel theme={theme} />);
		await waitFor(() => expect(bridge.onChanged).toHaveBeenCalledTimes(1));

		unmount();
		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});
});

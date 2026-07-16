import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { PluginUiItemsSlot } from '../PluginUiItemsSlot';
import type {
	AggregatedContributions,
	UiItemContribution,
	UiSurface,
} from '../../../../shared/plugins/contributions';

const EMPTY: AggregatedContributions = {
	themes: [],
	iconPacks: [],
	prompts: [],
	settings: [],
	commandMacros: [],
	cueTriggers: [],
	commands: [],
	panels: [],
	agents: [],
	tools: [],
	keybindings: [],
	uiItems: [],
	hostViews: [],
	groupings: [],
	errorsByPlugin: {},
};

function uiItem(over: Partial<UiItemContribution> = {}): UiItemContribution {
	return {
		id: 'p/go',
		localId: 'go',
		pluginId: 'p',
		surface: 'sidebar',
		label: 'Go',
		command: 'go',
		...over,
	};
}

// Test double for the renderer plugin bridge; only the methods the slot path
// exercises. The global test setup defines window.maestro without `plugins`.
const pluginBridge = {
	contributions: vi.fn<() => Promise<AggregatedContributions>>(),
	onChanged: vi.fn<(listener: () => void) => () => void>(() => () => {}),
	invokeCommand: vi.fn().mockResolvedValue({ dispatched: true }),
};

beforeEach(() => {
	// Structurally-compatible test double; the real type carries extra management
	// methods the uiItems slot never calls.
	window.maestro.plugins = pluginBridge as unknown as typeof window.maestro.plugins;
	pluginBridge.contributions.mockReset().mockResolvedValue(EMPTY);
	pluginBridge.invokeCommand.mockReset().mockResolvedValue({ dispatched: true });
	pluginBridge.onChanged.mockClear();
});

afterEach(() => cleanup());

describe('PluginUiItemsSlot', () => {
	it('renders a matching item and invokes its namespaced command on click', async () => {
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			uiItems: [uiItem({ surface: 'sidebar', pluginId: 'p', command: 'go', label: 'Go' })],
		});

		render(<PluginUiItemsSlot surface="sidebar" />);

		const button = await screen.findByText('Go');
		fireEvent.click(button);

		await waitFor(() => expect(pluginBridge.invokeCommand).toHaveBeenCalledWith('p/go'));
	});

	it('notifies the menu owner after a contributed action activates', async () => {
		const onActivate = vi.fn();
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			uiItems: [uiItem({ surface: 'contextMenuItem', label: 'Plugin menu action' })],
		});

		render(
			<PluginUiItemsSlot surface="contextMenuItem" presentation="menu" onActivate={onActivate} />
		);

		fireEvent.click(await screen.findByText('Plugin menu action'));
		await waitFor(() => expect(onActivate).toHaveBeenCalledTimes(1));
	});

	it.each([
		'tabBar',
		'sessionRowBadge',
		'groupHeaderBadge',
		'settingsSection',
		'rightPanelTab',
		'contextMenuItem',
		'emptyState',
	] as const)('renders only a matching %s host-owned slot', async (surface) => {
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			uiItems: [uiItem({ surface, label: `Action for ${surface}` })],
		});

		const { container } = render(<PluginUiItemsSlot surface={surface} />);

		await screen.findByText(`Action for ${surface}`);
		expect(container.querySelector(`[data-plugin-uiitems-slot="${surface}"]`)).not.toBeNull();
	});

	it('removes items when the registry changes after disable or uninstall', async () => {
		let current: AggregatedContributions = {
			...EMPTY,
			uiItems: [uiItem({ surface: 'toolbar', label: 'Will disappear' })],
		};
		let notifyChanged: (() => void) | undefined;
		pluginBridge.contributions.mockImplementation(() => Promise.resolve(current));
		pluginBridge.onChanged.mockImplementation((listener) => {
			notifyChanged = listener;
			return () => {};
		});

		render(<PluginUiItemsSlot surface="toolbar" />);
		await screen.findByText('Will disappear');

		current = EMPTY;
		notifyChanged?.();

		await waitFor(() => expect(screen.queryByText('Will disappear')).not.toBeInTheDocument());
	});

	it.each([
		'plugin-management',
		'permission-consent',
		'uninstall-grant-revoke',
		'security-indicators',
	])('does not render a crafted contribution into protected %s', async (protectedSurface) => {
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			uiItems: [
				uiItem({
					surface: protectedSurface as UiSurface,
					label: `Spoof ${protectedSurface}`,
				}),
			],
		});

		const { container } = render(<PluginUiItemsSlot surface={protectedSurface as UiSurface} />);

		await waitFor(() => expect(pluginBridge.contributions).toHaveBeenCalled());
		expect(container.querySelector('[data-plugin-uiitems-slot]')).toBeNull();
		expect(screen.queryByText(`Spoof ${protectedSurface}`)).not.toBeInTheDocument();
	});

	it('renders no plugin UI while the plugins Encore flag is off', async () => {
		pluginBridge.contributions.mockRejectedValue(new Error('PluginsDisabled'));

		const { container } = render(<PluginUiItemsSlot surface="emptyState" />);

		await waitFor(() => expect(pluginBridge.contributions).toHaveBeenCalled());
		expect(container.querySelector('[data-plugin-uiitems-slot]')).toBeNull();
	});
	it('does not leak an item into a non-matching surface', async () => {
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			uiItems: [uiItem({ surface: 'sidebar', pluginId: 'p', command: 'go', label: 'Go' })],
		});

		const { container } = render(<PluginUiItemsSlot surface="toolbar" />);

		await waitFor(() => expect(pluginBridge.contributions).toHaveBeenCalled());
		await Promise.resolve();

		expect(container.querySelector('[data-plugin-uiitems-slot]')).toBeNull();
		expect(screen.queryByText('Go')).not.toBeInTheDocument();
	});
});

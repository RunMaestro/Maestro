import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { PluginUiItemsSlot } from '../PluginUiItemsSlot';
import type {
	AggregatedContributions,
	UiItemContribution,
} from '../../../../shared/plugins/contributions';

const EMPTY: AggregatedContributions = {
	themes: [],
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
	onChanged: vi.fn(() => () => {}),
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

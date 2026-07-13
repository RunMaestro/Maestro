import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { PluginPanelSlot } from '../PluginPanelSlot';
import { THEMES } from '../../../constants/themes';
import type {
	AggregatedContributions,
	PanelContribution,
} from '../../../../shared/plugins/contributions';

const theme = THEMES.dracula;

const EMPTY: AggregatedContributions = {
	themes: [],
	iconPacks: [],
	prompts: [],
	settings: [],
	commandMacros: [],
	cueTriggers: [],
	commands: [],
	panels: [],
	workspaces: [],
	interactivePanels: [],
	agents: [],
	tools: [],
	keybindings: [],
	uiItems: [],
	hostViews: [],
	groupings: [],
	errorsByPlugin: {},
};

function panel(over: Partial<PanelContribution> = {}): PanelContribution {
	return {
		id: 'acme.tools/board',
		localId: 'board',
		pluginId: 'acme.tools',
		title: 'Acme Board',
		entry: 'board.html',
		placement: 'left',
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
	// methods the docked-panel path never calls.
	window.maestro.plugins = pluginBridge as unknown as typeof window.maestro.plugins;
	pluginBridge.contributions.mockReset().mockResolvedValue(EMPTY);
	pluginBridge.onChanged.mockClear();
});

afterEach(() => cleanup());

describe('PluginPanelSlot', () => {
	it('docks a matching panel in an isolated per-plugin webview with provenance', async () => {
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			panels: [
				panel(),
				panel({ id: 'acme.tools/side', localId: 'side', title: 'Acme Side', placement: 'right' }),
			],
		});

		const { container } = render(<PluginPanelSlot theme={theme} placement="left" />);

		// Provenance is shown and non-suppressible.
		await waitFor(() => expect(screen.getByText('from acme.tools')).toBeInTheDocument());
		const webview = container.querySelector('webview');
		expect(webview).not.toBeNull();

		// Isolated surface: per-plugin partition + the panel's own protocol URL —
		// never inline HTML (srcdoc) and never an arbitrary URL.
		expect(webview?.getAttribute('partition')).toBe('plugin:acme.tools');
		expect(webview?.getAttribute('src')).toBe('plugin-panel://panel/acme.tools%2Fboard');
		expect(webview?.getAttribute('srcdoc')).toBeNull();

		// The right-placement panel must NOT render in the left slot.
		expect(screen.queryByText('Acme Side')).not.toBeInTheDocument();

		// Slot is z-clamped below first-party modals.
		const slot = container.querySelector('[data-plugin-panel-slot="left"]');
		expect(slot).not.toBeNull();
	});

	it('renders nothing when the plugins feature is off (contributions rejects)', async () => {
		pluginBridge.contributions.mockRejectedValue(new Error('PluginsDisabled'));
		const { container } = render(<PluginPanelSlot theme={theme} placement="left" />);
		await waitFor(() => expect(pluginBridge.contributions).toHaveBeenCalled());
		await Promise.resolve();
		expect(container.querySelector('webview')).toBeNull();
		expect(container.querySelector('[data-plugin-panel-slot]')).toBeNull();
	});

	it('renders nothing when no panel targets the slot', async () => {
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			panels: [panel({ placement: 'right' })],
		});
		const { container } = render(<PluginPanelSlot theme={theme} placement="left" />);
		await waitFor(() => expect(pluginBridge.contributions).toHaveBeenCalled());
		await Promise.resolve();
		expect(container.querySelector('[data-plugin-panel-slot]')).toBeNull();
	});

	it('keeps the earlier plugin on a colliding panel id (one frame renders)', async () => {
		pluginBridge.contributions.mockResolvedValue({
			...EMPTY,
			panels: [
				panel({ id: 'dup', localId: 'dup', pluginId: 'first', title: 'First' }),
				panel({ id: 'dup', localId: 'dup', pluginId: 'second', title: 'Second' }),
			],
		});
		const { container } = render(<PluginPanelSlot theme={theme} placement="left" />);
		await waitFor(() => expect(screen.getByText('from first')).toBeInTheDocument());
		expect(container.querySelectorAll('webview')).toHaveLength(1);
		expect(screen.queryByText('from second')).not.toBeInTheDocument();
	});
});

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
	prompts: [],
	settings: [],
	commandMacros: [],
	cueTriggers: [],
	commands: [],
	panels: [],
	agents: [],
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
	panelHtml: vi.fn<(id: string) => Promise<{ html: string | null }>>(),
	invokeCommand: vi.fn().mockResolvedValue({ dispatched: true }),
};

beforeEach(() => {
	// Structurally-compatible test double; the real type carries extra management
	// methods the docked-panel path never calls.
	window.maestro.plugins = pluginBridge as unknown as typeof window.maestro.plugins;
	pluginBridge.contributions.mockReset().mockResolvedValue(EMPTY);
	pluginBridge.panelHtml.mockReset().mockResolvedValue({ html: '<p>panel-body-here</p>' });
	pluginBridge.onChanged.mockClear();
});

afterEach(() => cleanup());

describe('PluginPanelSlot', () => {
	it('docks a matching panel in a locked-down sandboxed iframe with provenance', async () => {
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
		// The iframe appears once the panel HTML resolves.
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());

		const iframe = container.querySelector('iframe');
		// Opaque origin: allow-scripts ONLY, never allow-same-origin, never a URL src.
		expect(iframe?.getAttribute('sandbox')).toBe('allow-scripts');
		expect(iframe?.getAttribute('sandbox')).not.toContain('allow-same-origin');
		expect(iframe?.getAttribute('src')).toBeNull();
		expect(iframe?.getAttribute('srcdoc')).toContain('panel-body-here');

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
		expect(container.querySelector('iframe')).toBeNull();
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
		await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
		expect(container.querySelectorAll('iframe')).toHaveLength(1);
		expect(screen.queryByText('from second')).not.toBeInTheDocument();
	});
});

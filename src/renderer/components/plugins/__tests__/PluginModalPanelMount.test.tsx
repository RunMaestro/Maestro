/**
 * @file PluginModalPanelMount.test.tsx
 * @description The renderer half of the summon path. The mount is the single
 * app-level host for `modal` panels, and BOTH entry points (the Settings launch
 * button and a plugin's own `ui.openPanel` / `ui.togglePanel`) reach it through
 * the same `uiStore.openPluginPanelId` field. These tests drive it from both
 * sides and cover the two guards that are easy to regress: `close` must only
 * close the panel it names, and an id that no longer resolves to a live panel
 * must drop the overlay rather than strand it.
 */

import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { PluginModalPanelMount } from '../PluginModalPanelMount';
import { LayerStackProvider } from '../../../contexts/LayerStackContext';
import { THEMES } from '../../../constants/themes';
import type {
	AggregatedContributions,
	PanelContribution,
} from '../../../../shared/plugins/contributions';
import { useUIStore } from '../../../stores/uiStore';

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
		id: 'acme.flow/flow',
		localId: 'flow',
		pluginId: 'acme.flow',
		title: 'Agent Flow',
		entry: 'panel.html',
		placement: 'modal',
		size: 'full',
		...over,
	};
}

type VisibilityPayload = {
	pluginId: string;
	panelId: string;
	action: 'open' | 'close' | 'toggle';
};

let visibilityCb: ((payload: VisibilityPayload) => void) | null = null;
const unsubscribeVisibility = vi.fn();

const pluginBridge = {
	contributions: vi.fn<() => Promise<AggregatedContributions>>(),
	onChanged: vi.fn((_cb: () => void) => () => {}),
	onPanelData: vi.fn(() => () => {}),
	onPanelVisibility: vi.fn((cb: (payload: VisibilityPayload) => void) => {
		visibilityCb = cb;
		return unsubscribeVisibility;
	}),
	invokeCommand: vi.fn().mockResolvedValue({ dispatched: true }),
};

/** Fire a main-process `plugins:panel-visibility` broadcast at the mount. */
function broadcast(action: VisibilityPayload['action'], panelId = 'acme.flow/flow'): void {
	act(() => visibilityCb?.({ pluginId: 'acme.flow', panelId, action }));
}

function renderMount() {
	return render(
		<LayerStackProvider>
			<PluginModalPanelMount theme={theme} />
		</LayerStackProvider>
	);
}

beforeEach(() => {
	// Structurally-compatible test double; the real bridge carries management
	// methods this path never calls.
	window.maestro.plugins = pluginBridge as unknown as typeof window.maestro.plugins;
	pluginBridge.contributions.mockReset().mockResolvedValue({ ...EMPTY, panels: [panel()] });
	pluginBridge.onChanged.mockClear();
	pluginBridge.onPanelVisibility.mockClear();
	unsubscribeVisibility.mockClear();
	visibilityCb = null;
	// The open-panel id is a module-level store singleton; reset it so one test's
	// overlay never leaks into the next.
	useUIStore.setState({ openPluginPanelId: null });
});

afterEach(() => {
	cleanup();
	useUIStore.setState({ openPluginPanelId: null });
});

describe('PluginModalPanelMount', () => {
	it('renders nothing until the store field names a live panel', async () => {
		const { container } = renderMount();

		await waitFor(() => expect(pluginBridge.contributions).toHaveBeenCalled());
		expect(container).toBeEmptyDOMElement();

		// The Settings launch button writes exactly this.
		act(() => useUIStore.getState().setOpenPluginPanelId('acme.flow/flow'));

		await waitFor(() => expect(screen.getByText('Agent Flow')).toBeInTheDocument());
		// Same host, same provenance line as the docked path.
		expect(screen.getByText('from acme.flow')).toBeInTheDocument();
	});

	it('opens edge-to-edge chrome for a size: full panel', async () => {
		const { container } = renderMount();
		await waitFor(() => expect(pluginBridge.contributions).toHaveBeenCalled());
		act(() => useUIStore.getState().setOpenPluginPanelId('acme.flow/flow'));

		await waitFor(() => expect(screen.getByText('Agent Flow')).toBeInTheDocument());
		expect(container.querySelector('.inset-4')).not.toBeNull();
		expect(container.querySelector('.w-\\[720px\\]')).toBeNull();
	});

	it('closes on Escape through the layer stack and clears the store field', async () => {
		renderMount();
		await waitFor(() => expect(pluginBridge.contributions).toHaveBeenCalled());
		act(() => useUIStore.getState().setOpenPluginPanelId('acme.flow/flow'));
		await waitFor(() => expect(screen.getByText('Agent Flow')).toBeInTheDocument());

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => expect(screen.queryByText('Agent Flow')).not.toBeInTheDocument());
		// Cleared, not merely unmounted - otherwise the chord could never re-open it.
		expect(useUIStore.getState().openPluginPanelId).toBeNull();
	});

	it('opens, toggles and closes from the plugin panel-visibility broadcast', async () => {
		renderMount();
		await waitFor(() => expect(pluginBridge.onPanelVisibility).toHaveBeenCalledTimes(1));

		broadcast('open');
		await waitFor(() => expect(screen.getByText('Agent Flow')).toBeInTheDocument());

		// The chord path: toggle dismisses...
		broadcast('toggle');
		await waitFor(() => expect(screen.queryByText('Agent Flow')).not.toBeInTheDocument());

		// ...and summons again.
		broadcast('toggle');
		await waitFor(() => expect(screen.getByText('Agent Flow')).toBeInTheDocument());

		broadcast('close');
		await waitFor(() => expect(screen.queryByText('Agent Flow')).not.toBeInTheDocument());
	});

	it('ignores a close naming a panel that is not the open one', async () => {
		renderMount();
		await waitFor(() => expect(pluginBridge.onPanelVisibility).toHaveBeenCalledTimes(1));

		broadcast('open');
		await waitFor(() => expect(screen.getByText('Agent Flow')).toBeInTheDocument());

		// A different plugin's close must never dismiss this overlay.
		broadcast('close', 'other.plugin/board');

		expect(screen.getByText('Agent Flow')).toBeInTheDocument();
		expect(useUIStore.getState().openPluginPanelId).toBe('acme.flow/flow');
	});

	it('drops the overlay when the open id stops resolving to a live panel', async () => {
		renderMount();
		await waitFor(() => expect(pluginBridge.contributions).toHaveBeenCalled());
		act(() => useUIStore.getState().setOpenPluginPanelId('acme.flow/flow'));
		await waitFor(() => expect(screen.getByText('Agent Flow')).toBeInTheDocument());

		// Plugin disabled/uninstalled while its overlay is up: contributions refresh
		// without it. `usePluginContributions` re-fetches on the onChanged callback.
		pluginBridge.contributions.mockResolvedValue(EMPTY);
		const onChangedCb = pluginBridge.onChanged.mock.calls[0]?.[0];
		expect(onChangedCb).toBeTypeOf('function');
		act(() => onChangedCb!());

		await waitFor(() => expect(screen.queryByText('Agent Flow')).not.toBeInTheDocument());
	});

	it('unsubscribes from panel-visibility on unmount', async () => {
		const { unmount } = renderMount();
		await waitFor(() => expect(pluginBridge.onPanelVisibility).toHaveBeenCalledTimes(1));

		unmount();
		expect(unsubscribeVisibility).toHaveBeenCalledTimes(1);
	});
});

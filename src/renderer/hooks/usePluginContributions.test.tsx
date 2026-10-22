import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import type { AggregatedContributions } from '../../shared/plugins/contributions';
import { usePluginContributions } from './usePluginContributions';
import { useSettingsStore } from '../stores/settingsStore';

// Contributions are only read while the plugins Encore Feature is on.
const encoreDefaults = useSettingsStore.getState().encoreFeatures;
function setPluginsEnabled(plugins: boolean): void {
	useSettingsStore.setState({ encoreFeatures: { ...encoreDefaults, plugins } });
}
beforeEach(() => setPluginsEnabled(true));

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

function Probe() {
	const contributions = usePluginContributions();
	return (
		<>
			<output aria-label="Contribution read">
				{contributions.isLoading ? 'loading' : 'settled'}
			</output>
			{contributions.panels.map((panel) => (
				<input key={panel.id} aria-label={panel.id} defaultValue="draft" />
			))}
			{contributions.uiItems.map((item) => (
				<span key={item.id}>{item.label}</span>
			))}
			{contributions.groupings.map((grouping) => (
				<span key={grouping.id}>{grouping.label}</span>
			))}
		</>
	);
}

afterEach(() => {
	window.maestro.plugins = undefined as unknown as typeof window.maestro.plugins;
});

describe('usePluginContributions', () => {
	it('keeps sidebar groupings during refresh until removal is confirmed', async () => {
		const active = {
			...EMPTY,
			groupings: [
				{
					id: 'p/projects',
					localId: 'projects',
					pluginId: 'p',
					pluginName: 'Projects',
					label: 'Project grouping',
				},
			],
		};
		let notifyChanged!: (ids?: string[]) => void;
		let resolveRefresh!: (value: AggregatedContributions) => void;
		const refresh = new Promise<AggregatedContributions>((resolve) => {
			resolveRefresh = resolve;
		});
		window.maestro.plugins = {
			contributions: vi
				.fn()
				.mockResolvedValueOnce(active)
				.mockReturnValueOnce(refresh)
				.mockResolvedValueOnce(EMPTY),
			onChanged: vi.fn((listener: (ids?: string[]) => void) => {
				notifyChanged = listener;
				return () => {};
			}),
		} as unknown as typeof window.maestro.plugins;
		render(<Probe />);
		expect(await screen.findByText('Project grouping')).toBeInTheDocument();
		act(() => notifyChanged([]));
		expect(screen.getByText('Project grouping')).toBeInTheDocument();
		expect(screen.getByLabelText('Contribution read')).toHaveTextContent('loading');
		await act(async () => resolveRefresh(active));
		expect(screen.getByText('Project grouping')).toBeInTheDocument();
		expect(screen.getByLabelText('Contribution read')).toHaveTextContent('settled');
		act(() => notifyChanged([]));
		await waitFor(() => expect(screen.queryByText('Project grouping')).not.toBeInTheDocument());
	});

	it('ignores an older active response after a changed event returns an empty snapshot', async () => {
		let resolveInitial!: (value: AggregatedContributions) => void;
		const initial = new Promise<AggregatedContributions>((resolve) => {
			resolveInitial = resolve;
		});
		let notifyChanged!: () => void;
		const plugins = {
			contributions: vi.fn().mockReturnValueOnce(initial).mockResolvedValueOnce(EMPTY),
			onChanged: vi.fn((listener: () => void) => {
				notifyChanged = listener;
				return () => {};
			}),
		};
		window.maestro.plugins = plugins as unknown as typeof window.maestro.plugins;

		render(<Probe />);
		await waitFor(() => expect(plugins.contributions).toHaveBeenCalledTimes(1));
		expect(screen.getByLabelText('Contribution read')).toHaveTextContent('loading');

		act(() => notifyChanged());
		await waitFor(() => expect(plugins.contributions).toHaveBeenCalledTimes(2));
		await act(async () => {
			await Promise.resolve();
		});
		expect(screen.getByLabelText('Contribution read')).toHaveTextContent('settled');

		await act(async () => {
			resolveInitial({
				...EMPTY,
				uiItems: [
					{
						id: 'p/open',
						localId: 'open',
						pluginId: 'p',
						surface: 'emptyState',
						label: 'Revoked action',
						command: 'run',
					},
				],
			});
			await Promise.resolve();
		});

		await waitFor(() => expect(screen.queryByText('Revoked action')).not.toBeInTheDocument());
		expect(screen.getByLabelText('Contribution read')).toHaveTextContent('settled');
	});
	it('preserves a live settings guest during unrelated refresh and removes it immediately on revoke', async () => {
		const panel = {
			id: 'p/config',
			localId: 'config',
			pluginId: 'p',
			title: 'Preferences',
			entry: 'panel.html',
			placement: 'settings' as const,
			size: 'default' as const,
		};
		let notifyChanged!: (activePanelIds?: string[]) => void;
		let resolveRefresh!: (value: AggregatedContributions) => void;
		const refresh = new Promise<AggregatedContributions>((resolve) => {
			resolveRefresh = resolve;
		});
		const plugins = {
			contributions: vi
				.fn()
				.mockResolvedValueOnce({
					...EMPTY,
					panels: [panel],
					uiItems: [
						{
							id: 'p/open',
							localId: 'open',
							pluginId: 'p',
							surface: 'emptyState',
							label: 'Stale action',
							command: 'run',
						},
					],
				})
				.mockReturnValueOnce(refresh)
				.mockReturnValueOnce(new Promise(() => {})),
			onChanged: vi.fn((listener: (ids?: string[]) => void) => {
				notifyChanged = listener;
				return () => {};
			}),
		};
		window.maestro.plugins = plugins as unknown as typeof window.maestro.plugins;
		render(<Probe />);
		const guest = await screen.findByRole('textbox', { name: panel.id });
		(guest as HTMLInputElement).value = 'unsaved edits';
		expect(screen.getByText('Stale action')).toBeInTheDocument();
		act(() => notifyChanged([panel.id]));
		expect(screen.queryByText('Stale action')).not.toBeInTheDocument();
		expect(screen.getByRole('textbox', { name: panel.id })).toBe(guest);
		await act(async () => resolveRefresh({ ...EMPTY, panels: [{ ...panel }] }));
		expect(screen.getByRole('textbox', { name: panel.id })).toBe(guest);
		expect(guest).toHaveValue('unsaved edits');
		act(() => notifyChanged([]));
		expect(screen.queryByRole('textbox', { name: panel.id })).not.toBeInTheDocument();
	});

	it('removes a feature-disabled guest and ignores an older in-flight response', async () => {
		let resolveRefresh!: (value: AggregatedContributions) => void;
		let notifyChanged!: (ids?: string[]) => void;
		const active = {
			...EMPTY,
			panels: [
				{
					id: 'p/config',
					localId: 'config',
					pluginId: 'p',
					title: 'Preferences',
					entry: 'panel.html',
					placement: 'settings' as const,
					size: 'default' as const,
				},
			],
		};
		window.maestro.plugins = {
			contributions: vi
				.fn()
				.mockResolvedValueOnce(active)
				.mockReturnValueOnce(
					new Promise<AggregatedContributions>((resolve) => {
						resolveRefresh = resolve;
					})
				)
				.mockRejectedValueOnce(new Error('PluginsDisabled')),
			onChanged: vi.fn((listener: (ids?: string[]) => void) => {
				notifyChanged = listener;
				return () => {};
			}),
		} as unknown as typeof window.maestro.plugins;
		render(<Probe />);
		expect(await screen.findByRole('textbox', { name: 'p/config' })).toBeInTheDocument();
		act(() => notifyChanged(['p/config']));
		// The main feature watcher broadcasts an empty eligibility list before
		// the gated re-read rejects, including changes made through the CLI.
		act(() => notifyChanged([]));
		expect(screen.queryByRole('textbox', { name: 'p/config' })).not.toBeInTheDocument();
		await act(async () => resolveRefresh(active));
		expect(screen.queryByRole('textbox', { name: 'p/config' })).not.toBeInTheDocument();
		expect(screen.getByLabelText('Contribution read')).toHaveTextContent('settled');
	});
});

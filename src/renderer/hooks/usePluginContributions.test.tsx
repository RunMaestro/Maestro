import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AggregatedContributions } from '../../shared/plugins/contributions';
import { usePluginContributions } from './usePluginContributions';

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
			{contributions.uiItems.map((item) => (
				<span key={item.id}>{item.label}</span>
			))}
		</>
	);
}

afterEach(() => {
	window.maestro.plugins = undefined as unknown as typeof window.maestro.plugins;
});

describe('usePluginContributions', () => {
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

		act(() => notifyChanged());
		await waitFor(() => expect(plugins.contributions).toHaveBeenCalledTimes(2));
		await act(async () => {
			await Promise.resolve();
		});

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
	});
});

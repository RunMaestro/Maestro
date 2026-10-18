import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { AgentDispatchAllowlist } from '../../../../../renderer/components/Settings/Extensions/AgentDispatchAllowlist';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import type { Session, Theme } from '../../../../../renderer/types';

const theme = {
	colors: {
		textMain: '#eee',
		textDim: '#999',
		bgMain: '#111',
		accent: '#4af',
		border: '#333',
		warning: '#fa0',
	},
} as unknown as Theme;
const agents = [
	{ id: 'agent-alpha', name: 'Alpha Worker' },
	{ id: 'agent-beta', name: 'Beta Worker' },
	{ id: 'agent-gamma', name: 'Gamma Worker' },
] as Session[];

beforeEach(() => {
	useSessionStore.setState({ sessions: agents });
	vi.mocked(window.maestro.plugins.setAgentAllowlist).mockReset().mockResolvedValue({
		requested: [],
		granted: [],
	});
});
afterEach(cleanup);

function editor(pluginId = 'plugin-a') {
	return (
		<AgentDispatchAllowlist
			theme={theme}
			pluginId={pluginId}
			grant={{
				capability: 'agents:dispatch',
				scope: 'agent-alpha,agent-beta,deleted-agent',
				grantedAt: 1,
			}}
			onSaved={vi.fn()}
		/>
	);
}

describe('AgentDispatchAllowlist search', () => {
	it('matches trimmed case-insensitive names and IDs, shows empty state, and clears', () => {
		render(editor());
		const search = screen.getByRole('textbox', { name: 'Search agents' });
		fireEvent.change(search, { target: { value: '  ALPHA  ' } });
		expect(screen.getAllByTestId('agent-dispatch-allowlist-row')).toHaveLength(1);
		expect(screen.getByText('Alpha Worker')).toBeInTheDocument();
		fireEvent.change(search, { target: { value: 'AGENT-BETA' } });
		expect(screen.getByText('Beta Worker')).toBeInTheDocument();
		expect(screen.queryByText('Alpha Worker')).not.toBeInTheDocument();
		fireEvent.change(search, { target: { value: 'missing' } });
		expect(screen.getByTestId('agent-dispatch-allowlist-no-results')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
		expect(screen.getAllByTestId('agent-dispatch-allowlist-row')).toHaveLength(3);
		expect(search).toHaveValue('');
	});

	it('saves the entire checked set despite a filter, and prunes stale IDs', async () => {
		render(editor());
		fireEvent.change(screen.getByRole('textbox', { name: 'Search agents' }), {
			target: { value: 'gamma' },
		});
		fireEvent.click(screen.getByTestId('agent-dispatch-allowlist-checkbox'));
		expect(screen.getByText('3 of 3 agents allowed (2 hidden by search)')).toBeInTheDocument();
		expect(screen.getByTestId('agent-dispatch-allowlist-stale')).toBeInTheDocument();
		fireEvent.click(screen.getByTestId('agent-dispatch-allowlist-save'));
		await waitFor(() =>
			expect(window.maestro.plugins.setAgentAllowlist).toHaveBeenCalledWith('plugin-a', [
				'agent-alpha',
				'agent-beta',
				'agent-gamma',
			])
		);
	});

	it('resets search when the selected plugin changes', () => {
		const view = render(editor());
		fireEvent.change(screen.getByRole('textbox', { name: 'Search agents' }), {
			target: { value: 'alpha' },
		});
		view.rerender(editor('plugin-b'));
		expect(screen.getByRole('textbox', { name: 'Search agents' })).toHaveValue('');
		expect(screen.getAllByTestId('agent-dispatch-allowlist-row')).toHaveLength(3);
	});
});

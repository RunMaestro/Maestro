/**
 * @file DebugApplicationStatsModal.test.tsx
 *
 * The Application Stats modal draws the `collectAppStats()` snapshot: the
 * overview totals, the Local Models section (model server tree, in-process
 * models, every model on disk with where it is loaded), and per-agent process
 * usage attributed by process key, so per-tab turns (which leave `aiPid` at 0)
 * still land on their agent.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';

import { DebugApplicationStatsModal } from '../../../renderer/components/DebugApplicationStatsModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';
import { createAppStatsSnapshot } from '../../helpers/appStatsSnapshot';

function renderModal() {
	return render(
		<LayerStackProvider>
			<DebugApplicationStatsModal theme={mockTheme} onClose={vi.fn()} />
		</LayerStackProvider>
	);
}

describe('DebugApplicationStatsModal', () => {
	beforeEach(() => {
		vi.mocked(window.maestro.debug.getAppStats).mockResolvedValue({
			success: true,
			...createAppStatsSnapshot(),
		});
		useSessionStore.setState({
			sessions: [
				createMockSession({ id: 'agent-a', name: 'Alpha', aiPid: 0 }),
				createMockSession({ id: 'agent-b', name: 'Bravo', aiPid: 0 }),
			],
		});
	});

	it('shows the overview totals', async () => {
		renderModal();
		const memory = await screen.findByRole('group', { name: /^Memory:/ });
		expect(memory).toHaveAccessibleName(expect.stringContaining('6.5 GB'));
		expect(screen.getByRole('group', { name: /^Processes:/ })).toHaveAccessibleName(
			expect.stringContaining('2 Electron · 3 agent · 2 model server')
		);
		expect(screen.getByRole('group', { name: /^Model Disk:/ })).toHaveAccessibleName(
			expect.stringContaining('6.0 GB')
		);
	});

	it('lists every model on disk with where it is loaded', async () => {
		renderModal();
		const qwenRow = (await screen.findByText('Qwen3 4B')).closest('tr')!;
		expect(within(qwenRow).getByText('Server')).toBeInTheDocument();
		expect(within(qwenRow).getByText('3.0 GB')).toBeInTheDocument();

		// Also named on the In-Process card; the row is the one inside the table.
		const parakeetRow = screen
			.getAllByText('Parakeet TDT')
			.map((el) => el.closest('tr'))
			.find(Boolean)!;
		expect(within(parakeetRow).getByText('In-process speech')).toBeInTheDocument();
	});

	it('shows the model server process tree', async () => {
		renderModal();
		const server = await screen.findByRole('group', { name: /^Model Server:/ });
		expect(server).toHaveAccessibleName(expect.stringContaining('3.0 GB'));
		expect(server).toHaveAccessibleName(expect.stringContaining('1 of 1 loaded'));
	});

	it('attributes a per-tab process to its agent by process key', async () => {
		renderModal();
		await screen.findByText('Qwen3 4B');
		const alphaRow = screen.getByText('Alpha').closest('tr')!;
		expect(within(alphaRow).getByText('500.0 MB')).toBeInTheDocument();
		expect(within(alphaRow).getByText('Active')).toBeInTheDocument();

		const bravoRow = screen.getByText('Bravo').closest('tr')!;
		expect(within(bravoRow).queryByText('500.0 MB')).not.toBeInTheDocument();
	});

	it('shows the error when the snapshot could not be built', async () => {
		vi.mocked(window.maestro.debug.getAppStats).mockResolvedValue({
			success: false,
			error: 'ps exploded',
		});
		renderModal();
		await waitFor(() =>
			expect(screen.getByText(/Failed to load stats: ps exploded/)).toBeInTheDocument()
		);
	});
});

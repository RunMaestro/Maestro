/**
 * Tests for AgentDetailModal's frame wiring.
 *
 * The per-agent detail view is a long, chart-heavy modal, so it has to be
 * drag-resizable and remember the size. `Modal` only enables resizing when a
 * caller passes an explicit `resizeKey` - a missing prop silently falls back to
 * the fixed-size path with no visible error - so that wiring gets its own test
 * rather than relying on the generic Modal suite.
 *
 * The stats content itself is covered by TabBreakdown's tests; here the IPC is
 * stubbed to the minimum the modal needs to mount.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { AgentDetailModal } from '../../../../renderer/components/UsageDashboard/AgentDetailModal';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { StatsAggregation } from '../../../../shared/stats-types';
import { createMockSession, createMockAITab } from '../../../helpers';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('lucide-react', () => ({
	X: () => <span data-testid="x-icon" />,
	ChevronLeft: () => <span data-testid="chevron-left" />,
	ChevronRight: () => <span data-testid="chevron-right" />,
}));

const TestWrapper = ({ children }: { children: React.ReactNode }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

const buildData = (): StatsAggregation =>
	({
		bySessionByDay: { 'session-1': [{ date: '2026-08-19', count: 4, duration: 4000 }] },
		bySessionSource: {},
		byAgent: {},
	}) as unknown as StatsAggregation;

const session = createMockSession({
	id: 'session-1',
	name: 'Test Agent',
	aiTabs: [createMockAITab({ id: 'tab-a', name: 'Alpha' })],
});

const renderModal = () =>
	render(
		<AgentDetailModal
			session={session}
			data={buildData()}
			theme={mockTheme}
			allSessions={[session]}
			onClose={vi.fn()}
		/>,
		{ wrapper: TestWrapper }
	);

beforeEach(() => {
	useSettingsStore.setState({ modalSizes: {} });
	(window as unknown as Record<string, unknown>).maestro = {
		stats: {
			getStats: vi.fn().mockResolvedValue([]),
			getAutoRunSessions: vi.fn().mockResolvedValue([]),
		},
	};
});

describe('AgentDetailModal frame', () => {
	it('renders the agent name as the modal title', async () => {
		renderModal();
		await waitFor(() => expect(screen.getByText('Test Agent')).toBeInTheDocument());
	});

	it('is drag-resizable under a stable persistence key', async () => {
		renderModal();

		await waitFor(() =>
			expect(
				document.querySelector('[data-modal-resize-key="modal-usage-agent-detail"]')
			).toBeInTheDocument()
		);
		expect(screen.getByTestId('modal-resize-handle-se')).toBeInTheDocument();
	});

	it('restores a size the user previously dragged to', async () => {
		useSettingsStore.setState({
			modalSizes: { 'modal-usage-agent-detail': { width: 700, height: 520 } },
		});
		renderModal();

		await waitFor(() => {
			const card = document.querySelector('[data-modal-resize-key="modal-usage-agent-detail"]');
			expect(card).toHaveStyle({ width: '700px', height: '520px' });
		});
	});

	// A frame saved on a large display must not hang off the edge of a smaller
	// one. The jsdom viewport is 1024x768, so a remembered 4000px width comes
	// back clamped to the shared 90%-of-viewport ceiling.
	it('clamps a remembered size that no longer fits the viewport', async () => {
		useSettingsStore.setState({
			modalSizes: { 'modal-usage-agent-detail': { width: 4000, height: 3000 } },
		});
		renderModal();

		await waitFor(() => {
			const card = document.querySelector('[data-modal-resize-key="modal-usage-agent-detail"]');
			expect(card).toHaveStyle({ width: '921px', height: '691px' });
		});
	});

	// A size saved under a different modal's key must not leak in - the key is
	// what keeps every resizable modal's remembered frame independent.
	it('ignores a size stored under another modal key', async () => {
		useSettingsStore.setState({
			modalSizes: { 'modal-branch-switcher': { width: 300, height: 300 } },
		});
		renderModal();

		await waitFor(() => {
			const card = document.querySelector('[data-modal-resize-key="modal-usage-agent-detail"]');
			expect(card).not.toHaveStyle({ width: '300px' });
		});
	});

	it('renders the per-tab breakdown once the query events resolve', async () => {
		renderModal();
		await waitFor(() => expect(screen.getByTestId('tab-breakdown')).toBeInTheDocument());
	});
});

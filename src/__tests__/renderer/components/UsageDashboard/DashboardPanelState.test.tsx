/**
 * Tests for DashboardPanelState: the loading / error / empty frame shared by
 * every Usage Dashboard panel.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DashboardPanelState } from '../../../../renderer/components/UsageDashboard/DashboardPanelState';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];

describe('DashboardPanelState', () => {
	it('renders its children when there is data', () => {
		render(
			<DashboardPanelState theme={theme}>
				<div data-testid="content">chart</div>
			</DashboardPanelState>
		);
		expect(screen.getByTestId('content')).toBeInTheDocument();
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('shows the loading state instead of the children while loading', () => {
		render(
			<DashboardPanelState theme={theme} loading loadingMessage="Loading tasks">
				<div data-testid="content" />
			</DashboardPanelState>
		);
		expect(screen.getByTestId('dashboard-panel-loading')).toBeInTheDocument();
		expect(screen.getByText('Loading tasks')).toBeInTheDocument();
		expect(screen.queryByTestId('content')).not.toBeInTheDocument();
	});

	it('shows the error, not the empty message, when a fetch failed with nothing to show', () => {
		render(
			<DashboardPanelState
				theme={theme}
				error="Error invoking remote method 'stats:get': Error: database is locked"
				empty
				emptyMessage="No runs"
			/>
		);
		expect(screen.getByTestId('dashboard-panel-error')).toHaveTextContent(
			'Could not load: database is locked'
		);
		expect(screen.queryByText('No runs')).not.toBeInTheDocument();
	});

	it('offers Retry only when given a handler, and calls it', () => {
		const onRetry = vi.fn();
		const { rerender } = render(<DashboardPanelState theme={theme} error="boom" empty />);
		expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

		rerender(<DashboardPanelState theme={theme} error="boom" empty onRetry={onRetry} />);
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('keeps stale data on screen under a refresh-failed strip', () => {
		render(
			<DashboardPanelState theme={theme} error={new Error('timeout')}>
				<div data-testid="content" />
			</DashboardPanelState>
		);
		expect(screen.getByTestId('content')).toBeInTheDocument();
		expect(screen.getByTestId('dashboard-panel-stale')).toHaveTextContent(
			'Could not refresh: timeout'
		);
	});

	it('shows the empty message when there is nothing to draw', () => {
		render(
			<DashboardPanelState theme={theme} empty emptyMessage="No Auto Runs in this range">
				<div data-testid="content" />
			</DashboardPanelState>
		);
		expect(screen.getByTestId('dashboard-panel-empty')).toHaveTextContent(
			'No Auto Runs in this range'
		);
		expect(screen.queryByTestId('content')).not.toBeInTheDocument();
	});

	it('honors a custom test id prefix and min height', () => {
		render(<DashboardPanelState theme={theme} empty testId="wizard" minHeight={200} />);
		expect(screen.getByTestId('wizard-empty')).toHaveStyle({ minHeight: '200px' });
	});
});

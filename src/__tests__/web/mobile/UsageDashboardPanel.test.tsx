import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageDashboardPanel } from '../../../web/mobile/UsageDashboardPanel';

const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentDim: 'rgba(99, 102, 241, 0.2)',
	accentText: '#a5b4fc',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('lucide-react', () => ({
	X: () => <span data-testid="close-icon">X</span>,
}));

function renderUsageDashboard(sendRequest = vi.fn(), onClose = vi.fn()) {
	render(<UsageDashboardPanel onClose={onClose} sendRequest={sendRequest} />);
	return { sendRequest, onClose };
}

describe('UsageDashboardPanel', () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it('loads usage data, formats summaries, sorts sessions, switches range, and closes', async () => {
		const sendRequest = vi.fn().mockResolvedValue({
			data: {
				totalTokensIn: 1_234,
				totalTokensOut: 1_250_000,
				totalCost: 12.34,
				dailyUsage: [
					{ date: '2026-06-18', tokensIn: 100, tokensOut: 200, cost: 0.5 },
					{ date: 'invalid-date', tokensIn: 0, tokensOut: 0, cost: 0 },
				],
				sessionBreakdown: [
					{
						sessionId: 'session-low',
						sessionName: 'Low Cost',
						tokensIn: 100,
						tokensOut: 200,
						cost: 1.23,
					},
					{
						sessionId: 'session-high',
						sessionName: '',
						tokensIn: 1_000,
						tokensOut: 2_000,
						cost: 9.87,
					},
				],
			},
		});
		const onClose = vi.fn();

		renderUsageDashboard(sendRequest, onClose);

		expect(screen.getByText('Loading usage data...')).toBeInTheDocument();
		expect(sendRequest).toHaveBeenCalledWith('get_usage_dashboard', { timeRange: 'week' }, 15000);
		expect(await screen.findByText('Usage Dashboard')).toBeInTheDocument();
		expect(screen.getByText('Tokens In')).toBeInTheDocument();
		expect(screen.getByText('1.2K')).toBeInTheDocument();
		expect(screen.getByText('Tokens Out')).toBeInTheDocument();
		expect(screen.getByText('1.3M')).toBeInTheDocument();
		expect(screen.getByText('$12.34')).toBeInTheDocument();
		expect(screen.getByText('Daily Usage')).toBeInTheDocument();
		expect(screen.getByText('06/18')).toBeInTheDocument();
		expect(screen.getByText('invalid-date')).toBeInTheDocument();
		expect(screen.getByText('Session Breakdown')).toBeInTheDocument();
		expect(screen.getByText('session-')).toBeInTheDocument();
		expect(screen.getByText('Low Cost')).toBeInTheDocument();
		expect(screen.getByText('1.0K in / 2.0K out')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Month' }));
		await waitFor(() => {
			expect(sendRequest).toHaveBeenCalledWith(
				'get_usage_dashboard',
				{ timeRange: 'month' },
				15000
			);
		});

		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('renders the empty state for zero usage', async () => {
		renderUsageDashboard(
			vi.fn().mockResolvedValue({
				data: {
					totalTokensIn: 0,
					totalTokensOut: 0,
					totalCost: 0,
					dailyUsage: [],
					sessionBreakdown: [],
				},
			})
		);

		expect(await screen.findByText('No usage data available')).toBeInTheDocument();
		expect(screen.queryByText('Loading usage data...')).not.toBeInTheDocument();
	});

	it('renders the error state when loading fails', async () => {
		renderUsageDashboard(vi.fn().mockRejectedValue(new Error('offline')));

		await waitFor(() => {
			expect(screen.getByText('Failed to load usage data')).toBeInTheDocument();
		});
		expect(screen.queryByText('Loading usage data...')).not.toBeInTheDocument();
	});
});

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CuePanel } from '../../../web/mobile/CuePanel';
import type { CueActivityEntry, CueSubscriptionInfo } from '../../../web/hooks/useCue';

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
	RefreshCw: () => <span data-testid="refresh-icon">RefreshCw</span>,
	ChevronDown: () => <span data-testid="chevron-down-icon">ChevronDown</span>,
	ChevronRight: () => <span data-testid="chevron-right-icon">ChevronRight</span>,
}));

function makeSubscription(overrides: Partial<CueSubscriptionInfo> = {}): CueSubscriptionInfo {
	return {
		id: 'sub-1',
		name: 'Build docs',
		eventType: 'file',
		sessionId: 'session-1',
		sessionName: 'Docs Agent',
		enabled: true,
		lastTriggered: Date.now() - 30_000,
		triggerCount: 2,
		...overrides,
	};
}

function makeActivity(overrides: Partial<CueActivityEntry> = {}): CueActivityEntry {
	return {
		id: 'activity-1',
		subscriptionId: 'sub-1',
		subscriptionName: 'Build docs',
		eventType: 'task',
		sessionId: 'session-1',
		timestamp: Date.now() - 90_000,
		status: 'completed',
		result: 'Generated documentation',
		duration: 65_000,
		...overrides,
	};
}

function renderCuePanel(overrides: Partial<React.ComponentProps<typeof CuePanel>> = {}) {
	const props: React.ComponentProps<typeof CuePanel> = {
		onClose: vi.fn(),
		subscriptions: [],
		activity: [],
		isLoading: false,
		onToggleSubscription: vi.fn(),
		onRefresh: vi.fn(),
		...overrides,
	};

	render(<CuePanel {...props} />);
	return props;
}

describe('CuePanel', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('renders empty states and invokes header actions', () => {
		const props = renderCuePanel();

		expect(screen.getByText('Maestro Cue')).toBeInTheDocument();
		expect(screen.getByText('No Cue subscriptions configured')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
		expect(props.onRefresh).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(props.onClose).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Activity (0)' }));
		expect(screen.getByText('No recent Cue activity')).toBeInTheDocument();
	});

	it('groups subscriptions, collapses sessions, and toggles enabled state', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-06-18T16:00:00.000Z'));
		const onToggleSubscription = vi.fn();

		renderCuePanel({
			subscriptions: [
				makeSubscription(),
				makeSubscription({
					id: 'sub-2',
					name: 'Open PR',
					eventType: 'custom_event',
					enabled: false,
					lastTriggered: undefined,
					triggerCount: 0,
				}),
				makeSubscription({
					id: 'sub-3',
					name: 'Nightly check',
					eventType: 'schedule',
					sessionId: 'session-2',
					sessionName: 'Ops Agent',
					lastTriggered: Date.now() - 3_600_000,
					triggerCount: 1,
				}),
			],
			onToggleSubscription,
		});

		expect(screen.getByRole('button', { name: 'Subscriptions (3)' })).toBeInTheDocument();
		expect(screen.getByText('Docs Agent')).toBeInTheDocument();
		expect(screen.getByText('Ops Agent')).toBeInTheDocument();
		expect(screen.getByText('Build docs')).toBeInTheDocument();
		expect(screen.getByText('30s ago')).toBeInTheDocument();
		expect(screen.getByText('Never')).toBeInTheDocument();
		expect(screen.getByText('2x')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('switch', { name: 'Disable Build docs' }));
		expect(onToggleSubscription).toHaveBeenCalledWith('sub-1', false);

		fireEvent.click(screen.getByText('Docs Agent'));
		expect(screen.queryByText('Build docs')).not.toBeInTheDocument();

		fireEvent.click(screen.getByText('Docs Agent'));
		expect(screen.getByText('Build docs')).toBeInTheDocument();
	});

	it('renders activity status, loading state, duration, and expandable results', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-06-18T16:00:00.000Z'));
		const longResult = 'a'.repeat(220);

		renderCuePanel({
			isLoading: true,
			activity: [
				makeActivity({ result: longResult }),
				makeActivity({
					id: 'activity-2',
					subscriptionName: 'Watch issue',
					eventType: 'issue',
					status: 'running',
					result: undefined,
					duration: undefined,
				}),
				makeActivity({
					id: 'activity-3',
					subscriptionName: 'Unknown status',
					eventType: 'unknown',
					status: 'queued' as CueActivityEntry['status'],
					result: 'Queued result',
				}),
			],
		});

		fireEvent.click(screen.getByRole('button', { name: 'Activity (3)' }));

		expect(screen.getByText('Refreshing...')).toBeInTheDocument();
		expect(screen.getByText('Build docs')).toBeInTheDocument();
		expect(screen.getByText('Watch issue')).toBeInTheDocument();
		expect(screen.getByText('Unknown status')).toBeInTheDocument();
		expect(screen.getAllByText('1m ago')).toHaveLength(3);
		expect(screen.getAllByText('1m 5s')).toHaveLength(2);
		expect(screen.getByText('running')).toBeInTheDocument();
		expect(screen.getByText('queued')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Build docs/ }));
		expect(screen.getByText(`${'a'.repeat(200)}...`)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Build docs/ }));
		expect(screen.queryByText(`${'a'.repeat(200)}...`)).not.toBeInTheDocument();
	});
});

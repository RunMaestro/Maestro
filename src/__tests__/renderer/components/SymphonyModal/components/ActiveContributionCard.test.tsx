/**
 * Tests for SymphonyModal/components/ActiveContributionCard - status rendering,
 * finalize gating, sync/finalize callbacks, session jump, draft PR link.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const openUrlSpy = vi.fn();
vi.mock('../../../../../renderer/utils/openUrl', () => ({
	openUrl: (...args: unknown[]) => openUrlSpy(...args),
}));

vi.mock('../../../../../renderer/components/ui/Spinner', () => ({
	Spinner: ({ size }: { size?: number }) => <span data-testid="spinner" data-size={size} />,
}));

vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const C = ({ className }: { className?: string }) => (
			<svg data-testid={`icon-${name}`} className={className} />
		);
		C.displayName = name;
		return C;
	};
	return {
		RefreshCw: icon('RefreshCw'),
		GitPullRequest: icon('GitPullRequest'),
		GitBranch: icon('GitBranch'),
		Clock: icon('Clock'),
		ExternalLink: icon('ExternalLink'),
		Terminal: icon('Terminal'),
		Play: icon('Play'),
		Pause: icon('Pause'),
		CheckCircle: icon('CheckCircle'),
		AlertCircle: icon('AlertCircle'),
		X: icon('X'),
	};
});

import { ActiveContributionCard } from '../../../../../renderer/components/SymphonyModal/components/ActiveContributionCard';
import { mockTheme, makeActiveContribution } from '../_fixtures';

beforeEach(() => openUrlSpy.mockReset());

describe('ActiveContributionCard', () => {
	const defaultProps = {
		theme: mockTheme,
		onFinalize: vi.fn(),
		onSync: vi.fn(),
		isSyncing: false,
		sessionName: null,
		onNavigateToSession: vi.fn(),
	};

	it('renders issue title, number, and repo slug', () => {
		const { getByText } = render(
			<ActiveContributionCard {...defaultProps} contribution={makeActiveContribution()} />
		);
		expect(getByText('#42')).toBeTruthy();
		expect(getByText('Improve error handling')).toBeTruthy();
		expect(getByText('maestro/example')).toBeTruthy();
	});

	it('renders status icon and label from getStatusInfo', () => {
		const { getByText, getByTestId } = render(
			<ActiveContributionCard
				{...defaultProps}
				contribution={makeActiveContribution({ status: 'paused' })}
			/>
		);
		expect(getByText('Paused')).toBeTruthy();
		expect(getByTestId('icon-Pause')).toBeTruthy();
	});

	it('opens the draft PR URL when present, otherwise shows "will be created" hint', () => {
		const { getByText, queryByText, rerender } = render(
			<ActiveContributionCard
				{...defaultProps}
				contribution={makeActiveContribution({
					draftPrUrl: 'https://github.com/x/y/pull/5',
					draftPrNumber: 5,
				})}
			/>
		);
		const link = getByText(/Draft PR #5/);
		fireEvent.click(link);
		expect(openUrlSpy).toHaveBeenCalledWith('https://github.com/x/y/pull/5');

		rerender(
			<ActiveContributionCard
				{...defaultProps}
				contribution={makeActiveContribution({ draftPrUrl: undefined, draftPrNumber: undefined })}
			/>
		);
		expect(queryByText(/Draft PR/)).toBeNull();
		expect(getByText(/PR will be created on first commit/)).toBeTruthy();
	});

	it('renders the Finalize PR button only when status === ready_for_review', () => {
		const onFinalize = vi.fn();
		const { queryByText, rerender, getByText } = render(
			<ActiveContributionCard
				{...defaultProps}
				onFinalize={onFinalize}
				contribution={makeActiveContribution({ status: 'running' })}
			/>
		);
		expect(queryByText('Finalize PR')).toBeNull();

		rerender(
			<ActiveContributionCard
				{...defaultProps}
				onFinalize={onFinalize}
				contribution={makeActiveContribution({ status: 'ready_for_review' })}
			/>
		);
		fireEvent.click(getByText('Finalize PR'));
		expect(onFinalize).toHaveBeenCalledTimes(1);
	});

	it('calls onSync and spins the icon while isSyncing', () => {
		const onSync = vi.fn();
		const { getByTitle, getByTestId, rerender } = render(
			<ActiveContributionCard
				{...defaultProps}
				onSync={onSync}
				contribution={makeActiveContribution()}
			/>
		);
		fireEvent.click(getByTitle('Sync status with GitHub'));
		expect(onSync).toHaveBeenCalledTimes(1);
		expect(getByTestId('icon-RefreshCw').getAttribute('class')).not.toMatch(/animate-spin/);

		rerender(
			<ActiveContributionCard
				{...defaultProps}
				onSync={onSync}
				isSyncing
				contribution={makeActiveContribution()}
			/>
		);
		expect(getByTestId('icon-RefreshCw').getAttribute('class')).toMatch(/animate-spin/);
	});

	it('renders a session-jump button when sessionName is provided', () => {
		const onNavigateToSession = vi.fn();
		const { getByText } = render(
			<ActiveContributionCard
				{...defaultProps}
				sessionName="my-agent"
				onNavigateToSession={onNavigateToSession}
				contribution={makeActiveContribution()}
			/>
		);
		fireEvent.click(getByText('my-agent'));
		expect(onNavigateToSession).toHaveBeenCalledTimes(1);
	});

	it('renders the error banner when contribution.error is set', () => {
		const { getByText } = render(
			<ActiveContributionCard
				{...defaultProps}
				contribution={makeActiveContribution({ error: 'Something went wrong' })}
			/>
		);
		expect(getByText('Something went wrong')).toBeTruthy();
	});

	it('renders progress fraction + percentage width', () => {
		const { getByText, container } = render(
			<ActiveContributionCard
				{...defaultProps}
				contribution={makeActiveContribution({
					progress: {
						completedDocuments: 2,
						totalDocuments: 4,
						currentDocument: 'docs/cur.md',
						currentTask: null,
					},
				})}
			/>
		);
		expect(getByText(/2 \/ 4 documents/)).toBeTruthy();
		expect(getByText(/Current: docs\/cur\.md/)).toBeTruthy();
		const bar = container.querySelector('div.rounded-full[style*="width"]');
		expect(bar).toBeTruthy();
		expect((bar as HTMLElement).style.width).toBe('50%');
	});
});

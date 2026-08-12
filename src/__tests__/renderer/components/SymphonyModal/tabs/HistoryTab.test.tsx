/**
 * Tests for SymphonyModal/tabs/HistoryTab - stats summary gating, completed
 * grid, empty state, merged-badge surfacing.
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const C = () => <svg data-testid={`icon-${name}`} />;
		C.displayName = name;
		return C;
	};
	return {
		Music: icon('Music'),
		GitMerge: icon('GitMerge'),
		GitPullRequest: icon('GitPullRequest'),
		ExternalLink: icon('ExternalLink'),
		X: icon('X'),
	};
});

import { HistoryTab } from '../../../../../renderer/components/SymphonyModal/tabs/HistoryTab';
import { mockTheme, makeCompletedContribution } from '../_fixtures';

const baseProps = (overrides: Partial<React.ComponentProps<typeof HistoryTab>> = {}) => ({
	theme: mockTheme,
	stats: null,
	formattedTotalTokens: '0',
	formattedTotalCost: '$0.00',
	completedContributions: [],
	...overrides,
});

describe('HistoryTab', () => {
	it('shows the stats summary when totalContributions > 0', () => {
		const { getByText } = render(
			<HistoryTab
				{...baseProps({
					stats: { totalContributions: 5, totalMerged: 3, totalTasksCompleted: 22 },
					formattedTotalTokens: '42K',
					formattedTotalCost: '$3.50',
				})}
			/>
		);
		expect(getByText('5')).toBeTruthy();
		expect(getByText('3')).toBeTruthy();
		expect(getByText('22')).toBeTruthy();
		expect(getByText('42K')).toBeTruthy();
		expect(getByText('$3.50')).toBeTruthy();
	});

	it('hides the stats summary when totalContributions === 0', () => {
		const { queryByText } = render(
			<HistoryTab
				{...baseProps({
					stats: { totalContributions: 0, totalMerged: 0, totalTasksCompleted: 0 },
				})}
			/>
		);
		expect(queryByText('PRs Created')).toBeNull();
	});

	it('hides the stats summary when stats is null', () => {
		const { queryByText } = render(<HistoryTab {...baseProps({ stats: null })} />);
		expect(queryByText('PRs Created')).toBeNull();
	});

	it('renders the empty state when no completed contributions', () => {
		const { getByText } = render(<HistoryTab {...baseProps()} />);
		expect(getByText('No completed contributions')).toBeTruthy();
	});

	it('renders one card per completed contribution', () => {
		const { getByText } = render(
			<HistoryTab
				{...baseProps({
					completedContributions: [
						makeCompletedContribution({ id: 'a', issueNumber: 1, issueTitle: 'first' }),
						makeCompletedContribution({ id: 'b', issueNumber: 2, issueTitle: 'second' }),
					],
				})}
			/>
		);
		expect(getByText('first')).toBeTruthy();
		expect(getByText('second')).toBeTruthy();
	});

	it('surfaces the Merged badge on a merged contribution', () => {
		const { getByText } = render(
			<HistoryTab
				{...baseProps({
					completedContributions: [makeCompletedContribution({ id: 'a', wasMerged: true })],
				})}
			/>
		);
		expect(getByText('Merged')).toBeTruthy();
	});
});

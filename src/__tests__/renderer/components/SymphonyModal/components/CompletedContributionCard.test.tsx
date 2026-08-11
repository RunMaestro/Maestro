/**
 * Tests for SymphonyModal/components/CompletedContributionCard - merged/closed/open
 * badge variants, PR link, token formatting.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

const openUrlSpy = vi.fn();
vi.mock('../../../../../renderer/utils/openUrl', () => ({
	openUrl: (...args: unknown[]) => openUrlSpy(...args),
}));

vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const C = () => <svg data-testid={`icon-${name}`} />;
		C.displayName = name;
		return C;
	};
	return {
		GitMerge: icon('GitMerge'),
		GitPullRequest: icon('GitPullRequest'),
		X: icon('X'),
		ExternalLink: icon('ExternalLink'),
	};
});

import { CompletedContributionCard } from '../../../../../renderer/components/SymphonyModal/components/CompletedContributionCard';
import { mockTheme, makeCompletedContribution } from '../_fixtures';

beforeEach(() => openUrlSpy.mockReset());

describe('CompletedContributionCard', () => {
	it('renders Merged badge when wasMerged is true', () => {
		const { getByText, getByTestId } = render(
			<CompletedContributionCard
				contribution={makeCompletedContribution({ wasMerged: true })}
				theme={mockTheme}
			/>
		);
		expect(getByText('Merged')).toBeTruthy();
		expect(getByTestId('icon-GitMerge')).toBeTruthy();
	});

	it('renders Closed badge when wasClosed is true and wasMerged is false', () => {
		const { getByText } = render(
			<CompletedContributionCard
				contribution={makeCompletedContribution({ wasMerged: false, wasClosed: true })}
				theme={mockTheme}
			/>
		);
		expect(getByText('Closed')).toBeTruthy();
	});

	it('renders Open badge when neither merged nor closed', () => {
		const { getByText } = render(
			<CompletedContributionCard
				contribution={makeCompletedContribution({ wasMerged: false, wasClosed: false })}
				theme={mockTheme}
			/>
		);
		expect(getByText('Open')).toBeTruthy();
	});

	it('falls back to legacy `merged` property when wasMerged is undefined', () => {
		const { getByText } = render(
			<CompletedContributionCard
				contribution={makeCompletedContribution({
					wasMerged: undefined,
					merged: true,
				} as Parameters<typeof makeCompletedContribution>[0])}
				theme={mockTheme}
			/>
		);
		expect(getByText('Merged')).toBeTruthy();
	});

	it('opens the PR URL when the PR link is clicked', () => {
		const { getByText } = render(
			<CompletedContributionCard
				contribution={makeCompletedContribution({
					prNumber: 11,
					prUrl: 'https://github.com/x/y/pull/11',
				})}
				theme={mockTheme}
			/>
		);
		fireEvent.click(getByText(/PR #11/));
		expect(openUrlSpy).toHaveBeenCalledWith('https://github.com/x/y/pull/11');
	});

	it('formats token counts: ≥ 1000 in "X.YK", < 1000 as raw integer; renders cost', () => {
		const { getByText, rerender } = render(
			<CompletedContributionCard
				contribution={makeCompletedContribution({
					tokenUsage: { inputTokens: 30_000, outputTokens: 5_000, totalCost: 0.42 },
				})}
				theme={mockTheme}
			/>
		);
		expect(getByText('35.0K')).toBeTruthy();
		expect(getByText('$0.42')).toBeTruthy();

		rerender(
			<CompletedContributionCard
				contribution={makeCompletedContribution({
					tokenUsage: { inputTokens: 200, outputTokens: 300, totalCost: 0.0 },
				})}
				theme={mockTheme}
			/>
		);
		expect(getByText('500')).toBeTruthy();
	});
});

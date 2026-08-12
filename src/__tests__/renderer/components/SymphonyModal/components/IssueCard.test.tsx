/**
 * Tests for SymphonyModal/components/IssueCard - selection, blocking labels,
 * claimed-PR link, document count, keyboard activation.
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
		Lock: icon('Lock'),
		GitPullRequest: icon('GitPullRequest'),
		FileText: icon('FileText'),
		ExternalLink: icon('ExternalLink'),
	};
});

import { IssueCard } from '../../../../../renderer/components/SymphonyModal/components/IssueCard';
import { mockTheme, makeIssue } from '../_fixtures';
import { SYMPHONY_BLOCKING_LABEL } from '../../../../../shared/symphony-constants';

beforeEach(() => {
	openUrlSpy.mockReset();
});

describe('IssueCard', () => {
	it('renders title, number, and document count (plural)', () => {
		const { getByText } = render(
			<IssueCard issue={makeIssue()} theme={mockTheme} isSelected={false} onSelect={() => {}} />
		);
		expect(getByText('#42')).toBeTruthy();
		expect(getByText('Improve error handling')).toBeTruthy();
		expect(getByText('1 document')).toBeTruthy();
	});

	it('renders "N documents" plural', () => {
		const { getByText } = render(
			<IssueCard
				issue={makeIssue({
					documentPaths: [
						{ name: 'a.md', path: 'a.md', isExternal: false },
						{ name: 'b.md', path: 'b.md', isExternal: false },
					],
				})}
				theme={mockTheme}
				isSelected={false}
				onSelect={() => {}}
			/>
		);
		expect(getByText('2 documents')).toBeTruthy();
	});

	it('renders Blocked badge when the blocking label is present', () => {
		const { getByText, getByTestId } = render(
			<IssueCard
				issue={makeIssue({
					labels: [{ name: SYMPHONY_BLOCKING_LABEL, color: 'red' }],
				})}
				theme={mockTheme}
				isSelected={false}
				onSelect={() => {}}
			/>
		);
		expect(getByText('Blocked')).toBeTruthy();
		expect(getByTestId('icon-Lock')).toBeTruthy();
	});

	it('renders Claimed badge + draft-PR link when status is in_progress with a claimedByPr', () => {
		const { getByText } = render(
			<IssueCard
				issue={makeIssue({
					status: 'in_progress',
					claimedByPr: {
						number: 99,
						url: 'https://github.com/x/y/pull/99',
						author: 'alice',
						isDraft: true,
					},
				})}
				theme={mockTheme}
				isSelected={false}
				onSelect={() => {}}
			/>
		);
		expect(getByText('Claimed')).toBeTruthy();
		expect(getByText(/Draft PR #99/)).toBeTruthy();
		expect(getByText(/by @alice/)).toBeTruthy();
	});

	it('opens the PR URL when the claimed-PR link is clicked and stops propagation', () => {
		const onSelect = vi.fn();
		const { getByText } = render(
			<IssueCard
				issue={makeIssue({
					status: 'in_progress',
					claimedByPr: {
						number: 99,
						url: 'https://github.com/x/y/pull/99',
						author: 'alice',
						isDraft: false,
					},
				})}
				theme={mockTheme}
				isSelected={false}
				onSelect={onSelect}
			/>
		);
		fireEvent.click(getByText(/PR #99/));
		expect(openUrlSpy).toHaveBeenCalledWith('https://github.com/x/y/pull/99');
		// onSelect should NOT fire (stopPropagation)
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('fires onSelect on click when the issue is available', () => {
		const onSelect = vi.fn();
		const { container } = render(
			<IssueCard issue={makeIssue()} theme={mockTheme} isSelected={false} onSelect={onSelect} />
		);
		fireEvent.click(container.querySelector('[role="button"]')!);
		expect(onSelect).toHaveBeenCalledTimes(1);
	});

	it('activates on Enter and Space when focused, and not on other keys', () => {
		const onSelect = vi.fn();
		const { container } = render(
			<IssueCard issue={makeIssue()} theme={mockTheme} isSelected={false} onSelect={onSelect} />
		);
		const btn = container.querySelector('[role="button"]')!;
		fireEvent.keyDown(btn, { key: 'Enter' });
		fireEvent.keyDown(btn, { key: ' ' });
		fireEvent.keyDown(btn, { key: 'a' });
		expect(onSelect).toHaveBeenCalledTimes(2);
	});

	it('does not expose button semantics or select handlers for claimed issues', () => {
		const onSelect = vi.fn();
		const { container } = render(
			<IssueCard
				issue={makeIssue({ status: 'in_progress' })}
				theme={mockTheme}
				isSelected={false}
				onSelect={onSelect}
			/>
		);
		const card = container.firstElementChild as HTMLElement;
		expect(card.getAttribute('role')).toBeNull();
		expect(card.tabIndex).toBe(-1);
		fireEvent.click(card);
		fireEvent.keyDown(card, { key: 'Enter' });
		expect(onSelect).not.toHaveBeenCalled();
	});

	it('lists up to 2 document names then "...and N more"', () => {
		const { getByText, queryByText } = render(
			<IssueCard
				issue={makeIssue({
					documentPaths: [
						{ name: 'a.md', path: 'docs/a.md', isExternal: false },
						{ name: 'b.md', path: 'docs/b.md', isExternal: false },
						{ name: 'c.md', path: 'docs/c.md', isExternal: false },
						{ name: 'd.md', path: 'docs/d.md', isExternal: false },
					],
				})}
				theme={mockTheme}
				isSelected={false}
				onSelect={() => {}}
			/>
		);
		expect(getByText(/a.md/)).toBeTruthy();
		expect(getByText(/b.md/)).toBeTruthy();
		expect(queryByText(/c.md/)).toBeNull();
		expect(getByText(/and 2 more/)).toBeTruthy();
	});
});

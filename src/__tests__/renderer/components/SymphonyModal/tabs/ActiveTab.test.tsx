/**
 * Tests for SymphonyModal/tabs/ActiveTab - empty state CTA, count display,
 * Check PR Status button, sync routing, session jump.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';

vi.mock('lucide-react', () => {
	const icon = (name: string) => {
		const C = ({ className }: { className?: string }) => (
			<svg data-testid={`icon-${name}`} className={className} />
		);
		C.displayName = name;
		return C;
	};
	return {
		Music: icon('Music'),
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

vi.mock('../../../../../renderer/components/ui/Spinner', () => ({
	Spinner: () => <span data-testid="spinner" />,
}));

import { ActiveTab } from '../../../../../renderer/components/SymphonyModal/tabs/ActiveTab';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { mockTheme, makeActiveContribution } from '../_fixtures';
import type { Session } from '../../../../../renderer/types';

const baseProps = (overrides: Partial<React.ComponentProps<typeof ActiveTab>> = {}) => ({
	theme: mockTheme,
	activeContributions: [],
	prStatusMessage: null,
	isCheckingPRStatuses: false,
	syncingContributionId: null,
	onCheckPRStatuses: vi.fn(),
	onSyncContribution: vi.fn(),
	onFinalize: vi.fn(),
	onSwitchToProjects: vi.fn(),
	onSelectSession: vi.fn(),
	onCloseModal: vi.fn(),
	...overrides,
});

describe('ActiveTab', () => {
	beforeEach(() => {
		useSessionStore.setState({ sessions: [] });
	});

	it('renders the empty-state CTA when there are no contributions', () => {
		const onSwitchToProjects = vi.fn();
		const { getByText } = render(<ActiveTab {...baseProps({ onSwitchToProjects })} />);
		expect(getByText('No active contributions')).toBeTruthy();
		fireEvent.click(getByText('Browse Projects'));
		expect(onSwitchToProjects).toHaveBeenCalledTimes(1);
	});

	it('shows pluralised count when contributions > 1', () => {
		const { getByText } = render(
			<ActiveTab
				{...baseProps({
					activeContributions: [
						makeActiveContribution({ id: 'a' }),
						makeActiveContribution({ id: 'b' }),
					],
				})}
			/>
		);
		expect(getByText(/2 active contributions/)).toBeTruthy();
	});

	it('shows singular "contribution" for exactly one', () => {
		const { getByText } = render(
			<ActiveTab {...baseProps({ activeContributions: [makeActiveContribution({ id: 'one' })] })} />
		);
		expect(getByText(/1 active contribution(?!s)/)).toBeTruthy();
	});

	it('Check PR Status button fires onCheckPRStatuses and spins while checking', () => {
		const onCheckPRStatuses = vi.fn();
		const { getByTitle, getByTestId, rerender } = render(
			<ActiveTab {...baseProps({ onCheckPRStatuses })} />
		);
		fireEvent.click(getByTitle('Check for merged or closed PRs'));
		expect(onCheckPRStatuses).toHaveBeenCalledTimes(1);
		expect(getByTestId('icon-RefreshCw').getAttribute('class')).not.toMatch(/animate-spin/);

		rerender(<ActiveTab {...baseProps({ isCheckingPRStatuses: true })} />);
		expect(getByTestId('icon-RefreshCw').getAttribute('class')).toMatch(/animate-spin/);
	});

	it('renders prStatusMessage when set', () => {
		const { getByText } = render(<ActiveTab {...baseProps({ prStatusMessage: '2 PRs merged' })} />);
		expect(getByText('2 PRs merged')).toBeTruthy();
	});

	it('resolves sessionName by sessionId and triggers select + close on jump', () => {
		const onSelectSession = vi.fn();
		const onCloseModal = vi.fn();
		useSessionStore.setState({
			sessions: [{ id: 'session-1', name: 'my-agent' } as unknown as Session],
		});
		const { getByText } = render(
			<ActiveTab
				{...baseProps({
					onSelectSession,
					onCloseModal,
					activeContributions: [makeActiveContribution({ id: 'c1', sessionId: 'session-1' })],
				})}
			/>
		);
		fireEvent.click(getByText('my-agent'));
		expect(onSelectSession).toHaveBeenCalledWith('session-1');
		expect(onCloseModal).toHaveBeenCalledTimes(1);
	});
});

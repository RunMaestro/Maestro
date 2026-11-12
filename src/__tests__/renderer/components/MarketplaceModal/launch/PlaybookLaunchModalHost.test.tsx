/**
 * Tests for PlaybookLaunchModalHost: it mounts the launch dialog from the modal store and decides
 * what the two ways out do. The dialog itself has its own suite, so a stand-in records the props
 * the host gives it and lets a test press Cancel or report a launch that started.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { PlaybookLaunchModalProps } from '../../../../../renderer/components/MarketplaceModal/launch/PlaybookLaunchModal';

const dialog = vi.hoisted(() => ({ props: null as Record<string, any> | null }));

vi.mock('../../../../../renderer/components/MarketplaceModal/launch/PlaybookLaunchModal', () => ({
	PlaybookLaunchModal: (props: PlaybookLaunchModalProps) => {
		dialog.props = props;
		return (
			<div data-testid="launch-dialog-stub" data-playbook-id={props.playbook.id}>
				<button type="button" onClick={props.onClose}>
					Cancel
				</button>
				<button
					type="button"
					onClick={() =>
						props.onLaunched({
							status: 'started',
							target: { sessionId: 'agent-1', autoRunFolderPath: '/work/alpha/Docs' },
						})
					}
				>
					Report started
				</button>
				<button
					type="button"
					onClick={() =>
						props.onLaunched({
							status: 'started',
							target: { sessionId: 'agent-2', autoRunFolderPath: '/work/new/Docs' },
							createdSessionId: 'agent-2',
						})
					}
				>
					Report started on a new agent
				</button>
			</div>
		);
	},
}));

vi.mock('../../../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(),
}));

import { PlaybookLaunchModalHost } from '../../../../../renderer/components/MarketplaceModal/launch/PlaybookLaunchModalHost';
import { notifyToast } from '../../../../../renderer/stores/notificationStore';
import { getModalActions, useModalStore } from '../../../../../renderer/stores/modalStore';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createMockSession, resetStores } from '../../../../helpers';
import { mockTheme } from '../../../../helpers/mockTheme';
import { makePlaybook } from '../_fixtures';

const playbook = makePlaybook({
	id: 'development-code-review',
	title: 'Code Review',
	launch: { inputs: [], outro: { summary: 'Done.', nextSteps: [] } },
});

const isOpen = (id: 'marketplace' | 'playbookLaunch') => useModalStore.getState().isOpen(id);

beforeEach(() => {
	vi.clearAllMocks();
	dialog.props = null;
	useModalStore.setState({ modals: new Map() });
	resetStores(useSessionStore);
	useSessionStore.setState({
		sessions: [
			createMockSession({ id: 'agent-1', name: 'Alpha' }),
			createMockSession({ id: 'agent-2', name: 'Market Research' }),
		],
		activeSessionId: 'agent-1',
	});
});

describe('PlaybookLaunchModalHost', () => {
	it('draws nothing while no playbook is set', () => {
		const { container } = render(<PlaybookLaunchModalHost theme={mockTheme} />);

		expect(container.firstChild).toBeNull();
		expect(dialog.props).toBeNull();
	});

	it('draws the dialog for the playbook the Exchange opened it with', () => {
		render(<PlaybookLaunchModalHost theme={mockTheme} />);

		act(() => getModalActions().openPlaybookLaunch(playbook));

		expect(screen.getByTestId('launch-dialog-stub').getAttribute('data-playbook-id')).toBe(
			'development-code-review'
		);
		expect(dialog.props?.playbook).toBe(playbook);
		expect(dialog.props?.theme).toBe(mockTheme);
	});

	it('goes away when the store closes the dialog', () => {
		render(<PlaybookLaunchModalHost theme={mockTheme} />);
		act(() => getModalActions().openPlaybookLaunch(playbook));

		act(() => getModalActions().closePlaybookLaunch());

		expect(screen.queryByTestId('launch-dialog-stub')).toBeNull();
	});

	describe('Cancel', () => {
		it('closes only the dialog, so the person is back on the playbook in the Exchange', () => {
			render(<PlaybookLaunchModalHost theme={mockTheme} />);
			act(() => {
				getModalActions().setMarketplaceModalOpen(true);
				getModalActions().openPlaybookLaunch(playbook);
			});

			fireEvent.click(screen.getByText('Cancel'));

			expect(isOpen('playbookLaunch')).toBe(false);
			expect(isOpen('marketplace')).toBe(true);
			expect(screen.queryByTestId('launch-dialog-stub')).toBeNull();
			expect(notifyToast).not.toHaveBeenCalled();
		});
	});

	describe('a launch that started', () => {
		beforeEach(() => {
			render(<PlaybookLaunchModalHost theme={mockTheme} />);
			act(() => {
				getModalActions().setMarketplaceModalOpen(true);
				getModalActions().openPlaybookLaunch(playbook);
			});
		});

		it('closes both the dialog and the Exchange', () => {
			fireEvent.click(screen.getByText('Report started'));

			expect(isOpen('playbookLaunch')).toBe(false);
			expect(isOpen('marketplace')).toBe(false);
			expect(screen.queryByTestId('launch-dialog-stub')).toBeNull();
		});

		it('raises one toast naming the playbook and the agent, and going to that agent', () => {
			fireEvent.click(screen.getByText('Report started'));

			expect(notifyToast).toHaveBeenCalledTimes(1);
			expect(notifyToast).toHaveBeenCalledWith({
				color: 'green',
				title: 'Playbook launched',
				message: '"Code Review" is running on "Alpha".',
				project: 'Alpha',
				sessionId: 'agent-1',
			});
		});

		it('says so when the launch created the agent', () => {
			fireEvent.click(screen.getByText('Report started on a new agent'));

			expect(notifyToast).toHaveBeenCalledWith(
				expect.objectContaining({
					message: 'Created "Market Research" and started "Code Review" on it.',
					sessionId: 'agent-2',
				})
			);
			expect(isOpen('marketplace')).toBe(false);
		});
	});
});

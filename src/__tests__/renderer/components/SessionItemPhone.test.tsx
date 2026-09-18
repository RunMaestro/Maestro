/**
 * @fileoverview Tests for the SessionItem phone layout.
 *
 * On a phone the Left Bar is a full-screen drawer and each row is the agent's
 * name plus its status dot. The provider line, location pills, git count,
 * bookmark toggle, and Cue / startup-command glyphs that crowd a 390px row all
 * come off; state that needs attention (AUTO, ERR) stays.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionItem } from '../../../renderer/components/SessionItem';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { usePhoneLayout } from '../../../renderer/hooks/ui/useViewportBreakpoint';
import { createMockSession } from '../../helpers/mockSession';
import { mockTheme } from '../../helpers/mockTheme';

vi.mock('../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/hooks/ui/useViewportBreakpoint')>()),
	usePhoneLayout: vi.fn(() => false),
}));
const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);

vi.mock('lucide-react', async (importOriginal) => ({
	...(await importOriginal()),
	Activity: () => <span data-testid="icon-activity" />,
	GitBranch: () => <span data-testid="icon-git-branch" />,
	Bot: () => <span data-testid="icon-bot" />,
	Bookmark: () => <span data-testid="icon-bookmark" />,
	AlertCircle: () => <span data-testid="icon-alert-circle" />,
	Server: () => <span data-testid="icon-server" />,
}));

const session = () =>
	createMockSession({
		name: 'Interplay Companion',
		cwd: '/home/user/project',
		fullPath: '/home/user/project',
		projectRoot: '/home/user/project',
		isGitRepo: true,
		sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } as never,
	});

const defaultProps = {
	variant: 'flat' as const,
	theme: mockTheme,
	isActive: false,
	isKeyboardSelected: false,
	isDragging: false,
	isEditing: false,
	leftSidebarOpen: true,
	gitFileCount: 4,
	onSelect: vi.fn(),
	onDragStart: vi.fn(),
	onContextMenu: vi.fn(),
	onFinishRename: vi.fn(),
	onStartRename: vi.fn(),
	onToggleBookmark: vi.fn(),
};

describe('SessionItem on a phone', () => {
	beforeEach(() => {
		useSettingsStore.setState({
			showLeftPanelLocationPills: true,
			showLeftPanelGitIndicator: true,
		});
	});

	afterEach(() => {
		mockedUsePhoneLayout.mockReturnValue(false);
	});

	it('keeps the adornments on desktop', () => {
		mockedUsePhoneLayout.mockReturnValue(false);
		render(<SessionItem {...defaultProps} session={session()} />);
		expect(screen.getByText('Interplay Companion')).toBeInTheDocument();
		expect(screen.getByTestId('icon-activity')).toBeInTheDocument();
		expect(screen.getByTestId('icon-bookmark')).toBeInTheDocument();
		expect(screen.getByTestId('icon-server')).toBeInTheDocument();
		expect(screen.getByText('GIT')).toBeInTheDocument();
		expect(screen.getByTestId('icon-git-branch')).toBeInTheDocument();
	});

	it('reduces the row to the name and the status dot on a phone', () => {
		mockedUsePhoneLayout.mockReturnValue(true);
		render(<SessionItem {...defaultProps} session={session()} />);
		expect(screen.getByText('Interplay Companion')).toBeInTheDocument();
		// Provider line, bookmark, SSH / GIT pills, git dirty count: all gone.
		expect(screen.queryByTestId('icon-activity')).not.toBeInTheDocument();
		expect(screen.queryByTestId('icon-bookmark')).not.toBeInTheDocument();
		expect(screen.queryByTestId('icon-server')).not.toBeInTheDocument();
		expect(screen.queryByText('GIT')).not.toBeInTheDocument();
		expect(screen.queryByTestId('icon-git-branch')).not.toBeInTheDocument();
		// The two-line grid goes with the meta line it existed for.
		expect(document.querySelector('.session-row')).toBeNull();
	});

	it('still surfaces state that needs attention', () => {
		mockedUsePhoneLayout.mockReturnValue(true);
		render(
			<SessionItem
				{...defaultProps}
				isInBatch
				session={createMockSession({
					name: 'Busy One',
					agentError: { message: 'boom', type: 'unknown' } as never,
				})}
			/>
		);
		expect(screen.getByText('AUTO')).toBeInTheDocument();
		expect(screen.getByText('ERR')).toBeInTheDocument();
	});
});

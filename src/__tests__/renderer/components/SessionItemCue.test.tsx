/**
 * @fileoverview Tests for SessionItem Cue status indicator
 *
 * Validates that the Zap icon appears next to session names when
 * the session has active Cue subscriptions, with correct tooltip text.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionItem } from '../../../renderer/components/SessionItem';
import type { Session, Theme } from '../../../renderer/types';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
	Activity: () => <span data-testid="icon-activity" />,
	GitBranch: () => <span data-testid="icon-git-branch" />,
	Bot: () => <span data-testid="icon-bot" />,
	Bookmark: ({ fill }: { fill?: string }) => <span data-testid="icon-bookmark" data-fill={fill} />,
	AlertCircle: () => <span data-testid="icon-alert-circle" />,
	Server: () => <span data-testid="icon-server" />,
	Zap: ({
		title,
		style,
		fill,
	}: {
		title?: string;
		style?: Record<string, string>;
		fill?: string;
	}) => <span data-testid="icon-zap" title={title} style={style} data-fill={fill} />,
}));

const defaultTheme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#282a36',
		bgSidebar: '#21222c',
		bgActivity: '#343746',
		textMain: '#f8f8f2',
		textDim: '#6272a4',
		accent: '#bd93f9',
		accentForeground: '#f8f8f2',
		border: '#44475a',
		success: '#50fa7b',
		warning: '#ffb86c',
		error: '#ff5555',
		info: '#8be9fd',
	},
};

const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'session-1',
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	cwd: '/home/user/project',
	projectRoot: '/home/user/project',
	aiPid: 12345,
	terminalPid: 12346,
	aiLogs: [],
	shellLogs: [],
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	messageQueue: [],
	contextUsage: 30,
	activeTimeMs: 60000,
	...overrides,
});

const defaultProps = {
	variant: 'flat' as const,
	theme: defaultTheme,
	isActive: false,
	isKeyboardSelected: false,
	isDragging: false,
	isEditing: false,
	leftSidebarOpen: true,
	onSelect: vi.fn(),
	onDragStart: vi.fn(),
	onContextMenu: vi.fn(),
	onFinishRename: vi.fn(),
	onStartRename: vi.fn(),
	onToggleBookmark: vi.fn(),
};

describe('SessionItem Cue Indicator', () => {
	it('shows Zap icon when cueSubscriptionCount > 0', () => {
		render(
			<SessionItem {...defaultProps} session={createMockSession()} cueSubscriptionCount={3} />
		);

		const zapIcon = screen.getByTestId('icon-zap');
		expect(zapIcon).toBeInTheDocument();
		// Title is on the wrapper span, not the icon itself
		expect(zapIcon.closest('span[title]')).toHaveAttribute(
			'title',
			'Maestro Cue active (3 subscriptions)'
		);
	});

	it('does not show Zap icon when cueSubscriptionCount is undefined', () => {
		render(<SessionItem {...defaultProps} session={createMockSession()} />);

		expect(screen.queryByTestId('icon-zap')).not.toBeInTheDocument();
	});

	it('does not show Zap icon when cueSubscriptionCount is 0', () => {
		render(
			<SessionItem {...defaultProps} session={createMockSession()} cueSubscriptionCount={0} />
		);

		expect(screen.queryByTestId('icon-zap')).not.toBeInTheDocument();
	});

	it('shows singular "subscription" for count of 1', () => {
		render(
			<SessionItem {...defaultProps} session={createMockSession()} cueSubscriptionCount={1} />
		);

		const zapIcon = screen.getByTestId('icon-zap');
		expect(zapIcon.closest('span[title]')).toHaveAttribute(
			'title',
			'Maestro Cue active (1 subscription)'
		);
	});

	it('uses teal color for the Zap icon', () => {
		render(
			<SessionItem {...defaultProps} session={createMockSession()} cueSubscriptionCount={2} />
		);

		const zapIcon = screen.getByTestId('icon-zap');
		// jsdom converts hex to rgb
		expect(zapIcon.style.color).toBe('rgb(45, 212, 191)');
	});

	it('does not show Zap icon when session is in editing mode', () => {
		render(
			<SessionItem
				{...defaultProps}
				session={createMockSession()}
				cueSubscriptionCount={3}
				isEditing={true}
			/>
		);

		// In editing mode, the name row is replaced by an input field
		expect(screen.queryByTestId('icon-zap')).not.toBeInTheDocument();
	});
});

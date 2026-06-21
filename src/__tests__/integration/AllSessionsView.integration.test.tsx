import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../../web/components/ThemeProvider';
import { AllSessionsView, type AllSessionsViewProps } from '../../web/mobile/AllSessionsView';
import type { Session } from '../../web/hooks/useSessions';
import type { Theme } from '../../shared/theme-types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Core',
		state: 'idle',
		inputMode: 'ai',
		toolType: 'claude-code',
		cwd: '/Users/test/Core',
		projectRoot: '/Users/test/Core',
		bookmarked: false,
		groupId: null,
		groupName: null,
		groupEmoji: null,
		...overrides,
	} as Session;
}

const sessions: Session[] = [
	createSession({
		id: 'parent',
		name: 'Core',
		cwd: '/Users/test/Core',
		projectRoot: '/Users/test/Core',
		bookmarked: true,
		groupId: 'frontend',
		groupName: 'Frontend',
		groupEmoji: 'F',
		state: 'idle',
		inputMode: 'ai',
		toolType: 'claude-code',
	}),
	createSession({
		id: 'child-explicit',
		name: 'feature/auth',
		cwd: '/Users/test/Core-WorkTrees/feature-auth',
		projectRoot: '/Users/test/Core',
		parentSessionId: 'parent',
		worktreeBranch: 'feature/auth',
		state: 'busy',
		inputMode: 'terminal',
		toolType: 'codex',
	}),
	createSession({
		id: 'child-inferred',
		name: 'bugfix',
		cwd: '/Users/test/Core-WorkTrees/bugfix',
		projectRoot: '/Users/test/Core',
		state: 'connecting',
		inputMode: 'ai',
		toolType: 'opencode',
	}),
	createSession({
		id: 'shell',
		name: 'Shell',
		cwd: '/Users/test/very/long/path/to/a/project/with/subfolders',
		projectRoot: '/Users/test/very/long/path/to/a/project/with/subfolders',
		state: 'error',
		inputMode: 'terminal',
		toolType: 'terminal',
	}),
];

function renderView(overrides: Partial<AllSessionsViewProps> = {}) {
	const props: AllSessionsViewProps = {
		sessions,
		activeSessionId: 'parent',
		onSelectSession: vi.fn(),
		onClose: vi.fn(),
		searchQuery: '',
		...overrides,
	};

	const result = render(
		<ThemeProvider theme={theme}>
			<AllSessionsView {...props} />
		</ThemeProvider>
	);

	return { ...result, props };
}

describe('AllSessionsView integration', () => {
	const originalVibrate = navigator.vibrate;

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
			if (typeof args[0] === 'string' && args[0].startsWith('[findParentSession]')) return;
		});
		Object.defineProperty(navigator, 'vibrate', {
			configurable: true,
			value: vi.fn(),
		});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		if (originalVibrate) {
			Object.defineProperty(navigator, 'vibrate', {
				configurable: true,
				value: originalVibrate,
			});
		} else {
			delete (navigator as Partial<Navigator>).vibrate;
		}
	});

	it('renders grouped sessions, expands collapsed groups, and selects a worktree child', async () => {
		const { props } = renderView();

		expect(screen.getByRole('heading', { name: 'All Agents' })).toBeInTheDocument();
		expect(screen.getByPlaceholderText('Search agents...')).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: 'Bookmarks group with 1 sessions. Tap to collapse' })
		).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: /Core session, Ready, ai mode, active/ })
		).toBeInTheDocument();
		expect(screen.getByText('Claude Code')).toBeInTheDocument();

		const frontendGroup = screen.getByRole('button', {
			name: 'Frontend group with 3 sessions. Tap to expand',
		});
		expect(frontendGroup).toHaveAttribute('aria-expanded', 'false');
		fireEvent.click(frontendGroup);
		expect(navigator.vibrate).toHaveBeenCalledWith(10);

		await screen.findByRole('button', {
			name: /Core: feature\/auth session, Thinking\.\.\., terminal mode/,
		});
		expect(screen.getByText('Codex')).toBeInTheDocument();
		expect(screen.getByText('Thinking...')).toBeInTheDocument();
		fireEvent.click(frontendGroup);
		expect(frontendGroup).toHaveAttribute('aria-expanded', 'false');
		fireEvent.click(frontendGroup);
		const expandedChildCard = await screen.findByRole('button', {
			name: /Core: feature\/auth session, Thinking\.\.\., terminal mode/,
		});
		fireEvent.touchStart(expandedChildCard, { touches: [{ clientX: 10, clientY: 10 }] });
		fireEvent.touchEnd(expandedChildCard);

		expect(props.onSelectSession).toHaveBeenCalledWith('child-explicit');
		expect(props.onClose).toHaveBeenCalledOnce();
	});

	it('filters by worktree display name, tool labels, cwd text, clears search, and shows empty search copy', async () => {
		renderView({ searchQuery: 'bugfix' });

		fireEvent.click(
			await screen.findByRole('button', {
				name: 'Frontend group with 1 sessions. Tap to expand',
			})
		);
		expect(
			await screen.findByRole('button', {
				name: /Core: bugfix session, Connecting\.\.\., ai mode/,
			})
		).toBeInTheDocument();
		expect(screen.getByText('OpenCode')).toBeInTheDocument();

		fireEvent.change(screen.getByPlaceholderText('Search agents...'), {
			target: { value: 'terminal' },
		});
		expect(
			await screen.findByRole('button', { name: /Shell session, Error, terminal mode/ })
		).toBeInTheDocument();
		expect(screen.getAllByText('Terminal')).toHaveLength(2);

		fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
		expect(screen.getByPlaceholderText('Search agents...')).toHaveValue('');

		fireEvent.change(screen.getByPlaceholderText('Search agents...'), {
			target: { value: 'no-match' },
		});
		expect(screen.getByText('No sessions found')).toBeInTheDocument();
		expect(screen.getByText('No sessions match "no-match"')).toBeInTheDocument();
	});

	it('renders ungrouped-only and empty states without group headers', () => {
		const ungrouped = [
			createSession({
				id: 'solo',
				name: 'Solo',
				state: 'idle',
				inputMode: 'ai',
				toolType: 'claude-code',
			}),
		];

		const { unmount } = renderView({ sessions: ungrouped, activeSessionId: null });
		expect(screen.queryByText('Ungrouped')).not.toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Solo session, Ready, ai mode/ })).toHaveAttribute(
			'aria-pressed',
			'false'
		);

		unmount();
		renderView({ sessions: [], activeSessionId: null });
		expect(screen.getByText('No sessions available')).toBeInTheDocument();
		expect(
			screen.getByText('Create a session in the desktop app to get started')
		).toBeInTheDocument();
	});

	it('sorts bookmarks, named groups, and ungrouped sessions while keeping orphan worktrees ungrouped', () => {
		const sortedSessions = [
			createSession({
				id: 'ungrouped',
				name: 'Ungrouped',
				groupId: null,
				groupName: null,
				groupEmoji: null,
			}),
			createSession({
				id: 'beta',
				name: 'Beta Session',
				groupId: 'beta',
				groupName: 'Beta',
				groupEmoji: 'B',
			}),
			createSession({
				id: 'alpha',
				name: 'Alpha Session',
				groupId: 'alpha',
				groupName: 'Alpha',
				groupEmoji: 'A',
			}),
			createSession({
				id: 'bookmarked',
				name: 'Bookmarked',
				bookmarked: true,
			}),
			createSession({
				id: 'plain-parent',
				name: 'Plain Parent',
				groupId: null,
				groupName: null,
				groupEmoji: null,
			}),
			createSession({
				id: 'plain-child',
				name: 'child-of-plain',
				cwd: '/Users/test/Plain-WorkTrees/child-of-plain',
				parentSessionId: 'plain-parent',
			}),
			createSession({
				id: 'missing-parent-ref',
				name: 'Missing Parent Ref',
				parentSessionId: 'does-not-exist',
			}),
			createSession({
				id: 'orphan-worktree',
				name: 'orphan',
				cwd: '/Users/test/Missing-WorkTrees/orphan',
				projectRoot: '/Users/test/Missing',
			}),
		];

		renderView({ sessions: sortedSessions, activeSessionId: null });

		const groupNames = screen
			.getAllByRole('button', { name: /group with \d+ sessions/ })
			.map((button) => button.getAttribute('aria-label'));
		expect(groupNames).toEqual([
			'Bookmarks group with 1 sessions. Tap to collapse',
			'Alpha group with 1 sessions. Tap to expand',
			'Beta group with 1 sessions. Tap to expand',
			'Ungrouped group with 6 sessions. Tap to expand',
		]);

		fireEvent.click(
			screen.getByRole('button', { name: 'Ungrouped group with 6 sessions. Tap to expand' })
		);
		expect(
			screen.getByRole('button', { name: /orphan session, Ready, ai mode/ })
		).toBeInTheDocument();
		expect(
			screen.getByRole('button', { name: /Plain Parent: child-of-plain session/ })
		).toBeInTheDocument();
		expect(screen.getByRole('button', { name: /Missing Parent Ref session/ })).toBeInTheDocument();
	});

	it('closes through Done and Escape with listener cleanup on unmount', () => {
		const onClose = vi.fn();
		const { unmount } = renderView({ onClose });

		fireEvent.click(screen.getByRole('button', { name: 'Close All Agents view' }));
		fireEvent.keyDown(document, { key: 'Enter' });
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledTimes(2);

		unmount();
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledTimes(2);
	});
});

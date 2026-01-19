/**
 * Tests for AllSessionsView component
 *
 * Covers:
 * - AllSessionsViewProps interface
 * - AllSessionsView component (main export)
 * - MobileSessionCard internal component
 * - GroupSection internal component
 * - Helper functions (getStatus, getStatusLabel, getToolTypeLabel, truncatePath)
 * - Session filtering and grouping logic
 * - Keyboard navigation (Escape to close)
 * - Haptic feedback integration
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AllSessionsView, type AllSessionsViewProps } from '../../../web/mobile/AllSessionsView';
import type { Session } from '../../../web/hooks/useSessions';

// Mock theme colors
const mockThemeColors = {
	accent: '#8b5cf6',
	textMain: '#f8f8f2',
	textDim: '#6272a4',
	bgMain: '#282a36',
	bgSidebar: '#21222c',
	border: '#44475a',
	success: '#50fa7b',
	warning: '#ffb86c',
	error: '#ff5555',
};

// Mock the ThemeProvider
vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockThemeColors,
	useTheme: () => ({
		theme: {
			id: 'dracula',
			name: 'Dracula',
			mode: 'dark',
			colors: mockThemeColors,
		},
		isLight: false,
		isDark: true,
		isVibe: false,
		isDevicePreference: false,
	}),
}));

// Mock haptic feedback
const mockTriggerHaptic = vi.fn();
vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: (...args: unknown[]) => mockTriggerHaptic(...args),
	HAPTIC_PATTERNS: {
		tap: [10],
		send: [10, 50, 10],
		interrupt: [50],
		success: [10, 30, 10],
		error: [50, 30, 50],
	},
}));

// Helper to create mock sessions
function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Test Session',
		state: 'idle',
		inputMode: 'ai',
		toolType: 'claude-code',
		cwd: '/Users/test/project',
		projectRoot: '/Users/test/project',
		bookmarked: false,
		groupId: null,
		groupName: null,
		groupEmoji: null,
		...overrides,
	} as Session;
}

// Default props for AllSessionsView
function createDefaultProps(overrides: Partial<AllSessionsViewProps> = {}): AllSessionsViewProps {
	return {
		sessions: [createMockSession()],
		activeSessionId: null,
		onSelectSession: vi.fn(),
		onClose: vi.fn(),
		searchQuery: '',
		...overrides,
	};
}

describe('AllSessionsView', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('rendering', () => {
		it('renders with header and title', () => {
			render(<AllSessionsView {...createDefaultProps()} />);

			expect(screen.getByRole('heading', { name: 'All Agents' })).toBeInTheDocument();
		});

		it('renders Done button to close view', () => {
			render(<AllSessionsView {...createDefaultProps()} />);

			const doneButton = screen.getByRole('button', { name: /close all agents view/i });
			expect(doneButton).toBeInTheDocument();
			expect(doneButton).toHaveTextContent('Done');
		});

		it('renders search input', () => {
			render(<AllSessionsView {...createDefaultProps()} />);

			expect(screen.getByPlaceholderText('Search agents...')).toBeInTheDocument();
		});

		it('renders search icon', () => {
			render(<AllSessionsView {...createDefaultProps()} />);

			expect(screen.getByText('🔍')).toBeInTheDocument();
		});

		it('renders session cards for all sessions', () => {
			const sessions = [
				createMockSession({ id: 'session-1', name: 'Session One' }),
				createMockSession({ id: 'session-2', name: 'Session Two' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			expect(screen.getByText('Session One')).toBeInTheDocument();
			expect(screen.getByText('Session Two')).toBeInTheDocument();
		});

		it('applies slideUp animation', () => {
			const { container } = render(<AllSessionsView {...createDefaultProps()} />);

			const mainDiv = container.firstChild as HTMLElement;
			expect(mainDiv.style.animation).toContain('slideUp');
		});
	});

	describe('MobileSessionCard', () => {
		describe('status mapping', () => {
			it('shows idle status as "Ready" with green color', () => {
				const sessions = [createMockSession({ state: 'idle' })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('Ready')).toBeInTheDocument();
			});

			it('shows busy status as "Thinking..." with yellow color', () => {
				const sessions = [createMockSession({ state: 'busy' })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('Thinking...')).toBeInTheDocument();
			});

			it('shows connecting status as "Connecting..." with orange color', () => {
				const sessions = [createMockSession({ state: 'connecting' })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('Connecting...')).toBeInTheDocument();
			});

			it('shows error status as "Error" with red color', () => {
				const sessions = [createMockSession({ state: 'error' })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('Error')).toBeInTheDocument();
			});

			it('shows unknown state as "Error"', () => {
				const sessions = [createMockSession({ state: 'unknown' as any })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('Error')).toBeInTheDocument();
			});
		});

		describe('tool type labels', () => {
			it('shows "Claude Code" for claude-code', () => {
				const sessions = [createMockSession({ toolType: 'claude-code' })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('Claude Code')).toBeInTheDocument();
			});

			it('shows "OpenAI Codex" for openai-codex', () => {
				const sessions = [createMockSession({ toolType: 'openai-codex' })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('OpenAI Codex')).toBeInTheDocument();
			});

			it('shows "Gemini CLI" for gemini-cli', () => {
				const sessions = [createMockSession({ toolType: 'gemini-cli' })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('Gemini CLI')).toBeInTheDocument();
			});

			it('shows "Qwen3 Coder" for qwen3-coder', () => {
				const sessions = [createMockSession({ toolType: 'qwen3-coder' })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('Qwen3 Coder')).toBeInTheDocument();
			});

			it('shows raw toolType for unknown types', () => {
				const sessions = [createMockSession({ toolType: 'custom-agent' as any })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('custom-agent')).toBeInTheDocument();
			});
		});

		describe('path truncation', () => {
			it('does not truncate short paths', () => {
				const sessions = [createMockSession({ cwd: '/short/path' })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('/short/path')).toBeInTheDocument();
			});

			it('truncates long paths with ellipsis', () => {
				const longPath = '/Users/developer/projects/very-long-project-name/src/components';
				const sessions = [createMockSession({ cwd: longPath })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				// Should show last two path components with ellipsis prefix
				expect(screen.getByText(/.+\/src\/components/)).toBeInTheDocument();
			});

			it('handles windows paths when truncating', () => {
				const windowsPath = 'C:\\Users\\dev\\project\\very-long-folder-name\\src\\components';
				const sessions = [createMockSession({ cwd: windowsPath })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('...\\src\\components')).toBeInTheDocument();
			});

			it('truncates paths with only two components properly', () => {
				const twoPartPath = 'a'.repeat(50); // Very long single-part path
				const sessions = [createMockSession({ cwd: twoPartPath })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				// Should have ellipsis for long paths
				const pathElement = screen.getByTitle(twoPartPath);
				expect(pathElement).toBeInTheDocument();
			});
		});

		describe('mode badge', () => {
			it('shows "AI" badge for ai mode', () => {
				const sessions = [createMockSession({ inputMode: 'ai' })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('AI')).toBeInTheDocument();
			});

			it('shows "Terminal" badge for terminal mode', () => {
				const sessions = [createMockSession({ inputMode: 'terminal' })];
				render(<AllSessionsView {...createDefaultProps({ sessions })} />);

				expect(screen.getByText('Terminal')).toBeInTheDocument();
			});
		});

		describe('active session styling', () => {
			it('applies active styling when session is active', () => {
				const sessions = [createMockSession({ id: 'session-1', name: 'Active Session' })];
				render(
					<AllSessionsView {...createDefaultProps({ sessions, activeSessionId: 'session-1' })} />
				);

				const sessionCard = screen.getByRole('button', { name: /Active Session.*active/i });
				expect(sessionCard).toHaveAttribute('aria-pressed', 'true');
			});

			it('does not apply active styling when session is not active', () => {
				const sessions = [createMockSession({ id: 'session-1', name: 'Inactive Session' })];
				render(
					<AllSessionsView {...createDefaultProps({ sessions, activeSessionId: 'session-2' })} />
				);

				const sessionCard = screen.getByRole('button', { name: /Inactive Session/i });
				expect(sessionCard).toHaveAttribute('aria-pressed', 'false');
			});
		});

		describe('session card interaction', () => {
			it('calls onSelectSession and onClose when card is clicked', async () => {
				const onSelectSession = vi.fn();
				const onClose = vi.fn();
				const sessions = [createMockSession({ id: 'session-1', name: 'Click Me' })];

				render(<AllSessionsView {...createDefaultProps({ sessions, onSelectSession, onClose })} />);

				const sessionCard = screen.getByRole('button', { name: /Click Me/i });
				fireEvent.click(sessionCard);

				expect(mockTriggerHaptic).toHaveBeenCalledWith([10]); // HAPTIC_PATTERNS.tap
				expect(onSelectSession).toHaveBeenCalledWith('session-1');
				expect(onClose).toHaveBeenCalled();
			});

			it('includes correct aria-label for accessibility', () => {
				const sessions = [
					createMockSession({
						id: 'session-1',
						name: 'Test Session',
						state: 'busy',
						inputMode: 'terminal',
					}),
				];

				render(
					<AllSessionsView {...createDefaultProps({ sessions, activeSessionId: 'session-1' })} />
				);

				const sessionCard = screen.getByRole('button', {
					name: /Test Session session, Thinking..., terminal mode, active/i,
				});
				expect(sessionCard).toBeInTheDocument();
			});
		});
	});

	describe('GroupSection', () => {
		const createGroupedSessions = () => [
			createMockSession({
				id: 's1',
				name: 'Session 1',
				groupId: 'group-1',
				groupName: 'Dev Group',
				groupEmoji: '🔧',
			}),
			createMockSession({
				id: 's2',
				name: 'Session 2',
				groupId: 'group-1',
				groupName: 'Dev Group',
				groupEmoji: '🔧',
			}),
			createMockSession({
				id: 's3',
				name: 'Session 3',
				groupId: 'group-2',
				groupName: 'Test Group',
				groupEmoji: '🧪',
			}),
		];

		it('renders group headers with names', async () => {
			const sessions = createGroupedSessions();
			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			// Wait for initial render to complete and groups to be set up
			await waitFor(() => {
				expect(screen.getByText('Dev Group')).toBeInTheDocument();
				expect(screen.getByText('Test Group')).toBeInTheDocument();
			});
		});

		it('renders group emoji when available', async () => {
			const sessions = createGroupedSessions();
			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				expect(screen.getByText('🔧')).toBeInTheDocument();
				expect(screen.getByText('🧪')).toBeInTheDocument();
			});
		});

		it('renders session count badge for each group', async () => {
			const sessions = createGroupedSessions();
			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				// Dev Group has 2 sessions
				const devGroupHeader = screen.getByRole('button', {
					name: /Dev Group group with 2 sessions/i,
				});
				expect(devGroupHeader).toBeInTheDocument();

				// Test Group has 1 session
				const testGroupHeader = screen.getByRole('button', {
					name: /Test Group group with 1 sessions/i,
				});
				expect(testGroupHeader).toBeInTheDocument();
			});
		});

		it('toggles group collapse on header click', async () => {
			const sessions = createGroupedSessions();
			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				expect(screen.getByText('Dev Group')).toBeInTheDocument();
			});

			// Groups start collapsed by default (except bookmarks)
			const devGroupHeader = screen.getByRole('button', { name: /Dev Group group/i });
			expect(devGroupHeader).toHaveAttribute('aria-expanded', 'false');

			// Click to expand
			fireEvent.click(devGroupHeader);

			expect(mockTriggerHaptic).toHaveBeenCalledWith([10]);
			expect(devGroupHeader).toHaveAttribute('aria-expanded', 'true');

			// Click again to collapse
			fireEvent.click(devGroupHeader);
			expect(devGroupHeader).toHaveAttribute('aria-expanded', 'false');
		});

		it('shows sessions when group is expanded', async () => {
			const sessions = createGroupedSessions();
			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				expect(screen.getByText('Dev Group')).toBeInTheDocument();
			});

			// Click to expand Dev Group
			const devGroupHeader = screen.getByRole('button', { name: /Dev Group group/i });
			fireEvent.click(devGroupHeader);

			// Sessions should now be visible
			expect(screen.getByText('Session 1')).toBeInTheDocument();
			expect(screen.getByText('Session 2')).toBeInTheDocument();
		});

		it('hides sessions when group is collapsed', async () => {
			const sessions = createGroupedSessions();
			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				expect(screen.getByText('Dev Group')).toBeInTheDocument();
			});

			// Groups start collapsed, so sessions should not be visible
			expect(screen.queryByText('Session 1')).not.toBeInTheDocument();
			expect(screen.queryByText('Session 2')).not.toBeInTheDocument();
		});
	});

	describe('ungrouped sessions', () => {
		it('renders ungrouped sessions without group header when only ungrouped exist', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Ungrouped 1' }),
				createMockSession({ id: 's2', name: 'Ungrouped 2' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			// Should show sessions without group header
			expect(screen.getByText('Ungrouped 1')).toBeInTheDocument();
			expect(screen.getByText('Ungrouped 2')).toBeInTheDocument();
			expect(screen.queryByText('Ungrouped')).not.toBeInTheDocument(); // No group header
		});

		it('renders ungrouped section when mixed with grouped sessions', async () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Grouped', groupId: 'g1', groupName: 'My Group' }),
				createMockSession({ id: 's2', name: 'Not Grouped' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				expect(screen.getByText('My Group')).toBeInTheDocument();
				expect(screen.getByText('Ungrouped')).toBeInTheDocument();
			});
		});
	});

	describe('bookmarked sessions', () => {
		it('creates a special Bookmarks group for bookmarked sessions', async () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Bookmarked Session', bookmarked: true }),
				createMockSession({ id: 's2', name: 'Regular Session', bookmarked: false }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				expect(screen.getByText('Bookmarks')).toBeInTheDocument();
				expect(screen.getByText('★')).toBeInTheDocument(); // Star emoji for bookmarks
			});
		});

		it('shows bookmarks group expanded by default', async () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Bookmarked Session', bookmarked: true }),
				createMockSession({ id: 's2', name: 'Regular Session' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				const bookmarksHeader = screen.getByRole('button', { name: /Bookmarks group/i });
				expect(bookmarksHeader).toHaveAttribute('aria-expanded', 'true');
			});
		});

		it('places bookmarks group first in the order', async () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Regular', groupId: 'a-group', groupName: 'A Group' }),
				createMockSession({ id: 's2', name: 'Bookmarked', bookmarked: true }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				const allButtons = screen.getAllByRole('button');
				const bookmarksIndex = allButtons.findIndex((b) => b.textContent?.includes('Bookmarks'));
				const aGroupIndex = allButtons.findIndex((b) => b.textContent?.includes('A Group'));

				expect(bookmarksIndex).toBeLessThan(aGroupIndex);
			});
		});
	});

	describe('search functionality', () => {
		it('filters sessions by name', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Frontend Project' }),
				createMockSession({ id: 's2', name: 'Backend API' }),
				createMockSession({ id: 's3', name: 'Database Setup' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			const searchInput = screen.getByPlaceholderText('Search agents...');
			fireEvent.change(searchInput, { target: { value: 'Frontend' } });

			expect(screen.getByText('Frontend Project')).toBeInTheDocument();
			expect(screen.queryByText('Backend API')).not.toBeInTheDocument();
			expect(screen.queryByText('Database Setup')).not.toBeInTheDocument();
		});

		it('filters sessions by working directory', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Session 1', cwd: '/home/user/project-a' }),
				createMockSession({ id: 's2', name: 'Session 2', cwd: '/home/user/project-b' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			const searchInput = screen.getByPlaceholderText('Search agents...');
			fireEvent.change(searchInput, { target: { value: 'project-a' } });

			expect(screen.getByText('Session 1')).toBeInTheDocument();
			expect(screen.queryByText('Session 2')).not.toBeInTheDocument();
		});

		it('filters sessions by tool type', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Claude Session', toolType: 'claude-code' }),
				createMockSession({ id: 's2', name: 'Gemini Session', toolType: 'gemini-cli' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			const searchInput = screen.getByPlaceholderText('Search agents...');
			fireEvent.change(searchInput, { target: { value: 'gemini' } });

			expect(screen.getByText('Gemini Session')).toBeInTheDocument();
			expect(screen.queryByText('Claude Session')).not.toBeInTheDocument();
		});

		it('search is case insensitive', () => {
			const sessions = [createMockSession({ id: 's1', name: 'My Project' })];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			const searchInput = screen.getByPlaceholderText('Search agents...');
			fireEvent.change(searchInput, { target: { value: 'MY PROJECT' } });

			expect(screen.getByText('My Project')).toBeInTheDocument();
		});

		it('shows clear button when search has value', () => {
			const sessions = [createMockSession()];
			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			const searchInput = screen.getByPlaceholderText('Search agents...');

			// Initially no clear button
			expect(screen.queryByRole('button', { name: /clear search/i })).not.toBeInTheDocument();

			fireEvent.change(searchInput, { target: { value: 'test' } });

			// Clear button should appear
			expect(screen.getByRole('button', { name: /clear search/i })).toBeInTheDocument();
		});

		it('clears search when clear button is clicked', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Session One' }),
				createMockSession({ id: 's2', name: 'Session Two' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			const searchInput = screen.getByPlaceholderText('Search agents...');
			fireEvent.change(searchInput, { target: { value: 'One' } });

			expect(screen.queryByText('Session Two')).not.toBeInTheDocument();

			const clearButton = screen.getByRole('button', { name: /clear search/i });
			fireEvent.click(clearButton);

			expect(screen.getByText('Session One')).toBeInTheDocument();
			expect(screen.getByText('Session Two')).toBeInTheDocument();
			expect(searchInput).toHaveValue('');
		});

		it('uses initial searchQuery prop', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Frontend' }),
				createMockSession({ id: 's2', name: 'Backend' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions, searchQuery: 'Frontend' })} />);

			expect(screen.getByPlaceholderText('Search agents...')).toHaveValue('Frontend');
			expect(screen.getByText('Frontend')).toBeInTheDocument();
			expect(screen.queryByText('Backend')).not.toBeInTheDocument();
		});

		it('trims whitespace from search query', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Session' })];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			const searchInput = screen.getByPlaceholderText('Search agents...');
			fireEvent.change(searchInput, { target: { value: '   ' } });

			// Should show all sessions when search is only whitespace
			expect(screen.getByText('Session')).toBeInTheDocument();
		});
	});

	describe('empty states', () => {
		it('shows empty state when no sessions exist', () => {
			render(<AllSessionsView {...createDefaultProps({ sessions: [] })} />);

			expect(screen.getByText('No sessions available')).toBeInTheDocument();
			expect(
				screen.getByText('Create a session in the desktop app to get started')
			).toBeInTheDocument();
		});

		it('shows empty state when search has no results', () => {
			const sessions = [createMockSession({ id: 's1', name: 'Frontend Project' })];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			const searchInput = screen.getByPlaceholderText('Search agents...');
			fireEvent.change(searchInput, { target: { value: 'xyz' } });

			expect(screen.getByText('No sessions found')).toBeInTheDocument();
			expect(screen.getByText('No sessions match "xyz"')).toBeInTheDocument();
		});
	});

	describe('close functionality', () => {
		it('calls onClose when Done button is clicked', () => {
			const onClose = vi.fn();
			render(<AllSessionsView {...createDefaultProps({ onClose })} />);

			const doneButton = screen.getByRole('button', { name: /close all agents view/i });
			fireEvent.click(doneButton);

			expect(mockTriggerHaptic).toHaveBeenCalledWith([10]);
			expect(onClose).toHaveBeenCalled();
		});

		it('calls onClose when Escape key is pressed', () => {
			const onClose = vi.fn();
			render(<AllSessionsView {...createDefaultProps({ onClose })} />);

			fireEvent.keyDown(document, { key: 'Escape' });

			expect(onClose).toHaveBeenCalled();
		});

		it('does not call onClose for other keys', () => {
			const onClose = vi.fn();
			render(<AllSessionsView {...createDefaultProps({ onClose })} />);

			fireEvent.keyDown(document, { key: 'Enter' });
			fireEvent.keyDown(document, { key: 'a' });

			expect(onClose).not.toHaveBeenCalled();
		});

		it('cleans up Escape key listener on unmount', () => {
			const onClose = vi.fn();
			const { unmount } = render(<AllSessionsView {...createDefaultProps({ onClose })} />);

			unmount();

			// After unmount, pressing Escape should not call onClose
			fireEvent.keyDown(document, { key: 'Escape' });
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('group sorting', () => {
		it('sorts groups alphabetically', async () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'S1', groupId: 'zebra', groupName: 'Zebra Group' }),
				createMockSession({ id: 's2', name: 'S2', groupId: 'alpha', groupName: 'Alpha Group' }),
				createMockSession({ id: 's3', name: 'S3', groupId: 'beta', groupName: 'Beta Group' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				const allButtons = screen.getAllByRole('button');
				const alphaIndex = allButtons.findIndex((b) => b.textContent?.includes('Alpha Group'));
				const betaIndex = allButtons.findIndex((b) => b.textContent?.includes('Beta Group'));
				const zebraIndex = allButtons.findIndex((b) => b.textContent?.includes('Zebra Group'));

				expect(alphaIndex).toBeLessThan(betaIndex);
				expect(betaIndex).toBeLessThan(zebraIndex);
			});
		});

		it('puts ungrouped sessions last', async () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Ungrouped', groupId: null }),
				createMockSession({ id: 's2', name: 'Grouped', groupId: 'z-group', groupName: 'Z Group' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				const allButtons = screen.getAllByRole('button');
				const zGroupIndex = allButtons.findIndex((b) => b.textContent?.includes('Z Group'));
				const ungroupedIndex = allButtons.findIndex((b) => b.textContent?.includes('Ungrouped'));

				// The "Ungrouped" group header should be after "Z Group"
				expect(ungroupedIndex).toBeGreaterThan(zGroupIndex);
			});
		});
	});

	describe('edge cases', () => {
		it('handles sessions with special characters in name', () => {
			const sessions = [createMockSession({ id: 's1', name: '<script>alert("xss")</script>' })];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			// Should render the text safely without executing script
			expect(screen.getByText('<script>alert("xss")</script>')).toBeInTheDocument();
		});

		it('handles sessions with unicode in name', () => {
			const sessions = [createMockSession({ id: 's1', name: '日本語セッション 🎯' })];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			expect(screen.getByText('日本語セッション 🎯')).toBeInTheDocument();
		});

		it('handles sessions with very long names', () => {
			const longName = 'A'.repeat(200);
			const sessions = [createMockSession({ id: 's1', name: longName })];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			// Should render (text-overflow: ellipsis handles display)
			expect(screen.getByText(longName)).toBeInTheDocument();
		});

		it('handles null activeSessionId', () => {
			const sessions = [createMockSession({ id: 's1' })];

			render(<AllSessionsView {...createDefaultProps({ sessions, activeSessionId: null })} />);

			const sessionCard = screen.getByRole('button', { name: /Test Session/i });
			expect(sessionCard).toHaveAttribute('aria-pressed', 'false');
		});

		it('handles rapid toggle of groups', async () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Session', groupId: 'g1', groupName: 'Group' }),
				createMockSession({ id: 's2', name: 'Session 2' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				expect(screen.getByText('Group')).toBeInTheDocument();
			});

			const groupHeader = screen.getByRole('button', { name: /Group group/i });

			// Rapid toggles
			for (let i = 0; i < 10; i++) {
				fireEvent.click(groupHeader);
			}

			// Should still work after rapid toggles (10 clicks = even number = back to original state)
			expect(groupHeader).toHaveAttribute('aria-expanded', 'false');
		});

		it('handles bookmarked session that is also in a group', async () => {
			const sessions = [
				createMockSession({
					id: 's1',
					name: 'Bookmarked Grouped',
					bookmarked: true,
					groupId: 'g1',
					groupName: 'My Group',
				}),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				// Should appear in both Bookmarks and the original group
				expect(screen.getByText('Bookmarks')).toBeInTheDocument();
				expect(screen.getByText('My Group')).toBeInTheDocument();
			});
		});

		it('handles session with undefined toolType gracefully', () => {
			const sessions = [createMockSession({ toolType: undefined as any })];

			// Should not throw
			expect(() => render(<AllSessionsView {...createDefaultProps({ sessions })} />)).not.toThrow();
		});
	});

	describe('accessibility', () => {
		it('has proper heading hierarchy', () => {
			render(<AllSessionsView {...createDefaultProps()} />);

			expect(screen.getByRole('heading', { level: 1, name: 'All Agents' })).toBeInTheDocument();
		});

		it('session cards have proper aria-pressed state', () => {
			const sessions = [
				createMockSession({ id: 's1', name: 'Active' }),
				createMockSession({ id: 's2', name: 'Inactive' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions, activeSessionId: 's1' })} />);

			// Only ungrouped sessions rendered without group headers
			expect(screen.getByRole('button', { name: /Active.*active/i })).toHaveAttribute(
				'aria-pressed',
				'true'
			);
			expect(screen.getByRole('button', { name: /Inactive session/i })).toHaveAttribute(
				'aria-pressed',
				'false'
			);
		});

		it('group headers have aria-expanded state', async () => {
			const sessions = [createMockSession({ id: 's1', groupId: 'g1', groupName: 'Test Group' })];

			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			await waitFor(() => {
				const groupHeader = screen.getByRole('button', { name: /Test Group group/i });
				expect(groupHeader).toHaveAttribute('aria-expanded');
			});
		});

		it('search input is accessible', () => {
			render(<AllSessionsView {...createDefaultProps()} />);

			const searchInput = screen.getByPlaceholderText('Search agents...');
			expect(searchInput).toHaveAttribute('type', 'text');
		});

		it('clear search button has accessible label', () => {
			const sessions = [createMockSession()];
			render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			const searchInput = screen.getByPlaceholderText('Search agents...');
			fireEvent.change(searchInput, { target: { value: 'test' } });

			expect(screen.getByRole('button', { name: /clear search/i })).toBeInTheDocument();
		});
	});

	describe('styling', () => {
		it('applies fixed positioning for full-screen overlay', () => {
			const { container } = render(<AllSessionsView {...createDefaultProps()} />);

			const mainDiv = container.firstChild as HTMLElement;
			expect(mainDiv.style.position).toBe('fixed');
			expect(mainDiv.style.top).toBe('0px');
			expect(mainDiv.style.left).toBe('0px');
			expect(mainDiv.style.right).toBe('0px');
			expect(mainDiv.style.bottom).toBe('0px');
		});

		it('has high z-index to cover other elements', () => {
			const { container } = render(<AllSessionsView {...createDefaultProps()} />);

			const mainDiv = container.firstChild as HTMLElement;
			expect(mainDiv.style.zIndex).toBe('200');
		});

		it('includes CSS animation keyframes', () => {
			const { container } = render(<AllSessionsView {...createDefaultProps()} />);

			const styleElement = container.querySelector('style');
			expect(styleElement?.textContent).toContain('@keyframes slideUp');
		});
	});

	describe('integration scenarios', () => {
		it('complete user flow: search, auto-expand group, select session', async () => {
			const onSelectSession = vi.fn();
			const onClose = vi.fn();
			const sessions = [
				createMockSession({ id: 's1', name: 'Frontend', groupId: 'dev', groupName: 'Dev' }),
				createMockSession({ id: 's2', name: 'Backend', groupId: 'dev', groupName: 'Dev' }),
				createMockSession({ id: 's3', name: 'Database' }),
			];

			render(<AllSessionsView {...createDefaultProps({ sessions, onSelectSession, onClose })} />);

			// 1. Search for "end"
			const searchInput = screen.getByPlaceholderText('Search agents...');
			fireEvent.change(searchInput, { target: { value: 'end' } });

			// 2. Wait for search results and auto-expand to complete
			// Groups with matching sessions should auto-expand when searching
			await waitFor(() => {
				// Only Frontend and Backend should match
				expect(screen.getByText('Dev')).toBeInTheDocument();
				expect(screen.queryByText('Database')).not.toBeInTheDocument();
				// Sessions should be visible due to auto-expand
				expect(screen.getByText('Frontend')).toBeInTheDocument();
				expect(screen.getByText('Backend')).toBeInTheDocument();
			});

			// 3. Select Backend
			const backendCard = screen.getByRole('button', { name: /Backend session/i });
			fireEvent.click(backendCard);

			expect(onSelectSession).toHaveBeenCalledWith('s2');
			expect(onClose).toHaveBeenCalled();
		});

		it('handles session state changes during view', async () => {
			const sessions = [createMockSession({ id: 's1', state: 'idle' })];

			const { rerender } = render(<AllSessionsView {...createDefaultProps({ sessions })} />);

			expect(screen.getByText('Ready')).toBeInTheDocument();

			// Rerender with updated state
			const updatedSessions = [createMockSession({ id: 's1', state: 'busy' })];
			rerender(<AllSessionsView {...createDefaultProps({ sessions: updatedSessions })} />);

			expect(screen.getByText('Thinking...')).toBeInTheDocument();
		});

		it('handles dynamic session additions', async () => {
			const initialSessions = [createMockSession({ id: 's1', name: 'Session 1' })];

			const { rerender } = render(
				<AllSessionsView {...createDefaultProps({ sessions: initialSessions })} />
			);

			expect(screen.getByText('Session 1')).toBeInTheDocument();
			expect(screen.queryByText('Session 2')).not.toBeInTheDocument();

			// Add new session
			const updatedSessions = [
				...initialSessions,
				createMockSession({ id: 's2', name: 'Session 2' }),
			];
			rerender(<AllSessionsView {...createDefaultProps({ sessions: updatedSessions })} />);

			expect(screen.getByText('Session 1')).toBeInTheDocument();
			expect(screen.getByText('Session 2')).toBeInTheDocument();
		});
	});
});

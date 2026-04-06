/**
 * @file RenameSessionModal.test.tsx
 * @description Tests for the RenameSessionModal component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { RenameSessionModal } from '../../../renderer/components/RenameSessionModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Theme, Session } from '../../../renderer/types';
import { mockTheme, createMockTheme } from '../../helpers/mockTheme';

// Mock the window.maestro API
vi.mock('../../../renderer/services/process', () => ({}));
// Create mock sessions
const createMockSessions = (): Session[] => [
	{
		id: 'session-1',
		name: 'Session 1',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/home/user/project',
		projectRoot: '/home/user/project',
		aiPid: 1234,
		terminalPid: 5678,
		aiLogs: [],
		shellLogs: [],
		messageQueue: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		agentSessionId: 'claude-123',
		terminalTabs: [],
		activeTerminalTabId: null,
	},
	{
		id: 'session-2',
		name: 'Session 2',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		cwd: '/home/user/other',
		projectRoot: '/home/user/other',
		aiPid: 2345,
		terminalPid: 6789,
		aiLogs: [],
		shellLogs: [],
		messageQueue: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		terminalTabs: [],
		activeTerminalTabId: null,
	},
];

// Wrapper component to provide LayerStackContext
const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

describe('RenameSessionModal', () => {
	let mockOnClose: ReturnType<typeof vi.fn>;
	let mockSetValue: ReturnType<typeof vi.fn>;
	let mockSetSessions: ReturnType<typeof vi.fn>;
	let mockSessions: Session[];
	let setStateSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		mockOnClose = vi.fn();
		mockSetValue = vi.fn();
		mockSetSessions = vi.fn((updater) => {
			if (typeof updater === 'function') {
				return updater(mockSessions);
			}
			return updater;
		});
		mockSessions = createMockSessions();
		setStateSpy = vi.spyOn(useSessionStore, 'setState');

		// Initialize session store so updateSessionWith finds the sessions
		useSessionStore.setState({ sessions: mockSessions });

		// Setup window.maestro mock overrides on the centralized mock from setup.ts
		Object.assign(window.maestro.claude, {
			updateSessionName: vi.fn().mockResolvedValue(undefined),
		});
		Object.assign(window.maestro.agentSessions, {
			setSessionName: vi.fn().mockResolvedValue(undefined),
			updateSessionName: vi.fn().mockResolvedValue(undefined),
		});
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	describe('Basic Rendering', () => {
		it('renders the modal with title', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="Session 1"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			expect(screen.getByText('Rename Agent')).toBeInTheDocument();
		});

		it('renders input with current value', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="My Session"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			expect(input).toHaveValue('My Session');
		});

		it('renders Cancel button', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="Session 1"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			expect(screen.getByText('Cancel')).toBeInTheDocument();
		});

		it('renders Rename button', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="Session 1"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			expect(screen.getByText('Rename')).toBeInTheDocument();
		});

		it('has proper dialog accessibility attributes', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="Session 1"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
			expect(dialog).toHaveAttribute('aria-label', 'Rename Agent');
		});

		it('shows placeholder text', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value=""
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			expect(input).toHaveAttribute('placeholder', 'Enter agent name...');
		});
	});

	describe('Button Actions', () => {
		it('calls onClose when Cancel button is clicked', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="Session 1"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			expect(mockOnClose).toHaveBeenCalledTimes(1);
			expect(mockSetSessions).not.toHaveBeenCalled();
		});

		it('calls setSessions and onClose when Rename button is clicked with valid value', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="New Name"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

			const viaProp = mockSetSessions.mock.calls.length > 0;
			const viaStore = setStateSpy.mock.calls.length > 0;
			expect(viaProp || viaStore).toBe(true);
			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it('does not rename when value is empty', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value=""
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

			expect(mockSetSessions).not.toHaveBeenCalled();
			expect(mockOnClose).not.toHaveBeenCalled();
		});

		it('does not rename when value is only whitespace', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="   "
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

			expect(mockSetSessions).not.toHaveBeenCalled();
			expect(mockOnClose).not.toHaveBeenCalled();
		});

		it('calls onClose when X button is clicked', () => {
			const { container } = render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="Session 1"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			// Find the X button (close button in header)
			const closeIcon = screen.getAllByTestId('x-icon')[0];
			const closeButton = closeIcon.closest('button');
			expect(closeButton).toBeTruthy();
			fireEvent.click(closeButton!);

			expect(mockOnClose).toHaveBeenCalledTimes(1);
			expect(mockSetSessions).not.toHaveBeenCalled();
		});
	});

	describe('Input Handling', () => {
		it('calls setValue when typing', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value=""
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			fireEvent.change(input, { target: { value: 'New Name' } });

			expect(mockSetValue).toHaveBeenCalledWith('New Name');
		});

		it('submits on Enter key with valid value', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="New Name"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			fireEvent.keyDown(input, { key: 'Enter' });

			const viaProp = mockSetSessions.mock.calls.length > 0;
			const viaStore = setStateSpy.mock.calls.length > 0;
			expect(viaProp || viaStore).toBe(true);
			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});

		it('does not submit on Enter with empty value', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value=""
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(mockSetSessions).not.toHaveBeenCalled();
			expect(mockOnClose).not.toHaveBeenCalled();
		});
	});

	describe('Rename Button State', () => {
		it('Rename button is disabled when value is empty', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value=""
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const renameButton = screen.getByText('Rename');
			expect(renameButton).toBeDisabled();
		});

		it('Rename button is disabled when value is whitespace only', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="   "
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const renameButton = screen.getByText('Rename');
			expect(renameButton).toBeDisabled();
		});

		it('Rename button is enabled when value has content', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="New Name"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const renameButton = screen.getByText('Rename');
			expect(renameButton).not.toBeDisabled();
		});
	});

	describe('Session Update', () => {
		it('uses activeSessionId when targetSessionId is not provided', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="New Name"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

			// Verify the store was updated with the correct session name
			const storeSessions = useSessionStore.getState().sessions;
			expect(storeSessions[0].name).toBe('New Name');
			expect(storeSessions[1].name).toBe('Session 2'); // Unchanged
		});

		it('uses targetSessionId when provided', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="New Name"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
						targetSessionId="session-2"
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

			// Verify the store was updated - session-2 renamed, session-1 unchanged
			const storeSessions = useSessionStore.getState().sessions;
			expect(storeSessions[0].name).toBe('Session 1'); // Unchanged
			expect(storeSessions[1].name).toBe('New Name');
		});

		it('trims whitespace from the name', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="  Padded Name  "
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

			// Verify the store has the trimmed name
			const storeSessions = useSessionStore.getState().sessions;
			expect(storeSessions[0].name).toBe('Padded Name');
		});
	});

	describe('Agent Session Name Update', () => {
		it('updates agent session name when session has agentSessionId and projectRoot (claude-code)', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="New Name"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

			// For claude-code sessions, it uses window.maestro.claude.updateSessionName
			expect((window as any).maestro.claude.updateSessionName).toHaveBeenCalledWith(
				'/home/user/project',
				'claude-123',
				'New Name'
			);
		});

		it('does not update agent session name when session has no agentSessionId', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="New Name"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-2"
					/>
				</TestWrapper>
			);

			fireEvent.click(screen.getByRole('button', { name: 'Rename' }));

			expect((window as any).maestro.claude.updateSessionName).not.toHaveBeenCalled();
			expect((window as any).maestro.agentSessions.setSessionName).not.toHaveBeenCalled();
		});
	});

	describe('Auto Focus', () => {
		it('input receives focus on mount', async () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="Session 1"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const input = screen.getByRole('textbox');

			await waitFor(() => {
				expect(document.activeElement).toBe(input);
			});
		});
	});

	describe('Theme Styling', () => {
		it('applies theme colors to modal container', () => {
			const { container } = render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="Session 1"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			// The Modal component now uses inline width style instead of Tailwind class
			const modalBox = container.querySelector('.border.rounded-lg');
			expect(modalBox).toHaveStyle({
				backgroundColor: mockTheme.colors.bgSidebar,
				borderColor: mockTheme.colors.border,
			});
		});

		it('applies accent color to Rename button', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="Session 1"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const renameButton = screen.getByText('Rename');
			expect(renameButton).toHaveStyle({
				backgroundColor: mockTheme.colors.accent,
				color: mockTheme.colors.accentForeground,
			});
		});

		it('applies theme colors to title', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="Session 1"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const title = screen.getByText('Rename Agent');
			expect(title).toHaveStyle({
				color: mockTheme.colors.textMain,
			});
		});
	});

	describe('Modal Layout', () => {
		it('has fixed positioning with backdrop', () => {
			render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="Session 1"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveClass('fixed', 'inset-0');
		});

		it('has proper width style', () => {
			const { container } = render(
				<TestWrapper>
					<RenameSessionModal
						theme={mockTheme}
						value="Session 1"
						setValue={mockSetValue}
						onClose={mockOnClose}
						sessions={mockSessions}
						setSessions={mockSetSessions}
						activeSessionId="session-1"
					/>
				</TestWrapper>
			);

			// The Modal component now uses inline width style instead of Tailwind class
			const modalBox = container.querySelector('.border.rounded-lg');
			expect(modalBox).toBeInTheDocument();
			expect(modalBox).toHaveStyle({ width: '400px' });
		});
	});
});

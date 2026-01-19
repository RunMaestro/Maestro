/**
 * @file RenameSessionModal.test.tsx
 * @description Tests for the RenameSessionModal component
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { RenameSessionModal } from '../../../renderer/components/RenameSessionModal';
import { LayerStackProvider } from '../../../renderer/contexts/LayerStackContext';
import type { Theme, Session } from '../../../renderer/types';

// Mock the window.maestro API
vi.mock('../../../renderer/services/process', () => ({}));

// Create a mock theme for testing
const createMockTheme = (): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgSidebar: '#202020',
		bgActivity: '#2d2d2d',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentForeground: '#ffffff',
		border: '#333333',
		highlight: '#0066ff33',
		success: '#00aa00',
		warning: '#ffaa00',
		error: '#ff0000',
	},
});

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
	},
];

// Wrapper component to provide LayerStackContext
const TestWrapper: React.FC<{ children: React.ReactNode }> = ({ children }) => (
	<LayerStackProvider>{children}</LayerStackProvider>
);

describe('RenameSessionModal', () => {
	const mockTheme = createMockTheme();
	let mockOnClose: ReturnType<typeof vi.fn>;
	let mockSetValue: ReturnType<typeof vi.fn>;
	let mockSetSessions: ReturnType<typeof vi.fn>;
	let mockSessions: Session[];

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

		// Setup window.maestro mock
		(window as unknown as { maestro: Record<string, unknown> }).maestro = {
			claude: {
				updateSessionName: vi.fn().mockResolvedValue(undefined),
			},
			agentSessions: {
				setSessionName: vi.fn().mockResolvedValue(undefined),
				updateSessionName: vi.fn().mockResolvedValue(undefined),
			},
		};
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

			expect(mockSetSessions).toHaveBeenCalled();
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

			expect(mockSetSessions).toHaveBeenCalled();
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

			expect(mockSetSessions).toHaveBeenCalled();
			// The updater function should be called with the active session ID
			const updaterFn = mockSetSessions.mock.calls[0][0];
			const result = updaterFn(mockSessions);
			expect(result[0].name).toBe('New Name');
			expect(result[1].name).toBe('Session 2'); // Unchanged
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

			expect(mockSetSessions).toHaveBeenCalled();
			const updaterFn = mockSetSessions.mock.calls[0][0];
			const result = updaterFn(mockSessions);
			expect(result[0].name).toBe('Session 1'); // Unchanged
			expect(result[1].name).toBe('New Name');
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

			const updaterFn = mockSetSessions.mock.calls[0][0];
			const result = updaterFn(mockSessions);
			expect(result[0].name).toBe('Padded Name');
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

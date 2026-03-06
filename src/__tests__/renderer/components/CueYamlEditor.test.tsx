/**
 * Tests for CueYamlEditor component
 *
 * Tests the Cue YAML editor including:
 * - Loading existing YAML content on mount
 * - YAML template shown when no file exists
 * - Real-time validation with error display
 * - AI assist chat with agent spawn and conversation resume
 * - Save/Exit functionality with dirty state
 * - Line numbers gutter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { CueYamlEditor } from '../../../renderer/components/CueYamlEditor';
import type { Theme } from '../../../renderer/types';

// Mock the Modal component
vi.mock('../../../renderer/components/ui/Modal', () => ({
	Modal: ({
		children,
		footer,
		title,
		testId,
		onClose,
	}: {
		children: React.ReactNode;
		footer?: React.ReactNode;
		title: string;
		testId?: string;
		onClose: () => void;
	}) => (
		<div data-testid={testId} role="dialog" aria-label={title}>
			<div data-testid="modal-content">{children}</div>
			{footer && <div data-testid="modal-footer">{footer}</div>}
		</div>
	),
	ModalFooter: ({
		onCancel,
		onConfirm,
		confirmLabel,
		cancelLabel = 'Cancel',
		confirmDisabled,
	}: {
		onCancel: () => void;
		onConfirm: () => void;
		confirmLabel: string;
		cancelLabel?: string;
		confirmDisabled: boolean;
		theme: Theme;
	}) => (
		<>
			<button onClick={onCancel}>{cancelLabel}</button>
			<button onClick={onConfirm} disabled={confirmDisabled}>
				{confirmLabel}
			</button>
		</>
	),
}));

// Mock modal priorities
vi.mock('../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: {
		CUE_YAML_EDITOR: 463,
	},
}));

// Mock sessionStore
const mockSession = {
	id: 'sess-1',
	toolType: 'claude-code',
	cwd: '/test/project',
	customPath: undefined,
	customArgs: undefined,
	customEnvVars: undefined,
	customModel: undefined,
	customContextWindow: undefined,
	sessionSshRemoteConfig: undefined,
};

vi.mock('../../../renderer/stores/sessionStore', () => ({
	useSessionStore: vi.fn((selector: (s: any) => any) => selector({ sessions: [mockSession] })),
	selectSessionById: (id: string) => (state: any) => state.sessions.find((s: any) => s.id === id),
}));

// Mock buildSpawnConfigForAgent
const mockBuildSpawnConfig = vi.fn();
vi.mock('../../../renderer/utils/sessionHelpers', () => ({
	buildSpawnConfigForAgent: (...args: any[]) => mockBuildSpawnConfig(...args),
}));

// Mock IPC methods
const mockReadYaml = vi.fn();
const mockWriteYaml = vi.fn();
const mockValidateYaml = vi.fn();
const mockRefreshSession = vi.fn();
const mockSpawn = vi.fn();
const mockOnData = vi.fn();
const mockOnExit = vi.fn();
const mockOnSessionId = vi.fn();
const mockOnAgentError = vi.fn();

const existingWindowMaestro = (window as any).maestro;

beforeEach(() => {
	vi.clearAllMocks();

	(window as any).maestro = {
		...existingWindowMaestro,
		cue: {
			...existingWindowMaestro?.cue,
			readYaml: mockReadYaml,
			writeYaml: mockWriteYaml,
			validateYaml: mockValidateYaml,
			refreshSession: mockRefreshSession,
		},
		process: {
			...existingWindowMaestro?.process,
			spawn: mockSpawn,
			onData: mockOnData,
			onExit: mockOnExit,
			onSessionId: mockOnSessionId,
			onAgentError: mockOnAgentError,
		},
	};

	// Default: file doesn't exist, YAML is valid
	mockReadYaml.mockResolvedValue(null);
	mockWriteYaml.mockResolvedValue(undefined);
	mockValidateYaml.mockResolvedValue({ valid: true, errors: [] });
	mockRefreshSession.mockResolvedValue(undefined);
	mockSpawn.mockResolvedValue({ pid: 123, success: true });
	mockBuildSpawnConfig.mockResolvedValue({
		sessionId: 'sess-1-cue-assist-123',
		toolType: 'claude-code',
		cwd: '/test/project',
		command: 'claude',
		args: [],
		prompt: 'test prompt',
	});

	// Default: listeners return cleanup functions
	mockOnData.mockReturnValue(vi.fn());
	mockOnExit.mockReturnValue(vi.fn());
	mockOnSessionId.mockReturnValue(vi.fn());
	mockOnAgentError.mockReturnValue(vi.fn());
});

afterEach(() => {
	vi.restoreAllMocks();
	(window as any).maestro = existingWindowMaestro;
});

const mockTheme: Theme = {
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
		scrollbar: '#44475a',
		scrollbarHover: '#6272a4',
	},
};

const defaultProps = {
	isOpen: true,
	onClose: vi.fn(),
	projectRoot: '/test/project',
	sessionId: 'sess-1',
	theme: mockTheme,
};

describe('CueYamlEditor', () => {
	describe('rendering', () => {
		it('should not render when isOpen is false', () => {
			render(<CueYamlEditor {...defaultProps} isOpen={false} />);
			expect(screen.queryByTestId('cue-yaml-editor')).not.toBeInTheDocument();
		});

		it('should render when isOpen is true', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('cue-yaml-editor')).toBeInTheDocument();
			});
		});

		it('should show loading state initially', () => {
			mockReadYaml.mockReturnValue(new Promise(() => {}));
			render(<CueYamlEditor {...defaultProps} />);

			expect(screen.getByText('Loading YAML...')).toBeInTheDocument();
		});

		it('should render AI assist chat section', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('AI Assist')).toBeInTheDocument();
			});
			expect(screen.getByTestId('ai-chat-input')).toBeInTheDocument();
			expect(screen.getByTestId('ai-chat-send')).toBeInTheDocument();
			expect(screen.getByTestId('ai-chat-history')).toBeInTheDocument();
		});

		it('should render YAML editor section', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('YAML Configuration')).toBeInTheDocument();
			});
			expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();
		});

		it('should render line numbers gutter', async () => {
			mockReadYaml.mockResolvedValue('line1\nline2\nline3');

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('line-numbers')).toBeInTheDocument();
			});
			expect(screen.getByTestId('line-numbers').textContent).toContain('1');
			expect(screen.getByTestId('line-numbers').textContent).toContain('2');
			expect(screen.getByTestId('line-numbers').textContent).toContain('3');
		});
	});

	describe('YAML loading', () => {
		it('should load existing YAML from projectRoot on mount', async () => {
			const existingYaml = 'subscriptions:\n  - name: "test"\n    event: time.interval';
			mockReadYaml.mockResolvedValue(existingYaml);

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(mockReadYaml).toHaveBeenCalledWith('/test/project');
			});
			expect(screen.getByTestId('yaml-editor')).toHaveValue(existingYaml);
		});

		it('should show template when no YAML file exists', async () => {
			mockReadYaml.mockResolvedValue(null);

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				const editor = screen.getByTestId('yaml-editor') as HTMLTextAreaElement;
				expect(editor.value).toContain('# maestro-cue.yaml');
			});
		});

		it('should show template when readYaml throws', async () => {
			mockReadYaml.mockRejectedValue(new Error('File read error'));

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				const editor = screen.getByTestId('yaml-editor') as HTMLTextAreaElement;
				expect(editor.value).toContain('# maestro-cue.yaml');
			});
		});
	});

	describe('validation', () => {
		it('should show valid indicator when YAML is valid', async () => {
			mockReadYaml.mockResolvedValue('subscriptions: []');
			mockValidateYaml.mockResolvedValue({ valid: true, errors: [] });

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('Valid YAML')).toBeInTheDocument();
			});
		});

		it('should show validation errors when YAML is invalid', async () => {
			mockReadYaml.mockResolvedValue('subscriptions: []');

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();
			});

			mockValidateYaml.mockResolvedValue({
				valid: false,
				errors: ['Missing required field: name'],
			});

			fireEvent.change(screen.getByTestId('yaml-editor'), {
				target: { value: 'invalid: yaml: content' },
			});

			await waitFor(
				() => {
					expect(screen.getByTestId('validation-errors')).toBeInTheDocument();
				},
				{ timeout: 2000 }
			);

			expect(screen.getByText('Missing required field: name')).toBeInTheDocument();
			expect(screen.getByText('1 error')).toBeInTheDocument();
		});

		it('should show plural error count for multiple errors', async () => {
			mockReadYaml.mockResolvedValue('subscriptions: []');

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();
			});

			mockValidateYaml.mockResolvedValue({
				valid: false,
				errors: ['Error one', 'Error two'],
			});

			fireEvent.change(screen.getByTestId('yaml-editor'), {
				target: { value: 'bad' },
			});

			await waitFor(
				() => {
					expect(screen.getByText('2 errors')).toBeInTheDocument();
				},
				{ timeout: 2000 }
			);
		});

		it('should debounce validation calls', async () => {
			vi.useFakeTimers();
			mockReadYaml.mockResolvedValue('initial');

			render(<CueYamlEditor {...defaultProps} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			const editor = screen.getByTestId('yaml-editor');
			fireEvent.change(editor, { target: { value: 'change1' } });
			fireEvent.change(editor, { target: { value: 'change2' } });
			fireEvent.change(editor, { target: { value: 'change3' } });

			const callsBeforeDebounce = mockValidateYaml.mock.calls.length;

			await act(async () => {
				vi.advanceTimersByTime(600);
			});

			expect(mockValidateYaml.mock.calls.length).toBe(callsBeforeDebounce + 1);
			expect(mockValidateYaml).toHaveBeenLastCalledWith('change3');

			vi.useRealTimers();
		});
	});

	describe('AI assist chat', () => {
		it('should have disabled send button when input is empty', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-chat-send')).toBeInTheDocument();
			});

			expect(screen.getByTestId('ai-chat-send')).toBeDisabled();
		});

		it('should enable send button when input has text', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-chat-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-chat-input'), {
				target: { value: 'Watch for file changes' },
			});

			expect(screen.getByTestId('ai-chat-send')).not.toBeDisabled();
		});

		it('should add user message to chat history on send', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-chat-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-chat-input'), {
				target: { value: 'Set up file watching' },
			});

			fireEvent.click(screen.getByTestId('ai-chat-send'));

			await waitFor(() => {
				expect(screen.getByTestId('chat-message-user')).toBeInTheDocument();
			});
			expect(screen.getByText('Set up file watching')).toBeInTheDocument();
		});

		it('should show busy indicator while agent is working', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-chat-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-chat-input'), {
				target: { value: 'Set up file watching' },
			});

			fireEvent.click(screen.getByTestId('ai-chat-send'));

			await waitFor(() => {
				expect(screen.getByTestId('chat-busy-indicator')).toBeInTheDocument();
			});
			expect(screen.getByText('Agent is working...')).toBeInTheDocument();
		});

		it('should clear input after sending', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-chat-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-chat-input'), {
				target: { value: 'Set up file watching' },
			});

			fireEvent.click(screen.getByTestId('ai-chat-send'));

			await waitFor(() => {
				expect((screen.getByTestId('ai-chat-input') as HTMLTextAreaElement).value).toBe('');
			});
		});

		it('should include system prompt on first message', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-chat-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-chat-input'), {
				target: { value: 'Run code review' },
			});

			fireEvent.click(screen.getByTestId('ai-chat-send'));

			await waitFor(() => {
				expect(mockBuildSpawnConfig).toHaveBeenCalledWith(
					expect.objectContaining({
						prompt: expect.stringContaining('configuring maestro-cue.yaml'),
					})
				);
			});

			// Should include the file path
			const prompt = mockBuildSpawnConfig.mock.calls[0][0].prompt;
			expect(prompt).toContain('/test/project/maestro-cue.yaml');
			expect(prompt).toContain('Run code review');
		});

		it('should spawn agent process', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-chat-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-chat-input'), {
				target: { value: 'Run code review' },
			});

			fireEvent.click(screen.getByTestId('ai-chat-send'));

			await waitFor(() => {
				expect(mockSpawn).toHaveBeenCalled();
			});
		});

		it('should freeze YAML editor while agent is working', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-chat-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-chat-input'), {
				target: { value: 'Set up automation' },
			});

			fireEvent.click(screen.getByTestId('ai-chat-send'));

			await waitFor(() => {
				const editor = screen.getByTestId('yaml-editor') as HTMLTextAreaElement;
				expect(editor.readOnly).toBe(true);
			});
		});

		it('should register onData, onExit, onSessionId, and onAgentError listeners', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-chat-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-chat-input'), {
				target: { value: 'Set up automation' },
			});

			fireEvent.click(screen.getByTestId('ai-chat-send'));

			await waitFor(() => {
				expect(mockOnData).toHaveBeenCalledWith(expect.any(Function));
				expect(mockOnExit).toHaveBeenCalledWith(expect.any(Function));
				expect(mockOnSessionId).toHaveBeenCalledWith(expect.any(Function));
				expect(mockOnAgentError).toHaveBeenCalledWith(expect.any(Function));
			});
		});

		it('should show error message when agent config is unavailable', async () => {
			mockBuildSpawnConfig.mockResolvedValue(null);

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-chat-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-chat-input'), {
				target: { value: 'Set up automation' },
			});

			fireEvent.click(screen.getByTestId('ai-chat-send'));

			await waitFor(() => {
				expect(screen.getByText(/Agent not available/)).toBeInTheDocument();
			});
		});

		it('should show placeholder text when chat is empty', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText(/Describe what you want to automate/)).toBeInTheDocument();
			});
		});

		it('should disable input while agent is working', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-chat-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-chat-input'), {
				target: { value: 'Do something' },
			});

			fireEvent.click(screen.getByTestId('ai-chat-send'));

			await waitFor(() => {
				expect(screen.getByTestId('ai-chat-input')).toBeDisabled();
			});
		});
	});

	describe('save and cancel', () => {
		it('should disable Save when content has not changed', async () => {
			mockReadYaml.mockResolvedValue('original content');

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('Save')).toBeInTheDocument();
			});

			expect(screen.getByText('Save')).toBeDisabled();
		});

		it('should enable Save when content is modified and valid', async () => {
			mockReadYaml.mockResolvedValue('original content');

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('yaml-editor'), {
				target: { value: 'modified content' },
			});

			expect(screen.getByText('Save')).not.toBeDisabled();
		});

		it('should disable Save when validation fails', async () => {
			vi.useFakeTimers();
			mockReadYaml.mockResolvedValue('original');

			render(<CueYamlEditor {...defaultProps} />);

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			mockValidateYaml.mockResolvedValue({ valid: false, errors: ['Bad YAML'] });

			fireEvent.change(screen.getByTestId('yaml-editor'), {
				target: { value: 'invalid' },
			});

			await act(async () => {
				vi.advanceTimersByTime(600);
			});

			await act(async () => {
				await vi.runAllTimersAsync();
			});

			expect(screen.getByText('Save')).toBeDisabled();

			vi.useRealTimers();
		});

		it('should call writeYaml and refreshSession on Save', async () => {
			mockReadYaml.mockResolvedValue('original');

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('yaml-editor'), {
				target: { value: 'new content' },
			});

			fireEvent.click(screen.getByText('Save'));

			await waitFor(() => {
				expect(mockWriteYaml).toHaveBeenCalledWith('/test/project', 'new content');
			});
			expect(mockRefreshSession).toHaveBeenCalledWith('sess-1', '/test/project');
			expect(defaultProps.onClose).toHaveBeenCalledOnce();
		});

		it('should call onClose when Exit is clicked and content is not dirty', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('Exit')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Exit'));

			expect(defaultProps.onClose).toHaveBeenCalledOnce();
		});

		it('should prompt for confirmation when Exit is clicked with dirty content', async () => {
			const mockConfirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
			mockReadYaml.mockResolvedValue('original');

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('yaml-editor'), {
				target: { value: 'modified' },
			});

			fireEvent.click(screen.getByText('Exit'));

			expect(mockConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
			expect(defaultProps.onClose).not.toHaveBeenCalled();

			mockConfirm.mockRestore();
		});

		it('should close when user confirms discard on Exit', async () => {
			const mockConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
			mockReadYaml.mockResolvedValue('original');

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('yaml-editor'), {
				target: { value: 'modified' },
			});

			fireEvent.click(screen.getByText('Exit'));

			expect(defaultProps.onClose).toHaveBeenCalledOnce();

			mockConfirm.mockRestore();
		});
	});

	describe('pattern presets', () => {
		it('should render pattern preset buttons', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('pattern-presets')).toBeInTheDocument();
			});

			expect(screen.getByTestId('pattern-scheduled-task')).toBeInTheDocument();
			expect(screen.getByTestId('pattern-file-enrichment')).toBeInTheDocument();
			expect(screen.getByTestId('pattern-reactive')).toBeInTheDocument();
			expect(screen.getByTestId('pattern-research-swarm')).toBeInTheDocument();
			expect(screen.getByTestId('pattern-sequential-chain')).toBeInTheDocument();
			expect(screen.getByTestId('pattern-debate')).toBeInTheDocument();
		});

		it('should render "Start from a pattern" heading', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('Start from a pattern')).toBeInTheDocument();
			});
		});

		it('should populate editor when a pattern is clicked', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('pattern-scheduled-task')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByTestId('pattern-scheduled-task'));

			const editor = screen.getByTestId('yaml-editor') as HTMLTextAreaElement;
			expect(editor.value).toContain('Scheduled Task');
			expect(editor.value).toContain('time.interval');
			expect(editor.value).toContain('interval_minutes: 60');
		});

		it('should prompt for confirmation when editor is dirty before applying pattern', async () => {
			const mockConfirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
			mockReadYaml.mockResolvedValue('original content');

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('yaml-editor'), {
				target: { value: 'modified content' },
			});

			fireEvent.click(screen.getByTestId('pattern-file-enrichment'));

			expect(mockConfirm).toHaveBeenCalledWith(
				'Replace current YAML with this pattern? Unsaved changes will be lost.'
			);

			const editor = screen.getByTestId('yaml-editor') as HTMLTextAreaElement;
			expect(editor.value).toBe('modified content');

			mockConfirm.mockRestore();
		});

		it('should replace content when user confirms dirty pattern switch', async () => {
			const mockConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
			mockReadYaml.mockResolvedValue('original content');

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('yaml-editor'), {
				target: { value: 'modified content' },
			});

			fireEvent.click(screen.getByTestId('pattern-debate'));

			const editor = screen.getByTestId('yaml-editor') as HTMLTextAreaElement;
			expect(editor.value).toContain('Debate');
			expect(editor.value).toContain('debater-pro');

			mockConfirm.mockRestore();
		});
	});
});

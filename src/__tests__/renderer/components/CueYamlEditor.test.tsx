/**
 * Tests for CueYamlEditor component
 *
 * Tests the Cue YAML editor including:
 * - Loading existing YAML content on mount
 * - YAML template shown when no file exists
 * - Real-time validation with error display
 * - AI assist section with clipboard copy
 * - Save/Cancel functionality with dirty state
 * - Line numbers gutter
 * - Tab key indentation
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
		confirmDisabled,
	}: {
		onCancel: () => void;
		onConfirm: () => void;
		confirmLabel: string;
		confirmDisabled: boolean;
		theme: Theme;
	}) => (
		<>
			<button onClick={onCancel}>Cancel</button>
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

// Mock IPC methods
const mockReadYaml = vi.fn();
const mockWriteYaml = vi.fn();
const mockValidateYaml = vi.fn();
const mockRefreshSession = vi.fn();

const mockClipboardWriteText = vi.fn().mockResolvedValue(undefined);

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
	};

	Object.assign(navigator, {
		clipboard: {
			writeText: mockClipboardWriteText,
		},
	});

	// Default: file doesn't exist, YAML is valid
	mockReadYaml.mockResolvedValue(null);
	mockWriteYaml.mockResolvedValue(undefined);
	mockValidateYaml.mockResolvedValue({ valid: true, errors: [] });
	mockRefreshSession.mockResolvedValue(undefined);
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
			// Make readYaml never resolve to keep loading state
			mockReadYaml.mockReturnValue(new Promise(() => {}));
			render(<CueYamlEditor {...defaultProps} />);

			expect(screen.getByText('Loading YAML...')).toBeInTheDocument();
		});

		it('should render AI assist section', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('AI Assist')).toBeInTheDocument();
			});
			expect(screen.getByTestId('ai-description-input')).toBeInTheDocument();
			expect(screen.getByTestId('copy-prompt-button')).toBeInTheDocument();
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

			// Change the content to trigger validation
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

			// Wait for initial load
			await act(async () => {
				await vi.runAllTimersAsync();
			});

			// Rapidly change the content
			const editor = screen.getByTestId('yaml-editor');
			fireEvent.change(editor, { target: { value: 'change1' } });
			fireEvent.change(editor, { target: { value: 'change2' } });
			fireEvent.change(editor, { target: { value: 'change3' } });

			// Before debounce window, validateYaml should not be called for the changes
			// (may have been called during initial load)
			const callsBeforeDebounce = mockValidateYaml.mock.calls.length;

			// Advance past debounce timer
			await act(async () => {
				vi.advanceTimersByTime(600);
			});

			// Should only have added one validation call (for the last change)
			expect(mockValidateYaml.mock.calls.length).toBe(callsBeforeDebounce + 1);
			expect(mockValidateYaml).toHaveBeenLastCalledWith('change3');

			vi.useRealTimers();
		});
	});

	describe('AI assist', () => {
		it('should have disabled copy button when description is empty', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('copy-prompt-button')).toBeInTheDocument();
			});

			expect(screen.getByTestId('copy-prompt-button')).toBeDisabled();
		});

		it('should enable copy button when description has text', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-description-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-description-input'), {
				target: { value: 'Watch for file changes' },
			});

			expect(screen.getByTestId('copy-prompt-button')).not.toBeDisabled();
		});

		it('should copy system prompt + description to clipboard', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-description-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-description-input'), {
				target: { value: 'Run code review on save' },
			});

			fireEvent.click(screen.getByTestId('copy-prompt-button'));

			await waitFor(() => {
				expect(mockClipboardWriteText).toHaveBeenCalledOnce();
			});

			const copiedText = mockClipboardWriteText.mock.calls[0][0];
			expect(copiedText).toContain('Maestro Cue configuration generator');
			expect(copiedText).toContain('Run code review on save');
		});

		it('should show "Copied!" feedback after copying', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('ai-description-input')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('ai-description-input'), {
				target: { value: 'test' },
			});

			fireEvent.click(screen.getByTestId('copy-prompt-button'));

			await waitFor(() => {
				expect(screen.getByText('Copied!')).toBeInTheDocument();
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

			// Save should be enabled since content changed and validation is still valid
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

			// Advance past debounce
			await act(async () => {
				vi.advanceTimersByTime(600);
			});

			// Wait for async validation to complete
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

		it('should call onClose when Cancel is clicked and content is not dirty', async () => {
			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByText('Cancel')).toBeInTheDocument();
			});

			fireEvent.click(screen.getByText('Cancel'));

			expect(defaultProps.onClose).toHaveBeenCalledOnce();
		});

		it('should prompt for confirmation when Cancel is clicked with dirty content', async () => {
			const mockConfirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
			mockReadYaml.mockResolvedValue('original');

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('yaml-editor'), {
				target: { value: 'modified' },
			});

			fireEvent.click(screen.getByText('Cancel'));

			expect(mockConfirm).toHaveBeenCalledWith('You have unsaved changes. Discard them?');
			expect(defaultProps.onClose).not.toHaveBeenCalled();

			mockConfirm.mockRestore();
		});

		it('should close when user confirms discard on Cancel', async () => {
			const mockConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
			mockReadYaml.mockResolvedValue('original');

			render(<CueYamlEditor {...defaultProps} />);

			await waitFor(() => {
				expect(screen.getByTestId('yaml-editor')).toBeInTheDocument();
			});

			fireEvent.change(screen.getByTestId('yaml-editor'), {
				target: { value: 'modified' },
			});

			fireEvent.click(screen.getByText('Cancel'));

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

			// Make the editor dirty
			fireEvent.change(screen.getByTestId('yaml-editor'), {
				target: { value: 'modified content' },
			});

			fireEvent.click(screen.getByTestId('pattern-file-enrichment'));

			expect(mockConfirm).toHaveBeenCalledWith(
				'Replace current YAML with this pattern? Unsaved changes will be lost.'
			);

			// Should NOT have replaced content since user declined
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

			// Make the editor dirty
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

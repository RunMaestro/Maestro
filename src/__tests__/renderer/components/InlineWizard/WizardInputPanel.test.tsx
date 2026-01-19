/**
 * Tests for WizardInputPanel.tsx
 *
 * Tests the wizard-specific input panel component:
 * - Layout with WizardPill and ConfidenceGauge
 * - Image attachment functionality
 * - Prompt composer button
 * - Mode toggle (AI/Terminal) with disabled state during generation
 * - Hidden toggles (read-only, history, thinking)
 * - Escape key to exit wizard
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WizardInputPanel } from '../../../../renderer/components/InlineWizard/WizardInputPanel';
import type { Session, Theme } from '../../../../renderer/types';

// Mock useLayerStack for the WizardExitConfirmDialog
vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-1'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

// Mock theme for testing
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		background: '#1a1a1a',
		backgroundDim: '#0d0d0d',
		backgroundBright: '#2a2a2a',
		bgActivity: '#333333',
		bgMain: '#1a1a1a',
		bgSidebar: '#141414',
		textMain: '#ffffff',
		textDim: '#888888',
		textMuted: '#666666',
		textBright: '#ffffff',
		border: '#333333',
		borderBright: '#444444',
		success: '#00ff00',
		warning: '#ffff00',
		error: '#ff0000',
		accent: '#007bff',
		accentForeground: '#ffffff',
		accentText: '#66b2ff',
	},
};

// Mock session for testing
const createMockSession = (overrides?: Partial<Session>): Session =>
	({
		id: 'test-session',
		name: 'Test Session',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		toolType: 'claude-code',
		state: 'idle',
		inputMode: 'ai',
		isGitRepo: false,
		shellLogs: [],
		fileTree: [],
		changedFiles: [],
		workLog: [],
		aiTabs: [
			{
				id: 'tab-1',
				name: 'Main',
				logs: [],
			},
		],
		activeTabId: 'tab-1',
		closedTabHistory: [],
		executionQueue: [],
		contextUsage: 0,
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		isLive: false,
		aiPid: 1234,
		port: 3000,
		wizardState: {
			isActive: true,
			mode: 'new',
			confidence: 50,
			conversationHistory: [],
			previousUIState: {
				readOnlyMode: false,
				saveToHistory: true,
				showThinking: false,
			},
		},
		...overrides,
	}) as Session;

describe('WizardInputPanel', () => {
	const defaultProps = {
		session: createMockSession(),
		theme: mockTheme,
		inputValue: '',
		setInputValue: vi.fn(),
		inputRef: { current: null } as React.RefObject<HTMLTextAreaElement>,
		handleInputKeyDown: vi.fn(),
		handlePaste: vi.fn(),
		processInput: vi.fn(),
		stagedImages: [] as string[],
		setStagedImages: vi.fn(),
		onOpenPromptComposer: vi.fn(),
		toggleInputMode: vi.fn(),
		confidence: 50,
		canAttachImages: true,
		isBusy: false,
		onExitWizard: vi.fn(),
		enterToSend: true,
		setEnterToSend: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('layout', () => {
		it('renders the WizardPill component', () => {
			render(<WizardInputPanel {...defaultProps} />);
			expect(screen.getByText('Wizard')).toBeInTheDocument();
		});

		it('renders the ConfidenceGauge with correct confidence', () => {
			render(<WizardInputPanel {...defaultProps} confidence={75} />);
			expect(screen.getByText('75%')).toBeInTheDocument();
		});

		it('renders the textarea with placeholder', () => {
			render(<WizardInputPanel {...defaultProps} />);
			expect(
				screen.getByPlaceholderText('Tell the wizard about your project...')
			).toBeInTheDocument();
		});
	});

	describe('input functionality', () => {
		it('displays the current input value', () => {
			render(<WizardInputPanel {...defaultProps} inputValue="Hello wizard" />);
			expect(screen.getByDisplayValue('Hello wizard')).toBeInTheDocument();
		});

		it('calls setInputValue when typing', () => {
			const setInputValue = vi.fn();
			render(<WizardInputPanel {...defaultProps} setInputValue={setInputValue} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.change(textarea, { target: { value: 'test input' } });

			expect(setInputValue).toHaveBeenCalledWith('test input');
		});

		it('calls handleInputKeyDown on key press', () => {
			const handleInputKeyDown = vi.fn();
			render(<WizardInputPanel {...defaultProps} handleInputKeyDown={handleInputKeyDown} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Enter' });

			expect(handleInputKeyDown).toHaveBeenCalled();
		});

		it('calls handlePaste on paste event', () => {
			const handlePaste = vi.fn();
			render(<WizardInputPanel {...defaultProps} handlePaste={handlePaste} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.paste(textarea);

			expect(handlePaste).toHaveBeenCalled();
		});
	});

	describe('send button', () => {
		it('renders the send button', () => {
			render(<WizardInputPanel {...defaultProps} />);
			expect(screen.getByTitle('Send message')).toBeInTheDocument();
		});

		it('calls processInput when send button is clicked', () => {
			const processInput = vi.fn();
			render(<WizardInputPanel {...defaultProps} processInput={processInput} />);

			fireEvent.click(screen.getByTitle('Send message'));

			expect(processInput).toHaveBeenCalled();
		});
	});

	describe('mode toggle', () => {
		it('renders the mode toggle button', () => {
			render(<WizardInputPanel {...defaultProps} />);
			expect(screen.getByTitle('Toggle Mode (Cmd+J)')).toBeInTheDocument();
		});

		it('calls toggleInputMode when clicked', () => {
			const toggleInputMode = vi.fn();
			render(<WizardInputPanel {...defaultProps} toggleInputMode={toggleInputMode} />);

			fireEvent.click(screen.getByTitle('Toggle Mode (Cmd+J)'));

			expect(toggleInputMode).toHaveBeenCalled();
		});

		it('is disabled when isBusy is true', () => {
			render(<WizardInputPanel {...defaultProps} isBusy={true} />);

			const modeButton = screen.getByTitle('Cannot switch mode while wizard is processing');
			expect(modeButton).toBeDisabled();
		});

		it('does not call toggleInputMode when disabled', () => {
			const toggleInputMode = vi.fn();
			render(
				<WizardInputPanel {...defaultProps} toggleInputMode={toggleInputMode} isBusy={true} />
			);

			fireEvent.click(screen.getByTitle('Cannot switch mode while wizard is processing'));

			expect(toggleInputMode).not.toHaveBeenCalled();
		});

		it('shows Terminal icon when in terminal mode', () => {
			const terminalSession = createMockSession({ inputMode: 'terminal' });
			const { container } = render(
				<WizardInputPanel {...defaultProps} session={terminalSession} />
			);

			// Terminal icon should be present (not the Wand icon)
			const modeButton = screen.getByTitle('Toggle Mode (Cmd+J)');
			const svgIcon = modeButton.querySelector('svg');
			expect(svgIcon).toBeInTheDocument();
		});
	});

	describe('wizard pill click', () => {
		it('shows exit confirmation dialog when WizardPill is clicked', () => {
			render(<WizardInputPanel {...defaultProps} />);

			fireEvent.click(screen.getByText('Wizard'));

			// Dialog should appear instead of directly calling onExitWizard
			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();
		});
	});

	describe('image attachment', () => {
		it('renders image attachment button when canAttachImages is true', () => {
			render(<WizardInputPanel {...defaultProps} canAttachImages={true} />);
			expect(screen.getByTitle('Attach Image')).toBeInTheDocument();
		});

		it('does not render image attachment button when canAttachImages is false', () => {
			render(<WizardInputPanel {...defaultProps} canAttachImages={false} />);
			expect(screen.queryByTitle('Attach Image')).not.toBeInTheDocument();
		});

		it('does not render image attachment button in terminal mode', () => {
			const terminalSession = createMockSession({ inputMode: 'terminal' });
			render(
				<WizardInputPanel {...defaultProps} session={terminalSession} canAttachImages={true} />
			);
			expect(screen.queryByTitle('Attach Image')).not.toBeInTheDocument();
		});

		it('renders staged images', () => {
			const stagedImages = ['data:image/png;base64,abc123', 'data:image/png;base64,def456'];
			render(<WizardInputPanel {...defaultProps} stagedImages={stagedImages} />);

			const images = screen.getAllByRole('img');
			expect(images).toHaveLength(2);
		});

		it('calls setStagedImages when removing an image', () => {
			const setStagedImages = vi.fn();
			const stagedImages = ['data:image/png;base64,abc123'];
			render(
				<WizardInputPanel
					{...defaultProps}
					stagedImages={stagedImages}
					setStagedImages={setStagedImages}
				/>
			);

			// Find and click the remove button (X button on the image)
			const removeButtons = screen.getAllByRole('button');
			const xButton = removeButtons.find((btn) => btn.classList.contains('bg-red-500'));
			expect(xButton).toBeDefined();
			fireEvent.click(xButton!);

			expect(setStagedImages).toHaveBeenCalled();
		});
	});

	describe('prompt composer', () => {
		it('renders prompt composer button in AI mode', () => {
			render(<WizardInputPanel {...defaultProps} />);
			expect(screen.getByTitle('Open Prompt Composer')).toBeInTheDocument();
		});

		it('does not render prompt composer button in terminal mode', () => {
			const terminalSession = createMockSession({ inputMode: 'terminal' });
			render(<WizardInputPanel {...defaultProps} session={terminalSession} />);
			expect(screen.queryByTitle('Open Prompt Composer')).not.toBeInTheDocument();
		});

		it('calls onOpenPromptComposer when clicked', () => {
			const onOpenPromptComposer = vi.fn();
			render(<WizardInputPanel {...defaultProps} onOpenPromptComposer={onOpenPromptComposer} />);

			fireEvent.click(screen.getByTitle('Open Prompt Composer'));

			expect(onOpenPromptComposer).toHaveBeenCalled();
		});

		it('does not render when onOpenPromptComposer is not provided', () => {
			render(<WizardInputPanel {...defaultProps} onOpenPromptComposer={undefined} />);
			expect(screen.queryByTitle('Open Prompt Composer')).not.toBeInTheDocument();
		});
	});

	describe('enter to send toggle', () => {
		it('renders the enter to send toggle', () => {
			render(<WizardInputPanel {...defaultProps} enterToSend={true} />);
			expect(screen.getByText('Enter')).toBeInTheDocument();
		});

		it('shows "⌘ + Enter" when enterToSend is false', () => {
			render(<WizardInputPanel {...defaultProps} enterToSend={false} />);
			expect(screen.getByText('⌘ + Enter')).toBeInTheDocument();
		});

		it('calls setEnterToSend when clicked', () => {
			const setEnterToSend = vi.fn();
			render(
				<WizardInputPanel {...defaultProps} enterToSend={true} setEnterToSend={setEnterToSend} />
			);

			fireEvent.click(screen.getByText('Enter'));

			expect(setEnterToSend).toHaveBeenCalledWith(false);
		});
	});

	describe('hidden toggles', () => {
		it('does not render read-only toggle', () => {
			render(<WizardInputPanel {...defaultProps} />);
			expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
		});

		it('does not render history toggle', () => {
			render(<WizardInputPanel {...defaultProps} />);
			expect(screen.queryByText('History')).not.toBeInTheDocument();
		});

		it('does not render thinking toggle when onToggleShowThinking is not provided', () => {
			render(<WizardInputPanel {...defaultProps} />);
			expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
		});
	});

	describe('thinking toggle', () => {
		it('renders thinking toggle when onToggleShowThinking is provided', () => {
			render(<WizardInputPanel {...defaultProps} onToggleShowThinking={vi.fn()} />);
			expect(screen.getByText('Thinking')).toBeInTheDocument();
		});

		it('calls onToggleShowThinking when clicked', () => {
			const onToggleShowThinking = vi.fn();
			render(<WizardInputPanel {...defaultProps} onToggleShowThinking={onToggleShowThinking} />);

			fireEvent.click(screen.getByText('Thinking'));

			expect(onToggleShowThinking).toHaveBeenCalledTimes(1);
		});

		it('shows toggle in active state when showThinking is true', () => {
			render(
				<WizardInputPanel {...defaultProps} showThinking={true} onToggleShowThinking={vi.fn()} />
			);

			const thinkingButton = screen.getByTitle('Hide AI thinking (show filler messages)');
			expect(thinkingButton).toHaveClass('opacity-100');
		});

		it('shows toggle in inactive state when showThinking is false', () => {
			render(
				<WizardInputPanel {...defaultProps} showThinking={false} onToggleShowThinking={vi.fn()} />
			);

			const thinkingButton = screen.getByTitle('Show AI thinking');
			expect(thinkingButton).toHaveClass('opacity-50');
		});

		it('does not render thinking toggle in terminal mode', () => {
			const terminalSession = createMockSession({ inputMode: 'terminal' });
			render(
				<WizardInputPanel
					{...defaultProps}
					session={terminalSession}
					onToggleShowThinking={vi.fn()}
				/>
			);
			expect(screen.queryByText('Thinking')).not.toBeInTheDocument();
		});
	});

	describe('focus callbacks', () => {
		it('calls onInputFocus when textarea receives focus', () => {
			const onInputFocus = vi.fn();
			render(<WizardInputPanel {...defaultProps} onInputFocus={onInputFocus} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.focus(textarea);

			expect(onInputFocus).toHaveBeenCalled();
		});

		it('calls onInputBlur when textarea loses focus', () => {
			const onInputBlur = vi.fn();
			render(<WizardInputPanel {...defaultProps} onInputBlur={onInputBlur} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.blur(textarea);

			expect(onInputBlur).toHaveBeenCalled();
		});
	});

	describe('styling', () => {
		it('applies accent border color to input container', () => {
			const { container } = render(<WizardInputPanel {...defaultProps} />);
			// Find the main input container (has border-t class for top border)
			const inputContainer = container.querySelector('.border.rounded-lg');
			expect(inputContainer).toHaveStyle({
				borderColor: mockTheme.colors.accent,
			});
		});

		it('applies accent background tint to input container', () => {
			const { container } = render(<WizardInputPanel {...defaultProps} />);
			const inputContainer = container.querySelector('.border.rounded-lg');
			expect(inputContainer).toHaveStyle({
				backgroundColor: `${mockTheme.colors.accent}10`,
			});
		});
	});

	describe('escape key handling', () => {
		it('shows exit confirmation dialog when Escape is pressed in textarea', () => {
			render(<WizardInputPanel {...defaultProps} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// Dialog should appear
			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();
			expect(
				screen.getByText('Progress will be lost. Are you sure you want to exit the wizard?')
			).toBeInTheDocument();
		});

		it('forwards non-Escape key events to handleInputKeyDown', () => {
			const handleInputKeyDown = vi.fn();
			render(<WizardInputPanel {...defaultProps} handleInputKeyDown={handleInputKeyDown} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Enter' });

			expect(handleInputKeyDown).toHaveBeenCalled();
		});

		it('does not forward Escape key to handleInputKeyDown', () => {
			const handleInputKeyDown = vi.fn();
			render(<WizardInputPanel {...defaultProps} handleInputKeyDown={handleInputKeyDown} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			expect(handleInputKeyDown).not.toHaveBeenCalled();
		});

		it('calls onExitWizard when Exit is clicked in dialog', () => {
			const onExitWizard = vi.fn();
			render(<WizardInputPanel {...defaultProps} onExitWizard={onExitWizard} />);

			// Show the dialog
			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// Click Exit button
			fireEvent.click(screen.getByRole('button', { name: 'Exit' }));

			expect(onExitWizard).toHaveBeenCalledTimes(1);
		});

		it('closes dialog when Cancel is clicked', () => {
			render(<WizardInputPanel {...defaultProps} />);

			// Show the dialog
			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// Dialog should be visible
			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();

			// Click Cancel button
			fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

			// Dialog should be closed
			expect(screen.queryByText('Exit Wizard?')).not.toBeInTheDocument();
		});

		it('shows exit dialog when WizardPill is clicked', () => {
			render(<WizardInputPanel {...defaultProps} />);

			// Click the Wizard pill
			fireEvent.click(screen.getByText('Wizard'));

			// Dialog should appear
			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();
		});
	});
});

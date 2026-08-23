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
import { useRef, useState } from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { WizardInputPanel } from '../../../../renderer/components/InlineWizard/WizardInputPanel';
import {
	formatShortcutKeys,
	formatEnterToSend,
} from '../../../../renderer/utils/shortcutFormatter';
import type { Session } from '../../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../../helpers/mockSession';

import { mockTheme } from '../../../helpers/mockTheme';
// Mock useLayerStack for the WizardExitConfirmDialog
vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-1'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

// Mock sessionStore for tab close on Escape
const mockSetSessions = vi.fn();
vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: {
		getState: () => ({
			setSessions: mockSetSessions,
		}),
	},
}));

// Mock theme for testing

// Thin wrapper: seeds an active wizard state on the session so the
// input panel renders the wizard chrome.
const createMockSession = (overrides?: Partial<Session>): Session =>
	baseCreateMockSession({
		id: 'test-session',
		cwd: '/test',
		fullPath: '/test',
		projectRoot: '/test',
		aiTabs: [
			{
				id: 'tab-1',
				name: 'Main',
				logs: [],
			},
		] as any,
		activeTabId: 'tab-1',
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
				showThinking: 'off',
			},
		} as any,
		...overrides,
	});

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
			expect(
				screen.getByTitle(`Toggle Mode (${formatShortcutKeys(['Meta', 'j'])})`)
			).toBeInTheDocument();
		});

		it('calls toggleInputMode when clicked', () => {
			const toggleInputMode = vi.fn();
			render(<WizardInputPanel {...defaultProps} toggleInputMode={toggleInputMode} />);

			fireEvent.click(screen.getByTitle(`Toggle Mode (${formatShortcutKeys(['Meta', 'j'])})`));

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
			const modeButton = screen.getByTitle(`Toggle Mode (${formatShortcutKeys(['Meta', 'j'])})`);
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

		it('shows "⌘ + Enter" (or "Ctrl + Enter" on non-Mac) when enterToSend is false', () => {
			render(<WizardInputPanel {...defaultProps} enterToSend={false} />);
			expect(screen.getByText(formatEnterToSend(false))).toBeInTheDocument();
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
		it('confirms before exiting even when the user has not interacted yet', () => {
			const onExitWizard = vi.fn();
			render(<WizardInputPanel {...defaultProps} onExitWizard={onExitWizard} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// Never a direct exit - the dialog is the only way out
			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();
			expect(onExitWizard).not.toHaveBeenCalled();
			expect(mockSetSessions).not.toHaveBeenCalled();
		});

		it('never loses the wizard on a second Escape', () => {
			const onExitWizard = vi.fn();
			const onStopWizardTurn = vi.fn();
			const { rerender } = render(
				<WizardInputPanel
					{...defaultProps}
					isBusy={true}
					onStopTurn={onStopWizardTurn}
					onExitWizard={onExitWizard}
				/>
			);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');

			// First Escape stops the turn
			fireEvent.keyDown(textarea, { key: 'Escape' });
			expect(onStopWizardTurn).toHaveBeenCalledTimes(1);

			// The turn ended, so the panel is no longer busy - second Escape only asks
			rerender(
				<WizardInputPanel
					{...defaultProps}
					isBusy={false}
					onStopTurn={onStopWizardTurn}
					onExitWizard={onExitWizard}
				/>
			);
			fireEvent.keyDown(textarea, { key: 'Escape' });

			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();
			expect(onExitWizard).not.toHaveBeenCalled();
			expect(mockSetSessions).not.toHaveBeenCalled();
		});

		it('shows exit confirmation dialog when Escape is pressed with user interaction', () => {
			const sessionWithHistory = createMockSession({
				wizardState: {
					isActive: true,
					mode: 'new',
					confidence: 50,
					conversationHistory: [
						{ id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
					],
					previousUIState: { readOnlyMode: false, saveToHistory: true, showThinking: 'off' },
				},
			});
			render(<WizardInputPanel {...defaultProps} session={sessionWithHistory} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// Dialog should appear
			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();
			expect(
				screen.getByText(/Are you sure you want to exit the wizard and lose your progress\?/)
			).toBeInTheDocument();
		});

		it('shows exit confirmation dialog when Escape is pressed with typed input', () => {
			render(<WizardInputPanel {...defaultProps} inputValue="some text" />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();
		});

		it('shows exit confirmation dialog when Escape is pressed with staged images', () => {
			render(<WizardInputPanel {...defaultProps} stagedImages={['data:image/png;base64,abc']} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();
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
			const sessionWithHistory = createMockSession({
				wizardState: {
					isActive: true,
					mode: 'new',
					confidence: 50,
					conversationHistory: [
						{ id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
					],
					previousUIState: { readOnlyMode: false, saveToHistory: true, showThinking: 'off' },
				},
			});
			render(
				<WizardInputPanel
					{...defaultProps}
					session={sessionWithHistory}
					onExitWizard={onExitWizard}
				/>
			);

			// Show the dialog
			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// Click Exit button
			fireEvent.click(screen.getByTestId('wizard-exit-confirm-button'));

			expect(onExitWizard).toHaveBeenCalledTimes(1);
		});

		it('focuses the destructive button so Enter confirms the exit', () => {
			render(<WizardInputPanel {...defaultProps} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// Enter must land on "Yes, Exit", not on Cancel
			expect(screen.getByTestId('wizard-exit-confirm-button')).toHaveFocus();
		});

		it('closes dialog when Cancel is clicked', () => {
			const sessionWithHistory = createMockSession({
				wizardState: {
					isActive: true,
					mode: 'new',
					confidence: 50,
					conversationHistory: [
						{ id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
					],
					previousUIState: { readOnlyMode: false, saveToHistory: true, showThinking: 'off' },
				},
			});
			render(<WizardInputPanel {...defaultProps} session={sessionWithHistory} />);

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

		it('exits the wizard instead of closing a tab that already holds a conversation', () => {
			const onExitWizard = vi.fn();
			const sessionWithLogs = createMockSession({
				aiTabs: [
					{
						id: 'tab-1',
						name: 'Main',
						logs: [
							{ id: 'l1', timestamp: Date.now(), source: 'system', text: 'Starting wizard...' },
							{ id: 'l2', timestamp: Date.now(), source: 'user', text: 'earlier work' },
						],
					},
					{ id: 'tab-2', name: 'Other', logs: [] },
				] as any,
			});
			render(
				<WizardInputPanel {...defaultProps} session={sessionWithLogs} onExitWizard={onExitWizard} />
			);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });
			fireEvent.click(screen.getByTestId('wizard-exit-confirm-button'));

			expect(mockSetSessions).not.toHaveBeenCalled();
			expect(onExitWizard).toHaveBeenCalledTimes(1);
		});

		it('closes its own untouched wizard tab once the exit is confirmed', () => {
			const onExitWizard = vi.fn();
			const sessionWithWizardTab = createMockSession({
				aiTabs: [
					{
						id: 'tab-1',
						name: 'Wizard',
						logs: [
							{ id: 'l1', timestamp: Date.now(), source: 'system', text: 'Starting wizard...' },
						],
					},
					{ id: 'tab-2', name: 'Other', logs: [] },
				] as any,
			});
			render(
				<WizardInputPanel
					{...defaultProps}
					session={sessionWithWizardTab}
					onExitWizard={onExitWizard}
				/>
			);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// Still nothing destroyed until the red button is pressed
			expect(mockSetSessions).not.toHaveBeenCalled();

			fireEvent.click(screen.getByTestId('wizard-exit-confirm-button'));

			expect(mockSetSessions).toHaveBeenCalledTimes(1);
			expect(onExitWizard).not.toHaveBeenCalled();
		});

		it('stops the running turn instead of closing the tab when Escape is pressed mid-turn', () => {
			const onStopWizardTurn = vi.fn();
			const onExitWizard = vi.fn();
			render(
				<WizardInputPanel
					{...defaultProps}
					isBusy={true}
					onStopTurn={onStopWizardTurn}
					onExitWizard={onExitWizard}
				/>
			);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// The turn is stopped, the wizard stays open, and the tab survives
			expect(onStopWizardTurn).toHaveBeenCalledWith('tab-1');
			expect(onExitWizard).not.toHaveBeenCalled();
			expect(mockSetSessions).not.toHaveBeenCalled();
			expect(screen.queryByText('Exit Wizard?')).not.toBeInTheDocument();
		});

		it('asks to exit while initializing - there is no turn to stop yet', () => {
			const onStopWizardTurn = vi.fn();
			const onExitWizard = vi.fn();
			render(
				<WizardInputPanel
					{...defaultProps}
					isInitializing={true}
					onStopTurn={onStopWizardTurn}
					onExitWizard={onExitWizard}
				/>
			);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// Initialization is local doc scanning, not an agent turn, so there is nothing
			// to kill - but it still must not exit without asking.
			expect(onStopWizardTurn).not.toHaveBeenCalled();
			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();
			expect(onExitWizard).not.toHaveBeenCalled();
			expect(mockSetSessions).not.toHaveBeenCalled();
		});

		it('falls back to the exit confirmation mid-turn when no stop handler is wired', () => {
			const onExitWizard = vi.fn();
			render(<WizardInputPanel {...defaultProps} isBusy={true} onExitWizard={onExitWizard} />);

			const textarea = screen.getByPlaceholderText('Tell the wizard about your project...');
			fireEvent.keyDown(textarea, { key: 'Escape' });

			// Never a silent tab close while a turn is running
			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();
			expect(onExitWizard).not.toHaveBeenCalled();
			expect(mockSetSessions).not.toHaveBeenCalled();
		});
	});

	describe('stop turn button', () => {
		it('replaces the send button with a stop button while a turn is running', () => {
			const onStopWizardTurn = vi.fn();
			render(<WizardInputPanel {...defaultProps} isBusy={true} onStopTurn={onStopWizardTurn} />);

			const stopButton = screen.getByTestId('wizard-stop-turn-button');
			fireEvent.click(stopButton);

			expect(onStopWizardTurn).toHaveBeenCalledWith('tab-1');
		});

		it('shows the send button when idle', () => {
			const onStopWizardTurn = vi.fn();
			render(<WizardInputPanel {...defaultProps} isBusy={false} onStopTurn={onStopWizardTurn} />);

			expect(screen.queryByTestId('wizard-stop-turn-button')).not.toBeInTheDocument();
		});
	});

	describe('wizard pill', () => {
		it('shows exit dialog when WizardPill is clicked', () => {
			render(<WizardInputPanel {...defaultProps} />);

			// Click the Wizard pill
			fireEvent.click(screen.getByText('Wizard'));

			// Dialog should appear
			expect(screen.getByText('Exit Wizard?')).toBeInTheDocument();
		});
	});

	describe('auto-grow', () => {
		const CONTENT_HEIGHT = 300;

		/** Controlled harness so the panel sees a real value change on each keystroke. */
		function Harness({ initialValue }: { initialValue: string }) {
			const [value, setValue] = useState(initialValue);
			const ref = useRef<HTMLTextAreaElement | null>(null);

			return (
				<div
					ref={() => {
						// jsdom has no layout, so stub the two measurements the autosize path
						// reads. React has already pointed `ref` at the textarea by the time
						// this parent ref callback runs.
						const el = ref.current;
						if (el && !Object.getOwnPropertyDescriptor(el, 'scrollHeight')) {
							Object.defineProperty(el, 'scrollHeight', {
								value: CONTENT_HEIGHT,
								configurable: true,
							});
							Object.defineProperty(el, 'selectionEnd', {
								get: () => el.value.length,
								configurable: true,
							});
						}
					}}
				>
					<WizardInputPanel
						{...defaultProps}
						inputRef={ref as React.RefObject<HTMLTextAreaElement>}
						inputValue={value}
						setInputValue={setValue}
					/>
				</div>
			);
		}

		/** Let any requestAnimationFrame callback the panel scheduled actually run. */
		const flushAnimationFrames = async () => {
			await act(async () => {
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
				await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			});
		};

		it('caps the grown height at the composer max height', async () => {
			render(<Harness initialValue="line one" />);
			const textarea = screen.getByPlaceholderText(
				'Tell the wizard about your project...'
			) as HTMLTextAreaElement;

			fireEvent.change(textarea, { target: { value: 'line one\nline two' } });
			await flushAnimationFrames();

			expect(textarea.style.height).toBe('112px');
		});

		it('pins the scroll to the caret after a keystroke', async () => {
			// Guards the pin itself (removing useAutosizeTextarea from the panel fails
			// here). It canNOT reproduce the original bug: that was a raw height='auto'
			// toggle in a requestAnimationFrame collapsing the textarea's scroll AFTER
			// the pin, and jsdom has no layout engine, so a height change never moves
			// scrollTop there. Verified in a real browser instead.
			render(<Harness initialValue="line one" />);
			const textarea = screen.getByPlaceholderText(
				'Tell the wizard about your project...'
			) as HTMLTextAreaElement;

			fireEvent.change(textarea, { target: { value: 'line one\nline two' } });
			await flushAnimationFrames();

			expect(textarea.scrollTop).toBe(CONTENT_HEIGHT);
		});
	});
});

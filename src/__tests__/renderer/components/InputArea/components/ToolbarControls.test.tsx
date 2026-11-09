import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolbarControls } from '../../../../../renderer/components/InputArea/components/ToolbarControls';
import { usePhoneLayout } from '../../../../../renderer/hooks/ui/useViewportBreakpoint';
import { inputAreaTheme } from '../_fixtures';
import { restorePointer, setCoarsePointer } from '../../../../helpers/mockPointer';
import type { ComposerCapabilities } from '../../../../../renderer/components/ChatComposer';

/** An AI-mode agent that supports every optional control. */
const AI_CAPABILITIES: ComposerCapabilities = {
	imageAttach: true,
	upload: true,
	voice: true,
	saveToHistory: true,
	permission: true,
	thinking: true,
	modelEffort: true,
};

/** Terminal mode: the toolbar offers none of the optional controls. */
const TERMINAL_CAPABILITIES: ComposerCapabilities = {
	imageAttach: false,
	upload: false,
	voice: false,
	saveToHistory: false,
	permission: false,
	thinking: false,
	modelEffort: false,
};

vi.mock('../../../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../../../renderer/hooks/ui/useViewportBreakpoint')
	>()),
	usePhoneLayout: vi.fn(() => false),
}));
const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);

describe('ToolbarControls', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		restorePointer();
		mockedUsePhoneLayout.mockReturnValue(false);
	});

	function renderToolbar(overrides = {}) {
		return render(
			<ToolbarControls
				theme={inputAreaTheme}
				capabilities={AI_CAPABILITIES}
				isTerminalMode={false}
				agentId="claude-code"
				hasStandardCapability
				permissionMode="full"
				onPermissionModeChange={vi.fn()}
				onThinkingModeChange={vi.fn()}
				enterToSend
				setEnterToSend={vi.fn()}
				setStagedImages={vi.fn()}
				onOpenPromptComposer={vi.fn()}
				shortcuts={{ openPromptComposer: { keys: ['Meta', 'p'], description: '' } as any }}
				showFlashNotification={vi.fn()}
				tabSaveToHistory={false}
				onToggleTabSaveToHistory={vi.fn()}
				tabShowThinking="off"
				onToggleTabShowThinking={vi.fn()}
				availableModels={[]}
				availableEfforts={[]}
				modelMenuOpen={false}
				setModelMenuOpen={vi.fn()}
				modelMenuRef={{ current: null }}
				effortMenuOpen={false}
				setEffortMenuOpen={vi.fn()}
				effortMenuRef={{ current: null }}
				{...overrides}
			/>
		);
	}

	it('renders terminal cwd in terminal mode', () => {
		renderToolbar({
			capabilities: TERMINAL_CAPABILITIES,
			isTerminalMode: true,
			terminalCwd: '~/project/src',
		});

		expect(screen.getByText('~/project/src')).toBeInTheDocument();
	});

	it('opens prompt composer and the image file picker', () => {
		const onOpenPromptComposer = vi.fn();
		const { container } = renderToolbar({ onOpenPromptComposer });
		const fileInput = container.querySelector('#image-file-input') as HTMLInputElement;
		const click = vi.spyOn(fileInput, 'click');

		fireEvent.click(screen.getByTitle(/Open Prompt Composer/));
		fireEvent.click(screen.getByTitle('Attach Image'));

		expect(onOpenPromptComposer).toHaveBeenCalled();
		expect(click).toHaveBeenCalled();
	});

	it('toggles history, permission mode, thinking, and enter-to-send controls', () => {
		const onToggleTabSaveToHistory = vi.fn();
		const onToggleTabShowThinking = vi.fn();
		const setEnterToSend = vi.fn();
		const onPermissionModeChange = vi.fn();
		renderToolbar({
			onPermissionModeChange,
			onToggleTabSaveToHistory,
			onToggleTabShowThinking,
			setEnterToSend,
		});

		fireEvent.click(screen.getByTitle(/Save to History/));
		// Permission mode starts at 'full'; clicking cycles it to 'standard'.
		fireEvent.click(screen.getByTitle(/^Full Access/));
		fireEvent.click(screen.getByTitle(/Show Thinking/));
		fireEvent.click(screen.getByTitle(/Switch to/));

		expect(onToggleTabSaveToHistory).toHaveBeenCalled();
		expect(onToggleTabShowThinking).toHaveBeenCalled();
		expect(setEnterToSend).toHaveBeenCalledWith(false);

		expect(onPermissionModeChange).toHaveBeenCalledWith('standard');
	});

	it('hides AI-only controls in terminal mode', () => {
		renderToolbar({
			capabilities: TERMINAL_CAPABILITIES,
			isTerminalMode: true,
			onOpenPromptComposer: undefined,
		});

		expect(screen.queryByTitle(/Open Prompt Composer/)).not.toBeInTheDocument();
		expect(screen.queryByTitle('Attach Image')).not.toBeInTheDocument();
		expect(screen.queryByTitle(/Save to History/)).not.toBeInTheDocument();
	});

	it('hides each optional control its capability turns off', () => {
		renderToolbar({
			capabilities: {
				...AI_CAPABILITIES,
				imageAttach: false,
				saveToHistory: false,
				permission: false,
				thinking: false,
			},
		});

		expect(screen.queryByTitle('Attach Image')).not.toBeInTheDocument();
		expect(screen.queryByTitle(/Save to History/)).not.toBeInTheDocument();
		expect(screen.queryByTitle(/^Full Access/)).not.toBeInTheDocument();
		expect(screen.queryByTitle(/Show Thinking/)).not.toBeInTheDocument();
		// Still offered: the prompt composer and the Enter toggle have no flag.
		expect(screen.getByTitle(/Open Prompt Composer/)).toBeInTheDocument();
		expect(screen.getByTitle(/Switch to/)).toBeInTheDocument();
	});

	it('draws toolbarExtras in the toggle group, before the Enter toggle', () => {
		renderToolbar({ toolbarExtras: <button>Extra</button> });

		const extra = screen.getByRole('button', { name: 'Extra' });
		const enterToggle = screen.getByTitle(/Switch to/);
		expect(extra.parentElement).toBe(enterToggle.parentElement);
		expect(extra.nextElementSibling).toBe(enterToggle);
	});

	describe('phone layout', () => {
		function renderPhoneToolbar(overrides = {}) {
			mockedUsePhoneLayout.mockReturnValue(true);
			return renderToolbar({
				processInput: vi.fn(),
				availableModels: ['gpt-5', 'gpt-5-mini'],
				availableEfforts: ['', 'low', 'high'],
				onModelChange: vi.fn(),
				onEffortChange: vi.fn(),
				...overrides,
			});
		}

		it('keeps image, send, and the options button on one row', () => {
			renderPhoneToolbar();

			expect(screen.getByTitle('Attach Image')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
			expect(screen.getByTestId('composer-options-button')).toBeInTheDocument();
		});

		it('drops the prompt composer and every inline toggle pill', () => {
			// They live in the options sheet now; a 390px row cannot hold them and
			// the pencil opens a surface that does not belong on a phone composer.
			renderPhoneToolbar();

			expect(screen.queryByTitle(/Open Prompt Composer/)).not.toBeInTheDocument();
			expect(screen.queryByTitle(/Save to History/)).not.toBeInTheDocument();
			expect(screen.queryByTitle(/^Full Access/)).not.toBeInTheDocument();
			expect(screen.queryByTitle(/Show Thinking/)).not.toBeInTheDocument();
			expect(screen.queryByTitle(/Switch to/)).not.toBeInTheDocument();
			expect(screen.queryByTitle('Change model')).not.toBeInTheDocument();
			expect(screen.queryByTitle('Change effort level')).not.toBeInTheDocument();
		});

		it('sends from the toolbar row', () => {
			const processInput = vi.fn();
			renderPhoneToolbar({ processInput });

			fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
			expect(processInput).toHaveBeenCalled();
		});

		it('opens the options sheet from the ... button', () => {
			renderPhoneToolbar();
			expect(screen.queryByTestId('composer-options-sheet')).not.toBeInTheDocument();

			fireEvent.click(screen.getByTestId('composer-options-button'));
			expect(screen.getByTestId('composer-options-sheet')).toBeInTheDocument();
			expect(screen.getByTestId('composer-options-model')).toBeInTheDocument();
		});

		it('writes a permission mode picked in the sheet, not the next one in the cycle', () => {
			const onPermissionModeChange = vi.fn();
			renderPhoneToolbar({ onPermissionModeChange });

			fireEvent.click(screen.getByTestId('composer-options-button'));
			fireEvent.click(screen.getByTestId('composer-options-access'));
			// Starts at 'full'; the cycle's next step is 'standard', so picking
			// 'readonly' proves the sheet names a mode rather than stepping.
			fireEvent.click(screen.getByRole('button', { name: /Read Only|Plan/ }));

			expect(onPermissionModeChange).toHaveBeenLastCalledWith('readonly');
		});

		it('writes a thinking mode picked in the sheet', () => {
			const onThinkingModeChange = vi.fn();
			renderPhoneToolbar({ onThinkingModeChange });

			fireEvent.click(screen.getByTestId('composer-options-button'));
			fireEvent.click(screen.getByTestId('composer-options-thinking'));
			fireEvent.click(screen.getByRole('button', { name: 'Sticky' }));

			expect(onThinkingModeChange).toHaveBeenLastCalledWith('sticky');
		});

		it('draws the ... in terminal mode with no sheet behind it, as before', () => {
			// Terminal mode offers no sheet section, so nothing mounts behind the
			// button (AI mode is covered by "opens the options sheet" above).
			renderPhoneToolbar({
				capabilities: TERMINAL_CAPABILITIES,
				isTerminalMode: true,
				terminalCwd: '~/project',
			});

			fireEvent.click(screen.getByTestId('composer-options-button'));
			expect(screen.queryByTestId('composer-options-sheet')).not.toBeInTheDocument();
		});

		it('leaves out the sheet sections the surface does not offer', () => {
			renderPhoneToolbar({
				capabilities: { ...TERMINAL_CAPABILITIES, saveToHistory: true },
			});

			fireEvent.click(screen.getByTestId('composer-options-button'));
			expect(screen.getByTestId('composer-options-history')).toBeInTheDocument();
			expect(screen.queryByTestId('composer-options-access')).not.toBeInTheDocument();
			expect(screen.queryByTestId('composer-options-thinking')).not.toBeInTheDocument();
			expect(screen.queryByTestId('composer-options-model')).not.toBeInTheDocument();
		});

		it('draws no "..." when the sheet would be empty', () => {
			renderPhoneToolbar({ capabilities: TERMINAL_CAPABILITIES });

			expect(screen.queryByTestId('composer-options-button')).not.toBeInTheDocument();
		});

		it('mounts the sheet for surface rows alone, drawn after the sections', () => {
			renderPhoneToolbar({
				capabilities: TERMINAL_CAPABILITIES,
				sheetExtras: <div data-testid="surface-row">Surface</div>,
			});

			fireEvent.click(screen.getByTestId('composer-options-button'));
			expect(screen.getByTestId('surface-row')).toBeInTheDocument();
			expect(screen.queryByTestId('composer-options-history')).not.toBeInTheDocument();
		});

		it('takes the Send title, disabled state and tone from the surface', () => {
			const processInput = vi.fn();
			const { rerender } = renderPhoneToolbar({
				processInput,
				sendTitle: 'Queue message',
				sendDisabled: true,
			});
			const send = screen.getByRole('button', { name: 'Queue message' });
			expect(send).toBeDisabled();
			expect(send).toHaveStyle({ backgroundColor: inputAreaTheme.colors.border });
			fireEvent.click(send);
			expect(processInput).not.toHaveBeenCalled();

			rerender(
				<ToolbarControls
					theme={inputAreaTheme}
					capabilities={AI_CAPABILITIES}
					isTerminalMode={false}
					enterToSend
					setEnterToSend={vi.fn()}
					setStagedImages={vi.fn()}
					processInput={processInput}
					sendTitle="Queue message"
					sendTone="warning"
				/>
			);
			expect(screen.getByRole('button', { name: 'Queue message' })).toHaveStyle({
				backgroundColor: inputAreaTheme.colors.warning,
			});
		});

		it('renders exactly one image file input', () => {
			// The attach buttons reach it by ref; one input per toolbar.
			const { container } = renderPhoneToolbar();
			expect(container.querySelectorAll('#image-file-input')).toHaveLength(1);
		});
	});

	describe('voice input mic button', () => {
		it('shows the mic on coarse pointers when speech is supported and toggles it', () => {
			setCoarsePointer(true);
			const onToggleVoiceInput = vi.fn();
			renderToolbar({ voiceSupported: true, onToggleVoiceInput });

			const mic = screen.getByRole('button', { name: 'Start voice input' });
			expect(mic).toBeInTheDocument();
			expect(mic).toHaveAttribute('aria-pressed', 'false');

			fireEvent.click(mic);
			expect(onToggleVoiceInput).toHaveBeenCalled();
		});

		it('reflects the listening state via aria-pressed and title', () => {
			setCoarsePointer(true);
			renderToolbar({ voiceSupported: true, onToggleVoiceInput: vi.fn(), isVoiceListening: true });

			const mic = screen.getByRole('button', { name: 'Stop voice input' });
			expect(mic).toHaveAttribute('aria-pressed', 'true');
		});

		it('hides the mic on fine (mouse) pointers even when supported', () => {
			setCoarsePointer(false);
			renderToolbar({ voiceSupported: true, onToggleVoiceInput: vi.fn() });

			expect(screen.queryByRole('button', { name: /voice input/ })).not.toBeInTheDocument();
		});

		it('hides the mic when speech recognition is unsupported', () => {
			setCoarsePointer(true);
			renderToolbar({ voiceSupported: false, onToggleVoiceInput: vi.fn() });

			expect(screen.queryByRole('button', { name: /voice input/ })).not.toBeInTheDocument();
		});

		it('hides the mic in terminal mode', () => {
			setCoarsePointer(true);
			renderToolbar({
				capabilities: TERMINAL_CAPABILITIES,
				isTerminalMode: true,
				voiceSupported: true,
				onToggleVoiceInput: vi.fn(),
			});

			expect(screen.queryByRole('button', { name: /voice input/ })).not.toBeInTheDocument();
		});
	});
});

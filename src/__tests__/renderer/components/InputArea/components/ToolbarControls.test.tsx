import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolbarControls } from '../../../../../renderer/components/InputArea/components/ToolbarControls';
import { usePhoneLayout } from '../../../../../renderer/hooks/ui/useViewportBreakpoint';
import { inputAreaTheme } from '../_fixtures';
import { AGENT_CAPABILITIES } from '../../../../../shared/maestro-lib/providers/capabilities';
import { restorePointer, setCoarsePointer } from '../../../../helpers/mockPointer';
import {
	resetDictationStore,
	useDictationStore,
} from '../../../../../renderer/stores/dictationStore';
import type { DictationTarget } from '../../../../../renderer/utils/dictationTargets';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { isWebDesktop } from '../../../../../renderer/utils/runtimeContext';
import { useOptionalContentFits } from '../../../../../renderer/hooks/ui/useOptionalLabelFits';

vi.mock('../../../../../renderer/hooks/ui/useOptionalLabelFits', () => ({
	useOptionalContentFits: vi.fn(() => true),
}));

vi.mock('../../../../../renderer/utils/runtimeContext', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../../renderer/utils/runtimeContext')>()),
	isWebDesktop: vi.fn(() => false),
}));
import {
	GROUP_CHAT_COMPOSER_CAPABILITIES,
	type ComposerCapabilities,
} from '../../../../../renderer/components/ChatComposer';

/** An AI-mode agent that supports every optional control. */
const AI_CAPABILITIES: ComposerCapabilities = {
	imageAttach: true,
	upload: false,
	voice: true,
	saveToHistory: true,
	permission: true,
	thinking: true,
	modelEffort: true,
	enterToSendToggle: false,
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
	// Terminal mode draws no pills, so its row keeps the Enter toggle.
	enterToSendToggle: true,
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
		vi.mocked(isWebDesktop).mockReturnValue(false);
		vi.mocked(useOptionalContentFits).mockReturnValue(true);
		useSettingsStore.setState({ localModelEndpoints: [] });
	});

	function renderToolbar(overrides: Partial<React.ComponentProps<typeof ToolbarControls>> = {}) {
		const props: React.ComponentProps<typeof ToolbarControls> = {
			agentId: 'claude-code',
			capabilities: AI_CAPABILITIES,
			permissionMode: 'full',
			onPermissionModeChange: vi.fn(),
			onThinkingModeChange: vi.fn(),
			theme: inputAreaTheme,
			isTerminalMode: false,
			hasStandardCapability: true,
			enterToSend: true,
			setEnterToSend: vi.fn(),
			setStagedImages: vi.fn(),
			onOpenPromptComposer: vi.fn(),
			shortcuts: { openPromptComposer: { keys: ['Meta', 'p'], description: '' } },
			showFlashNotification: vi.fn(),
			tabSaveToHistory: false,
			onToggleTabSaveToHistory: vi.fn(),
			tabShowThinking: 'off',
			onToggleTabShowThinking: vi.fn(),
			availableModels: [],
			availableEfforts: [],
			modelMenuOpen: false,
			setModelMenuOpen: vi.fn(),
			modelMenuRef: { current: null },
			effortMenuOpen: false,
			setEffortMenuOpen: vi.fn(),
			effortMenuRef: { current: null },
			...overrides,
		};
		const view = render(<ToolbarControls {...props} />);
		return {
			...view,
			rerenderToolbar: (next: Partial<typeof props>) =>
				view.rerender(<ToolbarControls {...props} {...next} />),
		};
	}

	it.each([false, true])(
		'omits provider switching with a legacy saved flag on phone=%s',
		(phone) => {
			mockedUsePhoneLayout.mockReturnValue(phone);
			useSettingsStore.setState((state) => ({
				encoreFeatures: { ...state.encoreFeatures, ensemble: true },
			}));
			renderToolbar();
			if (phone) fireEvent.click(screen.getByRole('button', { name: 'More options' }));
			expect(
				screen.queryByRole('button', { name: /Provider for this tab/ })
			).not.toBeInTheDocument();
			expect(screen.queryByTestId('composer-options-provider')).not.toBeInTheDocument();
		}
	);

	it('keeps Run on configuration out of the desktop quick model picker', () => {
		renderToolbar({
			modelMenuOpen: true,
			availableModels: ['gpt-5'],
			onModelChange: vi.fn(),
		});
		expect(screen.getByPlaceholderText('Filter models...')).toBeInTheDocument();
		expect(screen.queryByTestId('composer-run-on')).not.toBeInTheDocument();
		expect(screen.queryByText('Run on')).not.toBeInTheDocument();
	});

	it.each([false, true])('shows the effective Run on target on phone=%s', (phone) => {
		// InputArea resolves the label from the tab's provider projection
		// (useComposerModelChoices); the toolbar shows it in place of the model.
		mockedUsePhoneLayout.mockReturnValue(phone);
		renderToolbar({
			runOn: 'deepseek-v4.1-flash:cloud · Ollama',
			currentModel: 'opus[1m]',
			availableModels: ['opus[1m]', 'sonnet'],
			onModelChange: vi.fn(),
		});
		if (phone) fireEvent.click(screen.getByRole('button', { name: 'More options' }));

		expect(screen.getByText('deepseek-v4.1-flash:cloud · Ollama')).toBeInTheDocument();
		expect(screen.queryByText('opus[1m]')).not.toBeInTheDocument();
	});

	it('shows the Auto pill when no Run on target replaces it', () => {
		renderToolbar({
			currentModel: 'auto',
			availableModels: ['auto', 'opus[1m]'],
			onModelChange: vi.fn(),
		});

		expect(screen.getByRole('button', { name: 'Auto' })).toBeInTheDocument();
	});

	it('reads the permission label in the words of the provider it is given', () => {
		renderToolbar({ agentId: 'codex', permissionMode: 'readonly' });
		expect(screen.getByRole('button', { name: 'Read-Only' })).toBeInTheDocument();
		expect(screen.getByText('Read-Only')).toBeInTheDocument();
	});

	describe('dictation', () => {
		const dictationTarget: DictationTarget = { getElement: () => null, insert: () => true };

		afterEach(() => resetDictationStore());

		it('draws no dictation microphone while the dictation task is off', () => {
			renderToolbar({ dictationTarget });
			expect(screen.queryByTestId('composer-dictation-button')).toBeNull();
		});

		it('draws the dictation microphone once the task is ready', () => {
			useDictationStore.setState({ availability: { state: 'ready', source: 'Parakeet' } });
			renderToolbar({ dictationTarget });
			expect(screen.getByTestId('composer-dictation-button')).toBeInTheDocument();
		});

		it('draws none when the surface passes no target (the AI composer in terminal mode)', () => {
			useDictationStore.setState({ availability: { state: 'ready', source: 'Parakeet' } });
			renderToolbar({ capabilities: TERMINAL_CAPABILITIES, isTerminalMode: true });
			expect(screen.queryByTestId('composer-dictation-button')).toBeNull();
		});
	});

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

	it.each([true, false])('keeps toolbar actions available when labels fit=%s', (labelsFit) => {
		vi.mocked(useOptionalContentFits).mockReturnValue(labelsFit);
		const onToggleTabSaveToHistory = vi.fn();
		const onToggleTabShowThinking = vi.fn();
		const onPermissionModeChange = vi.fn();
		renderToolbar({
			onPermissionModeChange,
			onToggleTabSaveToHistory,
			onToggleTabShowThinking,
		});

		const history = screen.getByRole('button', { name: 'Save to History: off' });
		const thinking = screen.getByRole('button', { name: 'Thinking: off' });
		expect(history).toHaveAttribute('aria-pressed', 'false');
		expect(thinking).toHaveAttribute('aria-pressed', 'false');
		fireEvent.click(history);
		// Permission mode starts at 'full'; clicking cycles it to 'standard'.
		fireEvent.click(screen.getByRole('button', { name: 'Full Access' }));
		fireEvent.click(thinking);

		expect(onToggleTabSaveToHistory).toHaveBeenCalled();
		expect(onToggleTabShowThinking).toHaveBeenCalled();
		expect(!!screen.queryByText('History')).toBe(labelsFit);
		expect(!!screen.queryByText('Full Access')).toBe(labelsFit);
		expect(!!screen.queryByText('Thinking')).toBe(labelsFit);
		expect(screen.queryByTitle(/Switch to/)).not.toBeInTheDocument();

		expect(onPermissionModeChange).toHaveBeenCalledWith('standard');
	});

	it('exposes active history and sticky thinking states to assistive technology', () => {
		renderToolbar({ tabSaveToHistory: true, tabShowThinking: 'sticky' });
		expect(screen.getByRole('button', { name: 'Save to History: on' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		expect(screen.getByRole('button', { name: 'Thinking: sticky' })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
	});

	it('keeps image attachment in the browser without a separate file upload control', () => {
		vi.mocked(isWebDesktop).mockReturnValue(true);
		renderToolbar();
		expect(screen.getByTitle('Upload Image to Host')).toBeInTheDocument();
		expect(screen.queryByLabelText('Upload local files to the host')).not.toBeInTheDocument();
		expect(
			screen.queryByLabelText('Choose local files to upload to the host')
		).not.toBeInTheDocument();
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

	describe('Grok permission interactions', () => {
		it.each(['desktop', 'phone'] as const)(
			'offers Standard for Grok on %s and emits the selected permission mode',
			(layout) => {
				// A local Grok tab reaches the ACP route through Standard.
				expect(AGENT_CAPABILITIES.grok.supportsStandardPermissionMode).toBe(true);
				mockedUsePhoneLayout.mockReturnValue(layout === 'phone');
				const onPermissionModeChange = vi.fn();
				renderToolbar({
					agentId: 'grok',
					onPermissionModeChange,
					capabilities: {
						...AI_CAPABILITIES,
						permission: AGENT_CAPABILITIES.grok.supportsReadOnlyMode,
					},
					hasStandardCapability: AGENT_CAPABILITIES.grok.supportsStandardPermissionMode ?? false,
				});
				if (layout === 'phone') {
					fireEvent.click(screen.getByRole('button', { name: 'More options' }));
					fireEvent.click(screen.getByTestId('composer-options-access'));
					fireEvent.click(screen.getByRole('button', { name: 'Standard' }));
				} else {
					// The desktop pill cycles full -> standard.
					fireEvent.click(screen.getByRole('button', { name: 'Full Access' }));
				}
				expect(onPermissionModeChange).toHaveBeenCalledExactlyOnceWith('standard');
			}
		);

		it.each([
			['desktop', 'full'],
			['desktop', 'standard'],
			['phone', 'full'],
			['phone', 'standard'],
		] as const)(
			'still normalizes a stale Standard value for a Grok build without the capability on %s from %s',
			(layout, mode) => {
				mockedUsePhoneLayout.mockReturnValue(layout === 'phone');
				const onPermissionModeChange = vi.fn();
				// The capability is forced off here: this pins the normalization for any agent
				// that lacks it, not Grok's current declaration (offered above).
				const { rerenderToolbar } = renderToolbar({
					agentId: 'grok',
					onPermissionModeChange,
					capabilities: {
						...AI_CAPABILITIES,
						permission: AGENT_CAPABILITIES.grok.supportsReadOnlyMode,
					},
					hasStandardCapability: false,
					permissionMode: mode,
				});
				if (layout === 'phone') {
					fireEvent.click(screen.getByRole('button', { name: 'More options' }));
					expect(screen.getByTestId('composer-options-access')).toHaveTextContent('Full Access');
					fireEvent.click(screen.getByTestId('composer-options-access'));
				}
				// A stale Standard value is normalized for display without a render-time write.
				expect(screen.getByRole('button', { name: 'Full Access' })).toBeInTheDocument();
				expect(onPermissionModeChange).not.toHaveBeenCalled();
				for (const [index, nextMode] of (['readonly', 'full'] as const).entries()) {
					expect(screen.queryByRole('button', { name: /Standard|ACP/ })).not.toBeInTheDocument();
					const label =
						layout === 'phone'
							? nextMode === 'readonly'
								? 'Read-Only'
								: 'Full Access'
							: nextMode === 'readonly'
								? 'Full Access'
								: 'Read-Only';
					fireEvent.click(screen.getByRole('button', { name: label }));
					expect(onPermissionModeChange).toHaveBeenNthCalledWith(index + 1, nextMode);
					rerenderToolbar({ permissionMode: nextMode });
					if (layout === 'phone') {
						expect(screen.getByTestId('composer-options-access')).toHaveTextContent(
							nextMode === 'readonly' ? 'Read-Only' : 'Full Access'
						);
					} else {
						expect(
							screen.getByRole('button', {
								name: nextMode === 'readonly' ? 'Read-Only' : 'Full Access',
							})
						).toBeInTheDocument();
					}
				}
				expect(screen.queryByRole('button', { name: /Standard|ACP/ })).not.toBeInTheDocument();
			}
		);

		it.each(['desktop', 'phone'] as const)(
			'hides unavailable Grok access controls on %s',
			(layout) => {
				const onPermissionModeChange = vi.fn();
				mockedUsePhoneLayout.mockReturnValue(layout === 'phone');
				renderToolbar({
					agentId: 'grok',
					onPermissionModeChange,
					capabilities: { ...AI_CAPABILITIES, permission: false },
					hasStandardCapability: AGENT_CAPABILITIES.grok.supportsStandardPermissionMode ?? false,
				});
				if (layout === 'phone')
					fireEvent.click(screen.getByRole('button', { name: 'More options' }));
				expect(screen.queryByTestId('composer-options-access')).not.toBeInTheDocument();
				expect(
					screen.queryByRole('button', { name: /Full Access|Read-Only|Standard|ACP/ })
				).not.toBeInTheDocument();
				expect(onPermissionModeChange).not.toHaveBeenCalled();
			}
		);
	});

	it('keeps desktop layout unchanged in terminal mode with cwd and Enter toggle', () => {
		renderToolbar({
			capabilities: TERMINAL_CAPABILITIES,
			isTerminalMode: true,
			terminalCwd: '~/project/src',
			onOpenPromptComposer: undefined,
			enterToSend: true,
		});

		expect(screen.getByText('~/project/src')).toBeInTheDocument();
		expect(screen.getByTitle(/Switch to .*Enter to send/)).toBeInTheDocument();
		expect(screen.getByText('Enter')).toBeInTheDocument();
		expect(screen.queryByTestId('composer-options-button')).not.toBeInTheDocument();
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
		// Still offered: the prompt composer has no flag.
		expect(screen.getByTitle(/Open Prompt Composer/)).toBeInTheDocument();
	});

	it('draws the Enter toggle only for a surface that offers it, and flips it', () => {
		const setEnterToSend = vi.fn();
		const { unmount } = renderToolbar({ setEnterToSend });
		// The AI composer leaves Enter-to-send to Settings.
		expect(screen.queryByTitle(/Switch to/)).not.toBeInTheDocument();
		unmount();

		renderToolbar({
			capabilities: { ...AI_CAPABILITIES, enterToSendToggle: true },
			setEnterToSend,
		});
		fireEvent.click(screen.getByTitle(/Switch to/));
		expect(setEnterToSend).toHaveBeenCalledWith(false);
	});

	it('draws toolbarExtras beside the Enter toggle, before it', () => {
		renderToolbar({
			capabilities: { ...AI_CAPABILITIES, enterToSendToggle: true },
			toolbarExtras: <button>Extra</button>,
		});

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

		it('draws no "..." or sheet in terminal mode, keeping the cwd and Run command button', () => {
			renderPhoneToolbar({
				capabilities: TERMINAL_CAPABILITIES,
				isTerminalMode: true,
				terminalCwd: '~/project',
			});

			expect(screen.queryByTestId('composer-options-button')).not.toBeInTheDocument();
			expect(screen.queryByTestId('composer-options-sheet')).not.toBeInTheDocument();
			expect(screen.getByText('~/project')).toBeInTheDocument();
			expect(screen.getByRole('button', { name: 'Run command' })).toBeInTheDocument();
		});

		it('still shows the "..." and opens the sheet in a room with sheet content', () => {
			renderPhoneToolbar({
				capabilities: GROUP_CHAT_COMPOSER_CAPABILITIES,
				sheetExtras: <div data-testid="room-readonly-row">Read-Only</div>,
			});

			expect(screen.getByTestId('composer-options-button')).toBeInTheDocument();
			fireEvent.click(screen.getByTestId('composer-options-button'));
			expect(screen.getByTestId('composer-options-sheet')).toBeInTheDocument();
			expect(screen.getByTestId('room-readonly-row')).toBeInTheDocument();
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

	// InputArea adds Auto where it can act (useComposerModelChoices); the toolbar
	// lists what it is given, the same in the desktop pill and the phone sheet.
	describe('the Auto model choice', () => {
		const AUTO_TITLE = 'Auto: picks the model and the effort for each turn. Decided by System One.';

		function renderWithModels(overrides = {}) {
			return renderToolbar({
				availableModels: ['', 'auto', 'opus', 'sonnet'],
				autoModelTitle: AUTO_TITLE,
				onModelChange: vi.fn(),
				modelMenuOpen: true,
				...overrides,
			});
		}

		it('lists Auto in the model menu with its tooltip, and picks it', () => {
			const onModelChange = vi.fn();
			renderWithModels({ onModelChange });

			const row = screen.getByText('Auto').closest('button')!;
			expect(row.getAttribute('title')).toBe(AUTO_TITLE);
			const rows = Array.from(row.parentElement!.querySelectorAll('button')).map(
				(b) => b.textContent
			);
			expect(rows).toEqual(['(default)', 'Auto', 'opus', 'sonnet']);

			fireEvent.click(row);
			expect(onModelChange).toHaveBeenCalledWith('auto');
		});

		it('says on the pill who decides while Auto is the model', () => {
			renderWithModels({ currentModel: 'auto', modelMenuOpen: false });

			const pill = screen.getByText('Auto').closest('button')!;
			expect(pill.getAttribute('title')).toContain(AUTO_TITLE);
		});

		it('lists the same Auto in the phone options sheet', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			const onModelChange = vi.fn();
			renderWithModels({ processInput: vi.fn(), onModelChange, modelMenuOpen: false });

			fireEvent.click(screen.getByTestId('composer-options-button'));
			fireEvent.click(screen.getByTestId('composer-options-model'));
			const row = screen.getByRole('button', { name: /^Auto/ });
			// The tooltip has no hover on a phone: it is the row's description.
			expect(row).toHaveTextContent('Auto: picks the model and the effort for each turn.');

			fireEvent.click(row);
			expect(onModelChange).toHaveBeenCalledWith('auto');
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

		it('hides the mic when A Cappella owns it, so there is never a second one', () => {
			// A Cappella's microphone lives under Send, where it shows on every
			// pointer type. Without this gate a touch device with the Encore Feature
			// on would draw two microphones wired to the same toggle.
			setCoarsePointer(true);
			renderToolbar({
				voiceSupported: true,
				onToggleVoiceInput: vi.fn(),
				voiceHandledElsewhere: true,
			});

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

	describe('layout', () => {
		it('pins the pill row to the bottom of the composer box', () => {
			// The A Cappella microphone makes the Send column taller than the
			// textarea, so the composer box stretches and the pills would otherwise
			// float mid-height with dead space beneath them. jsdom has no layout
			// engine, so the margin class is the only thing there is to assert.
			const { container } = renderToolbar();

			expect(container.firstElementChild).toHaveClass('mt-auto');
		});
	});
});

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolbarControls } from '../../../../../renderer/components/InputArea/components/ToolbarControls';
import { usePhoneLayout } from '../../../../../renderer/hooks/ui/useViewportBreakpoint';
import { createInputAreaSession, inputAreaTheme } from '../_fixtures';
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

const mockUpdateSessionWith = vi.fn();
vi.mock('../../../../../renderer/stores/sessionStore', () => ({
	updateSessionWith: (...args: unknown[]) => mockUpdateSessionWith(...args),
}));

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
		mockUpdateSessionWith.mockClear();
		mockedUsePhoneLayout.mockReturnValue(false);
		vi.mocked(isWebDesktop).mockReturnValue(false);
		vi.mocked(useOptionalContentFits).mockReturnValue(true);
	});

	function renderToolbar(overrides = {}) {
		return render(
			<ToolbarControls
				session={createInputAreaSession()}
				theme={inputAreaTheme}
				isTerminalMode={false}
				isReadOnlyMode={false}
				canAttachImages
				hasReadOnlyCapability
				hasStandardCapability
				setStagedImages={vi.fn()}
				onOpenPromptComposer={vi.fn()}
				shortcuts={{ openPromptComposer: { keys: ['Meta', 'p'], description: '' } as any }}
				showFlashNotification={vi.fn()}
				tabSaveToHistory={false}
				onToggleTabSaveToHistory={vi.fn()}
				tabShowThinking="off"
				onToggleTabShowThinking={vi.fn()}
				supportsThinking
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

	it('uses the selected tab provider for permission labels', () => {
		const session = createInputAreaSession();
		session.toolType = 'claude-code';
		session.aiTabs = [
			{ ...session.aiTabs[0], id: session.activeTabId, tabProvider: 'codex', readOnlyMode: true },
		];
		renderToolbar({ session });
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

		it('draws none in terminal mode, where the composer is a shell line', () => {
			useDictationStore.setState({ availability: { state: 'ready', source: 'Parakeet' } });
			renderToolbar({
				dictationTarget,
				isTerminalMode: true,
				session: createInputAreaSession({ inputMode: 'terminal' }),
			});
			expect(screen.queryByTestId('composer-dictation-button')).toBeNull();
		});
	});

	it('renders terminal cwd in terminal mode', () => {
		renderToolbar({
			session: createInputAreaSession({
				inputMode: 'terminal',
				shellCwd: '/Users/test/project/src',
			}),
			isTerminalMode: true,
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
		const session = createInputAreaSession();
		renderToolbar({
			session,
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

		expect(mockUpdateSessionWith).toHaveBeenCalledWith(session.id, expect.any(Function));
		const updater = mockUpdateSessionWith.mock.calls[0][1];
		const updatedSession = updater(session);
		const updatedTab = updatedSession.aiTabs.find((t: { id: string }) => t.id === 'tab-1');
		expect(updatedTab.permissionMode).toBe('standard');
		expect(updatedTab.readOnlyMode).toBe(false);
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
			session: createInputAreaSession({ inputMode: 'terminal' }),
			isTerminalMode: true,
		});

		expect(screen.queryByTitle(/Open Prompt Composer/)).not.toBeInTheDocument();
		expect(screen.queryByTitle('Attach Image')).not.toBeInTheDocument();
		expect(screen.queryByTitle(/Save to History/)).not.toBeInTheDocument();
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
			const session = createInputAreaSession();
			renderPhoneToolbar({ session });

			fireEvent.click(screen.getByTestId('composer-options-button'));
			fireEvent.click(screen.getByTestId('composer-options-access'));
			// Starts at 'full'; the cycle's next step is 'standard', so picking
			// 'readonly' proves the sheet names a mode rather than stepping.
			fireEvent.click(screen.getByRole('button', { name: /Read Only|Plan/ }));

			const updater = mockUpdateSessionWith.mock.calls.at(-1)![1];
			const updatedTab = updater(session).aiTabs.find((t: { id: string }) => t.id === 'tab-1');
			expect(updatedTab.permissionMode).toBe('readonly');
			expect(updatedTab.readOnlyMode).toBe(true);
		});

		it('writes a thinking mode picked in the sheet', () => {
			const session = createInputAreaSession();
			renderPhoneToolbar({ session });

			fireEvent.click(screen.getByTestId('composer-options-button'));
			fireEvent.click(screen.getByTestId('composer-options-thinking'));
			fireEvent.click(screen.getByRole('button', { name: 'Sticky' }));

			const updater = mockUpdateSessionWith.mock.calls.at(-1)![1];
			const updatedTab = updater(session).aiTabs.find((t: { id: string }) => t.id === 'tab-1');
			expect(updatedTab.showThinking).toBe('sticky');
		});

		it('renders exactly one image file input', () => {
			// The attach buttons reach it by ref; one input per toolbar.
			const { container } = renderPhoneToolbar();
			expect(container.querySelectorAll('#image-file-input')).toHaveLength(1);
		});
	});

	// Auto is added here, where the agent is known, so the desktop pill and the
	// phone sheet list the same thing.
	describe('the Auto model choice', () => {
		const AXES = 'Auto: picks the model and the effort for each turn.';

		beforeEach(() => {
			// The shipped defaults: no harness tier overrides, the model router off.
			useSettingsStore.setState({
				harnessTierDefaults: {},
				localModelAssignments: {},
				localModelEndpoints: [],
			});
		});

		function renderWithModels(overrides = {}) {
			return renderToolbar({
				availableModels: ['', 'opus', 'sonnet'],
				onModelChange: vi.fn(),
				modelMenuOpen: true,
				...overrides,
			});
		}

		it('offers Auto after (default) in the model menu of a Claude Code agent', () => {
			const onModelChange = vi.fn();
			renderWithModels({ onModelChange });

			const row = screen.getByText('Auto').closest('button')!;
			expect(row.getAttribute('title')).toContain(AXES);
			expect(row.getAttribute('title')).toContain('The model router is off');
			// Right after the leading (default) row, ahead of the provider's models.
			const rows = Array.from(row.parentElement!.querySelectorAll('button')).map(
				(b) => b.textContent
			);
			expect(rows).toEqual(['(default)', 'Auto', 'opus', 'sonnet']);

			fireEvent.click(row);
			expect(onModelChange).toHaveBeenCalledWith('auto');
		});

		it('offers no Auto for an agent it would change nothing for', () => {
			// OpenCode has no effort ladder Maestro can name, and none of this
			// agent's tiers is mapped to a model.
			renderWithModels({ session: createInputAreaSession({ toolType: 'opencode' }) });

			expect(screen.getByText('opus')).toBeInTheDocument();
			expect(screen.queryByText('Auto')).not.toBeInTheDocument();
		});

		it('offers Auto for that agent once one of its tiers is mapped', () => {
			renderWithModels({
				session: createInputAreaSession({
					toolType: 'opencode',
					tierTargets: { medium: { type: 'provider-model', model: 'opus' } },
				}),
			});

			expect(screen.getByText('Auto')).toBeInTheDocument();
		});

		it('says on the pill who decides while Auto is the model', () => {
			useSettingsStore.setState({
				localModelAssignments: { 'model-routing': { type: 'system-one' } },
			});
			renderWithModels({ currentModel: 'auto', modelMenuOpen: false });

			const pill = screen.getByText('Auto').closest('button')!;
			expect(pill.getAttribute('title')).toContain(`${AXES} Decided by System One.`);
		});

		it('lists the same Auto in the phone options sheet', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			const onModelChange = vi.fn();
			renderWithModels({ processInput: vi.fn(), onModelChange, modelMenuOpen: false });

			fireEvent.click(screen.getByTestId('composer-options-button'));
			fireEvent.click(screen.getByTestId('composer-options-model'));
			const row = screen.getByRole('button', { name: /^Auto/ });
			// The tooltip has no hover on a phone: it is the row's description.
			expect(row).toHaveTextContent(AXES);

			fireEvent.click(row);
			expect(onModelChange).toHaveBeenCalledWith('auto');
		});

		it('lists no Auto in the phone options sheet for an agent it would change nothing for', () => {
			mockedUsePhoneLayout.mockReturnValue(true);
			renderWithModels({
				processInput: vi.fn(),
				modelMenuOpen: false,
				session: createInputAreaSession({ toolType: 'opencode' }),
			});

			fireEvent.click(screen.getByTestId('composer-options-button'));
			fireEvent.click(screen.getByTestId('composer-options-model'));
			expect(screen.getByRole('button', { name: 'opus' })).toBeInTheDocument();
			expect(screen.queryByRole('button', { name: /^Auto/ })).not.toBeInTheDocument();
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
				session: createInputAreaSession({ inputMode: 'terminal' }),
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

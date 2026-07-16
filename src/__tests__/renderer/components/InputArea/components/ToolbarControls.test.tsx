import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolbarControls } from '../../../../../renderer/components/InputArea/components/ToolbarControls';
import { createInputAreaSession, inputAreaTheme } from '../_fixtures';

const mockUpdateSessionWith = vi.fn();
vi.mock('../../../../../renderer/stores/sessionStore', () => ({
	updateSessionWith: (...args: unknown[]) => mockUpdateSessionWith(...args),
}));

describe('ToolbarControls', () => {
	const originalMatchMedia = window.matchMedia;

	// isCoarsePointer() reads window.matchMedia('(pointer: coarse)'); drive it so
	// the touch-only mic button can be tested. jsdom has no matchMedia, so the
	// default (undefined) already yields a fine (non-coarse) pointer.
	function setCoarsePointer(coarse: boolean) {
		Object.defineProperty(window, 'matchMedia', {
			writable: true,
			configurable: true,
			value: (query: string) => ({
				matches: coarse,
				media: query,
				onchange: null,
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				addListener: vi.fn(),
				removeListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}),
		});
	}

	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(window, 'matchMedia', {
			writable: true,
			configurable: true,
			value: originalMatchMedia,
		});
		mockUpdateSessionWith.mockClear();
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

	it('opens prompt composer and triggers file input lookup', () => {
		const onOpenPromptComposer = vi.fn();
		const click = vi.fn();
		vi.spyOn(document, 'getElementById').mockReturnValue({ click } as any);
		renderToolbar({ onOpenPromptComposer });

		fireEvent.click(screen.getByTitle(/Open Prompt Composer/));
		fireEvent.click(screen.getByTitle('Attach Image'));

		expect(onOpenPromptComposer).toHaveBeenCalled();
		expect(document.getElementById).toHaveBeenCalledWith('image-file-input');
		expect(click).toHaveBeenCalled();
	});

	it('opens runtime details only after the user requests them', () => {
		renderToolbar({
			session: createInputAreaSession({
				runtimeFeatures: {
					controls: [],
					tree: [{ id: 'turn-1', label: 'OMP turn' }],
					todos: null,
					subagents: null,
					stats: null,
				},
			}),
		});

		expect(screen.queryByRole('dialog', { name: 'Session details' })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Open session details' }));
		expect(screen.getByRole('dialog', { name: 'Session details' })).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByRole('dialog', { name: 'Session details' })).not.toBeInTheDocument();
	});

	it('toggles history, permission mode, thinking, and enter-to-send controls', () => {
		const onToggleTabSaveToHistory = vi.fn();
		const onToggleTabShowThinking = vi.fn();
		const setEnterToSend = vi.fn();
		const session = createInputAreaSession();
		renderToolbar({
			session,
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

		expect(mockUpdateSessionWith).toHaveBeenCalledWith(session.id, expect.any(Function));
		const updater = mockUpdateSessionWith.mock.calls[0][1];
		const updatedSession = updater(session);
		const updatedTab = updatedSession.aiTabs.find((t: { id: string }) => t.id === 'tab-1');
		expect(updatedTab.permissionMode).toBe('standard');
		expect(updatedTab.readOnlyMode).toBe(false);
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
				session: createInputAreaSession({ inputMode: 'terminal' }),
				isTerminalMode: true,
				voiceSupported: true,
				onToggleVoiceInput: vi.fn(),
			});

			expect(screen.queryByRole('button', { name: /voice input/ })).not.toBeInTheDocument();
		});
	});
});

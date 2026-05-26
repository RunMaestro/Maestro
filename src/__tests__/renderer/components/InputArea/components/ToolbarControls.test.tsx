import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolbarControls } from '../../../../../renderer/components/InputArea/components/ToolbarControls';
import { createInputAreaSession, inputAreaTheme } from '../_fixtures';

describe('ToolbarControls', () => {
	afterEach(() => {
		vi.restoreAllMocks();
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
				enterToSend
				setEnterToSend={vi.fn()}
				setStagedImages={vi.fn()}
				onOpenPromptComposer={vi.fn()}
				shortcuts={{ openPromptComposer: { keys: ['Meta', 'p'], description: '' } as any }}
				showFlashNotification={vi.fn()}
				tabSaveToHistory={false}
				onToggleTabSaveToHistory={vi.fn()}
				onToggleTabReadOnlyMode={vi.fn()}
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

	it('toggles history, read-only, thinking, and enter-to-send controls', () => {
		const onToggleTabSaveToHistory = vi.fn();
		const onToggleTabReadOnlyMode = vi.fn();
		const onToggleTabShowThinking = vi.fn();
		const setEnterToSend = vi.fn();
		renderToolbar({
			onToggleTabSaveToHistory,
			onToggleTabReadOnlyMode,
			onToggleTabShowThinking,
			setEnterToSend,
		});

		fireEvent.click(screen.getByTitle(/Save to History/));
		fireEvent.click(screen.getByTitle(/Toggle plan mode/));
		fireEvent.click(screen.getByTitle(/Show Thinking/));
		fireEvent.click(screen.getByTitle(/Switch to/));

		expect(onToggleTabSaveToHistory).toHaveBeenCalled();
		expect(onToggleTabReadOnlyMode).toHaveBeenCalled();
		expect(onToggleTabShowThinking).toHaveBeenCalled();
		expect(setEnterToSend).toHaveBeenCalledWith(false);
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
});

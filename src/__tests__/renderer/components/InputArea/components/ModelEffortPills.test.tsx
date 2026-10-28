import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelEffortPills } from '../../../../../renderer/components/InputArea/components/ModelEffortPills';
import { inputAreaTheme } from '../_fixtures';
import { formatShortcutKeys } from '../../../../../renderer/utils/shortcutFormatter';
import { getShortcutKeys } from '../../../../helpers/shortcutKeys';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';

// Formatted through the real formatter rather than spelled out: the chord
// renders as '⌘X' on macOS and 'Ctrl+X' elsewhere, and hardcoding either makes
// the test pass on one platform's CI and fail on the other's.
const HINT_KEYS = ['Meta', 'x'];
const HINT_TEXT = `Try: ${formatShortcutKeys(HINT_KEYS)}`;
// The hint row: the chord is drawn as separate key caps, so find it by its keys.
const hintRow = () => getShortcutKeys(HINT_KEYS).closest('div') as HTMLElement;

describe('ModelEffortPills', () => {
	beforeEach(() => {
		useSettingsStore.setState({ modalSizes: {} });
	});
	function renderPills(overrides = {}) {
		return render(
			<ModelEffortPills
				isVisible
				theme={inputAreaTheme}
				currentModel="gpt-5"
				currentEffort="medium"
				availableModels={['gpt-5', 'gpt-5-mini']}
				availableEfforts={['', 'low', 'medium']}
				onModelChange={vi.fn()}
				onEffortChange={vi.fn()}
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

	it('renders nothing when not visible', () => {
		renderPills({ isVisible: false });

		expect(screen.queryByTitle('Change model')).not.toBeInTheDocument();
	});
	it('keeps Run on configuration out of the quick model menu', () => {
		renderPills({ modelMenuOpen: true });
		expect(screen.queryByText('Run on')).not.toBeInTheDocument();
		expect(screen.queryByTestId('composer-run-on')).not.toBeInTheDocument();
	});

	it('filters models without case or surrounding whitespace and selects a match', () => {
		const onModelChange = vi.fn();
		renderPills({ modelMenuOpen: true, onModelChange });
		fireEvent.change(screen.getByPlaceholderText('Filter models...'), {
			target: { value: ' MINI ' },
		});
		expect(
			within(screen.getByTestId('model-picker')).queryByRole('button', { name: 'gpt-5' })
		).not.toBeInTheDocument();
		expect(screen.queryByText('(default)')).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'gpt-5-mini' }));
		expect(onModelChange).toHaveBeenCalledWith('gpt-5-mini');
	});

	it('shows an empty result, then clears the filter before closing on Escape', () => {
		const setModelMenuOpen = vi.fn();
		renderPills({ modelMenuOpen: true, setModelMenuOpen });
		const input = screen.getByPlaceholderText('Filter models...');
		expect(input).toHaveFocus();
		fireEvent.change(input, { target: { value: 'missing-model' } });
		expect(screen.getByText('No matching models')).toBeInTheDocument();
		expect(screen.getByLabelText('Use a model ID that is not listed')).toBeInTheDocument();
		fireEvent.keyDown(input, { key: 'Escape' });
		expect(input).toHaveValue('');
		expect(setModelMenuOpen).not.toHaveBeenCalled();
		expect(screen.getByText('(default)')).toBeInTheDocument();
		fireEvent.keyDown(input, { key: 'Escape' });
		expect(setModelMenuOpen).toHaveBeenCalledWith(false);
	});

	it('resizes upward and rightward, remembers the size, and resets on double click', () => {
		const { unmount } = renderPills({ modelMenuOpen: true });
		const picker = screen.getByTestId('model-picker');
		const width = parseFloat(picker.style.width);
		const height = parseFloat(picker.style.height);
		expect(screen.queryByTestId('modal-resize-handle-s')).not.toBeInTheDocument();
		fireEvent.mouseDown(screen.getByTestId('modal-resize-handle-ne'), {
			clientX: 0,
			clientY: 0,
		});
		fireEvent.mouseMove(document, { clientX: 30, clientY: -20 });
		fireEvent.mouseUp(document);
		// Browsers emit a click after mouseup; consume the resize guard's one-shot listener.
		fireEvent.click(document);
		expect(picker).toHaveStyle({ width: `${width + 30}px`, height: `${height + 20}px` });
		unmount();
		renderPills({ modelMenuOpen: true });
		expect(screen.getByTestId('model-picker')).toHaveStyle({
			width: `${width + 30}px`,
			height: `${height + 20}px`,
		});
		fireEvent.doubleClick(screen.getByTestId('modal-resize-handle-ne'));
		expect(screen.getByTestId('model-picker')).toHaveStyle({
			width: `${width}px`,
			height: `${height}px`,
		});
	});

	it('opens model menu and closes effort menu when model pill is clicked', () => {
		const setModelMenuOpen = vi.fn();
		const setEffortMenuOpen = vi.fn();
		renderPills({ setModelMenuOpen, setEffortMenuOpen });

		fireEvent.click(screen.getByTitle('Change model'));

		expect(setModelMenuOpen).toHaveBeenCalledWith(true);
		expect(setEffortMenuOpen).toHaveBeenCalledWith(false);
	});

	it('renders default model option and selects a model', () => {
		const onModelChange = vi.fn();
		const setModelMenuOpen = vi.fn();
		renderPills({ modelMenuOpen: true, onModelChange, setModelMenuOpen });

		fireEvent.click(screen.getByText('gpt-5-mini'));

		expect(screen.getByText('(default)')).toBeInTheDocument();
		expect(onModelChange).toHaveBeenCalledWith('gpt-5-mini');
		expect(setModelMenuOpen).toHaveBeenCalledWith(false);
	});

	it('hides effort pill when only default effort exists', () => {
		renderPills({ availableEfforts: [''] });

		expect(screen.queryByTitle('Change effort level')).not.toBeInTheDocument();
	});

	it('selects an effort and closes the menu', () => {
		const onEffortChange = vi.fn();
		const setEffortMenuOpen = vi.fn();
		renderPills({ effortMenuOpen: true, onEffortChange, setEffortMenuOpen });

		fireEvent.click(screen.getByText('low'));

		expect(onEffortChange).toHaveBeenCalledWith('low');
		expect(setEffortMenuOpen).toHaveBeenCalledWith(false);
	});

	describe('shortcut hint header', () => {
		it('renders the hint at the top of both menus when one is supplied', () => {
			const { unmount } = renderPills({ modelMenuOpen: true, shortcutKeys: HINT_KEYS });
			expect(hintRow()).toHaveTextContent(HINT_TEXT);
			unmount();

			renderPills({ effortMenuOpen: true, shortcutKeys: HINT_KEYS });
			expect(hintRow()).toHaveTextContent(HINT_TEXT);
		});

		it('renders no header when no hint is supplied', () => {
			renderPills({ modelMenuOpen: true, effortMenuOpen: true });

			expect(screen.queryByText(/^Try:/)).not.toBeInTheDocument();
		});

		// The hint is decoration, not an option: it must not be reachable by
		// keyboard, and it must not be counted among the selectable rows.
		it('is not focusable and is not one of the menu buttons', () => {
			renderPills({ modelMenuOpen: true, shortcutKeys: HINT_KEYS });

			const hint = hintRow();
			expect(hint).toHaveTextContent(HINT_TEXT);
			expect(hint.tagName).not.toBe('BUTTON');
			expect(hint.closest('button')).toBeNull();
			expect(hint).not.toHaveAttribute('tabindex');

			expect(screen.getAllByRole('button').some((b) => b.textContent?.startsWith('Try:'))).toBe(
				false
			);
		});
	});
	// Auto is a model choice like any other: the stored value is the word
	// `auto`, drawn as "Auto", and its tooltip says what it acts on and who
	// decides.
	describe('the Auto model choice', () => {
		const AUTO_TITLE = 'Auto: picks the model and the effort for each turn. Decided by System One.';
		const WITH_AUTO = ['', 'auto', 'gpt-5', 'gpt-5-mini'];

		it('draws the word as Auto in the pill', () => {
			renderPills({ currentModel: 'auto', availableModels: WITH_AUTO });

			expect(screen.getByText('Auto')).toBeInTheDocument();
			expect(screen.queryByText('auto')).not.toBeInTheDocument();
		});

		it('draws the row as Auto, carries its tooltip, and selects the word', () => {
			const onModelChange = vi.fn();
			renderPills({
				modelMenuOpen: true,
				availableModels: WITH_AUTO,
				autoModelTitle: AUTO_TITLE,
				onModelChange,
			});

			const row = screen.getByText('Auto').closest('button')!;
			expect(row).toHaveAttribute('title', AUTO_TITLE);
			fireEvent.click(row);

			expect(onModelChange).toHaveBeenCalledWith('auto');
		});

		it('puts the tooltip on the Auto row alone', () => {
			renderPills({ modelMenuOpen: true, availableModels: WITH_AUTO, autoModelTitle: AUTO_TITLE });

			expect(screen.getByText('gpt-5-mini').closest('button')).not.toHaveAttribute('title');
			expect(screen.getByText('(default)').closest('button')).not.toHaveAttribute('title');
		});

		it("starts the pill's tooltip with the Auto title while Auto is the model", () => {
			renderPills({
				currentModel: 'auto',
				availableModels: WITH_AUTO,
				autoModelTitle: AUTO_TITLE,
			});

			const pill = screen.getByText('Auto').closest('button')!;
			expect(pill.getAttribute('title')).toBe(`${AUTO_TITLE} Click to change`);
		});

		it('appends the shortcut after the Auto title', () => {
			renderPills({
				currentModel: 'auto',
				availableModels: WITH_AUTO,
				autoModelTitle: AUTO_TITLE,
				shortcutKeys: HINT_KEYS,
			});

			const title = screen.getByText('Auto').closest('button')!.getAttribute('title')!;
			expect(title.startsWith(`${AUTO_TITLE} Click to change`)).toBe(true);
			expect(title).toContain(formatShortcutKeys(HINT_KEYS));
		});

		it('keeps the plain tooltip on a named model, and on Auto with no title to show', () => {
			const { unmount } = renderPills({ availableModels: WITH_AUTO, autoModelTitle: AUTO_TITLE });
			expect(screen.getByTitle('Change model')).toBeInTheDocument();
			unmount();

			renderPills({ currentModel: 'auto', availableModels: WITH_AUTO });
			expect(screen.getByTitle('Change model')).toBeInTheDocument();
		});
	});

	describe('typing a model ID that is not in the list', () => {
		// The motivating case: a limited-access model the CLI accepts but that
		// discovery cannot see, so it never reaches availableModels.
		const UNLISTED = 'claude-mythos-5-1';

		it('applies the typed model and closes the menu on Enter', () => {
			const onModelChange = vi.fn();
			const setModelMenuOpen = vi.fn();
			renderPills({ modelMenuOpen: true, onModelChange, setModelMenuOpen });

			const input = screen.getByLabelText('Use a model ID that is not listed');
			fireEvent.change(input, { target: { value: UNLISTED } });
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onModelChange).toHaveBeenCalledWith(UNLISTED);
			expect(setModelMenuOpen).toHaveBeenCalledWith(false);
		});

		it('trims surrounding whitespace', () => {
			const onModelChange = vi.fn();
			renderPills({ modelMenuOpen: true, onModelChange });

			const input = screen.getByLabelText('Use a model ID that is not listed');
			fireEvent.change(input, { target: { value: `  ${UNLISTED}  ` } });
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onModelChange).toHaveBeenCalledWith(UNLISTED);
		});

		it('ignores Enter on an empty or whitespace-only entry', () => {
			const onModelChange = vi.fn();
			const setModelMenuOpen = vi.fn();
			renderPills({ modelMenuOpen: true, onModelChange, setModelMenuOpen });

			const input = screen.getByLabelText('Use a model ID that is not listed');
			fireEvent.keyDown(input, { key: 'Enter' });
			fireEvent.change(input, { target: { value: '   ' } });
			fireEvent.keyDown(input, { key: 'Enter' });

			expect(onModelChange).not.toHaveBeenCalled();
			expect(setModelMenuOpen).not.toHaveBeenCalled();
		});

		it('does not apply the model on other keys', () => {
			const onModelChange = vi.fn();
			renderPills({ modelMenuOpen: true, onModelChange });

			const input = screen.getByLabelText('Use a model ID that is not listed');
			fireEvent.change(input, { target: { value: UNLISTED } });
			fireEvent.keyDown(input, { key: 'a' });

			expect(onModelChange).not.toHaveBeenCalled();
		});

		// Enter confirms a candidate mid-composition in Japanese, Chinese and
		// Korean input. Treating that as submit applies a half-typed ID.
		it('ignores Enter while an IME composition is active', () => {
			const onModelChange = vi.fn();
			const setModelMenuOpen = vi.fn();
			renderPills({ modelMenuOpen: true, onModelChange, setModelMenuOpen });

			const input = screen.getByLabelText('Use a model ID that is not listed');
			fireEvent.change(input, { target: { value: UNLISTED } });
			fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

			expect(onModelChange).not.toHaveBeenCalled();
			expect(setModelMenuOpen).not.toHaveBeenCalled();

			// The same key once composition has ended still applies.
			fireEvent.keyDown(input, { key: 'Enter' });
			expect(onModelChange).toHaveBeenCalledWith(UNLISTED);
		});

		it('closes the menu on Escape instead of swallowing the key', () => {
			const onModelChange = vi.fn();
			const setModelMenuOpen = vi.fn();
			renderPills({ modelMenuOpen: true, onModelChange, setModelMenuOpen });

			const input = screen.getByLabelText('Use a model ID that is not listed');
			fireEvent.change(input, { target: { value: UNLISTED } });
			fireEvent.keyDown(input, { key: 'Escape' });

			expect(setModelMenuOpen).toHaveBeenCalledWith(false);
			expect(onModelChange).not.toHaveBeenCalled();
		});

		// Escape elsewhere interrupts the turn, so the field must not let it
		// through on its way to closing the menu.
		it('keeps every key, Escape included, away from the composer', () => {
			const onKeyDown = vi.fn();
			render(
				<div onKeyDown={onKeyDown}>
					<ModelEffortPills
						isVisible
						theme={inputAreaTheme}
						currentModel="gpt-5"
						currentEffort="medium"
						availableModels={['gpt-5']}
						availableEfforts={['', 'low']}
						onModelChange={vi.fn()}
						onEffortChange={vi.fn()}
						modelMenuOpen
						setModelMenuOpen={vi.fn()}
						modelMenuRef={{ current: null }}
						effortMenuOpen={false}
						setEffortMenuOpen={vi.fn()}
						effortMenuRef={{ current: null }}
					/>
				</div>
			);

			const input = screen.getByLabelText('Use a model ID that is not listed');
			fireEvent.keyDown(input, { key: 'Escape' });
			fireEvent.keyDown(input, { key: 'a' });
			const filter = screen.getByPlaceholderText('Filter models...');
			fireEvent.keyDown(filter, { key: 'a' });
			fireEvent.keyDown(filter, { key: 'Enter' });
			fireEvent.keyDown(filter, { key: 'Escape' });

			expect(onKeyDown).not.toHaveBeenCalled();
		});
	});
});

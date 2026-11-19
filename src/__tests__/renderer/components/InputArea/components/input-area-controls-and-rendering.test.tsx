// Source: src/__tests__/renderer/components/InputArea/components/CommandModeBar.test.tsx
// Source: src/__tests__/renderer/components/InputArea/components/MentionRoutingBar.test.tsx
// Source: src/__tests__/renderer/components/InputArea/components/InputTextarea.test.tsx
// Source: src/__tests__/renderer/components/InputArea/components/ModelEffortPills.test.tsx
// Source: src/__tests__/renderer/components/InputArea/components/StagedImagesStrip.test.tsx
// Source: src/__tests__/renderer/components/InputArea/components/InputTextarea.renders.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { CommandModeBar } from '../../../../../renderer/components/InputArea/components/CommandModeBar';
import { inputAreaTheme } from '../_fixtures';
import { fireEvent } from '@testing-library/react';
import { within } from '@testing-library/react';
import { vi } from 'vitest';
import { MentionRoutingBar } from '../../../../../renderer/components/InputArea/components/MentionRoutingBar';
import { beforeEach } from 'vitest';
import type { ComponentProps } from 'react';
import type { RefObject } from 'react';
import { InputTextarea } from '../../../../../renderer/components/InputArea/components/InputTextarea';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT } from '../../../../../renderer/utils/textareaSizing';
import { useSettingsStore } from '../../../../../renderer/stores/settingsStore';
import { ModelEffortPills } from '../../../../../renderer/components/InputArea/components/ModelEffortPills';
import { formatShortcutKeys } from '../../../../../renderer/utils/shortcutFormatter';
import { getShortcutKeys } from '../../../../helpers/shortcutKeys';
import { createEvent } from '@testing-library/react';
import { afterEach } from 'vitest';
import { StagedImagesStrip } from '../../../../../renderer/components/InputArea/components/StagedImagesStrip';
import { act } from '@testing-library/react';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { createInputAreaSession } from '../_fixtures';
const counter = vi.hoisted(() => ({ renders: 0, active: false }));
vi.mock('../../../../../renderer/components/ChatComposer', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../../../renderer/components/ChatComposer')>();
	const Real = actual.ComposerTextarea;
	const Counted = (props: ComponentProps<typeof Real>) => {
		counter.renders += 1;
		return <Real {...props} />;
	};
	return {
		...actual,
		get ComposerTextarea() {
			return counter.active ? Counted : Real;
		},
	};
});

describeSourceSuite('CommandModeBar', () => {
	describe('CommandModeBar', () => {
		it('names the mode and where the command will run', () => {
			render(<CommandModeBar theme={inputAreaTheme} cwd="/Users/test/project" />);

			expect(screen.getByText('Command Mode')).toBeInTheDocument();
			expect(screen.getByText(/project/)).toBeInTheDocument();
		});

		it('advertises Tab completion, including branches in a git repo', () => {
			render(<CommandModeBar theme={inputAreaTheme} cwd="/repo" isGitRepo />);

			expect(screen.getByText('Tab')).toBeInTheDocument();
			expect(screen.getByText(/files, dirs, branches/)).toBeInTheDocument();
		});

		it('omits branches when the agent is not in a git repo', () => {
			render(<CommandModeBar theme={inputAreaTheme} cwd="/repo" isGitRepo={false} />);

			expect(screen.getByText(/files and dirs/)).toBeInTheDocument();
			expect(screen.queryByText(/branches/)).not.toBeInTheDocument();
		});

		it('shows the SSH remote when the agent runs remotely', () => {
			render(<CommandModeBar theme={inputAreaTheme} cwd="/srv/app" remoteName="builder" />);

			expect(screen.getByText(/builder:/)).toBeInTheDocument();
		});
	});
});
describeSourceSuite('MentionRoutingBar', () => {
	describe('MentionRoutingBar', () => {
		it('says a hand-off runs AFTER this agent answers', () => {
			render(
				<MentionRoutingBar theme={inputAreaTheme} routing="handoff" agentNames={['Kensho']} />
			);

			expect(screen.getByTestId('mention-routing-bar')).toHaveAttribute('data-routing', 'handoff');
			expect(screen.getByText('Hand-off')).toBeInTheDocument();
			expect(
				screen.getByText('This agent answers, then its answer goes to @Kensho')
			).toBeInTheDocument();
		});

		it('says a consult-first mention answers before this agent starts', () => {
			render(
				<MentionRoutingBar
					theme={inputAreaTheme}
					routing="consult-first"
					agentNames={['Backend', 'API']}
				/>
			);

			expect(
				screen.getByText('@Backend and @API answer first; this agent starts once the reply is in')
			).toBeInTheDocument();
		});

		it('says a leading mention leaves this agent out', () => {
			render(<MentionRoutingBar theme={inputAreaTheme} routing="only" agentNames={['Backend']} />);

			expect(screen.getByText('@Backend answers; this agent does not')).toBeInTheDocument();
		});

		it('"reword to change" opens the phrasings for every mode, marking the current one', () => {
			render(
				<MentionRoutingBar theme={inputAreaTheme} routing="parallel" agentNames={['Backend']} />
			);

			fireEvent.click(screen.getByText('reword to change'));

			const hint = screen.getByTestId('mention-routing-hint');
			expect(within(hint).getByText('Check with @agent first, then fix it')).toBeInTheDocument();
			expect(
				within(hint).getByText('Fix the bug, then send what you find to @agent')
			).toBeInTheDocument();
			expect(
				within(screen.getByTestId('mention-routing-hint-parallel')).getByText('now')
			).toBeInTheDocument();
			expect(
				within(screen.getByTestId('mention-routing-hint-handoff')).queryByText('now')
			).not.toBeInTheDocument();
		});

		it('closes the hint on Escape without letting the key reach the composer', () => {
			const composerKeyDown = vi.fn();
			document.addEventListener('keydown', composerKeyDown);
			render(
				<MentionRoutingBar theme={inputAreaTheme} routing="parallel" agentNames={['Backend']} />
			);

			fireEvent.click(screen.getByText('reword to change'));
			fireEvent.keyDown(screen.getByTestId('mention-routing-hint'), { key: 'Escape' });

			expect(screen.queryByTestId('mention-routing-hint')).not.toBeInTheDocument();
			expect(composerKeyDown).not.toHaveBeenCalled();
			document.removeEventListener('keydown', composerKeyDown);
		});

		it('shows a plain label, not a menu, when the routing cannot be changed', () => {
			render(
				<MentionRoutingBar theme={inputAreaTheme} routing="parallel" agentNames={['Backend']} />
			);

			expect(screen.queryByTestId('mention-routing-mode-button')).not.toBeInTheDocument();
		});

		it('the mode menu picks a routing for this message', () => {
			const onRoutingChange = vi.fn();
			render(
				<MentionRoutingBar
					theme={inputAreaTheme}
					routing="parallel"
					agentNames={['Backend']}
					onRoutingChange={onRoutingChange}
				/>
			);

			fireEvent.click(screen.getByTestId('mention-routing-mode-button'));
			// Auto names what the wording says, and is the selected row while nothing is picked.
			const auto = screen.getByTestId('mention-routing-option-auto');
			expect(auto).toHaveTextContent('Auto: Parallel');
			expect(auto).toHaveAttribute('aria-checked', 'true');

			fireEvent.click(screen.getByTestId('mention-routing-option-consult-first'));

			expect(onRoutingChange).toHaveBeenCalledWith('consult-first');
			expect(screen.queryByTestId('mention-routing-menu')).not.toBeInTheDocument();
		});

		it('marks a picked routing and lets Auto hand control back to the wording', () => {
			const onRoutingChange = vi.fn();
			render(
				<MentionRoutingBar
					theme={inputAreaTheme}
					routing="handoff"
					inferredRouting="parallel"
					explicit
					agentNames={['Backend']}
					onRoutingChange={onRoutingChange}
				/>
			);

			expect(screen.getByTestId('mention-routing-explicit-badge')).toBeInTheDocument();
			fireEvent.click(screen.getByTestId('mention-routing-mode-button'));
			expect(screen.getByTestId('mention-routing-option-handoff')).toHaveAttribute(
				'aria-checked',
				'true'
			);
			expect(screen.getByTestId('mention-routing-option-auto')).toHaveAttribute(
				'aria-checked',
				'false'
			);

			fireEvent.click(screen.getByTestId('mention-routing-option-auto'));

			expect(onRoutingChange).toHaveBeenCalledWith(null);
		});
	});
});
describeSourceSuite('InputTextarea', () => {
	/**
	 * jsdom performs no layout, so the browser's scroll clamping (scrollTop can
	 * never exceed scrollHeight - clientHeight) does not exist here. Install it by
	 * hand: that clamp IS the bug being reproduced. While the overlay is still one
	 * row short, a copied scrollTop gets clamped and the glyphs sit above the caret.
	 */
	function makeScrollable(el: HTMLElement, scrollHeight: number, clientHeight: number) {
		let scrollTop = 0;
		let currentScrollHeight = scrollHeight;
		Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
		Object.defineProperty(el, 'scrollHeight', {
			get: () => currentScrollHeight,
			configurable: true,
		});
		Object.defineProperty(el, 'scrollTop', {
			get: () => scrollTop,
			set: (v: number) => {
				scrollTop = Math.max(0, Math.min(v, currentScrollHeight - clientHeight));
			},
			configurable: true,
		});
		return {
			grow: (nextScrollHeight: number) => {
				currentScrollHeight = nextScrollHeight;
			},
		};
	}

	type TextareaProps = ComponentProps<typeof InputTextarea>;

	function renderTextarea(overrides: Partial<TextareaProps> = {}) {
		const inputRef: RefObject<HTMLTextAreaElement> = { current: null };
		const props: TextareaProps = {
			agentId: 'session-1',
			agentName: 'MySession',
			toolType: 'claude-code',
			theme: inputAreaTheme,
			isTerminalMode: false,
			inputValue: 'first line',
			spellCheckEnabled: false,
			inputRef,
			onInputFocus: vi.fn(),
			onChange: vi.fn(),
			handleInputKeyDown: vi.fn(),
			handlePaste: vi.fn(),
			handleDrop: vi.fn(),
			...overrides,
		};
		const view = render(<InputTextarea {...props} />);
		const textarea = view.container.querySelector('textarea') as HTMLTextAreaElement;
		const overlay = view.container.querySelector('.maestro-input-text-overlay') as HTMLDivElement;
		return {
			...view,
			textarea,
			overlay,
			// Re-query after a rerender that unmounts/remounts the overlay (mode flip,
			// last mention deleted) - the captured `overlay` node is stale by then.
			getOverlay: () =>
				view.container.querySelector('.maestro-input-text-overlay') as HTMLDivElement | null,
			rerenderWith: (value: string) =>
				view.rerender(<InputTextarea {...props} inputValue={value} />),
			rerenderProps: (next: Partial<TextareaProps>) =>
				view.rerender(<InputTextarea {...props} {...next} />),
		};
	}

	describe('InputTextarea', () => {
		it('caps the textarea with the shared KEYSTROKE_TEXTAREA_MAX_HEIGHT constant', () => {
			const { textarea } = renderTextarea();

			// Locks the dedupe in: the CSS cap must stay the same value the resize
			// logic clamps to, never a re-hard-coded `11rem`.
			expect(textarea.style.maxHeight).toBe(`${KEYSTROKE_TEXTAREA_MAX_HEIGHT}px`);
			expect(textarea.style.maxHeight).toBe('176px');
		});

		it('keeps native text visible and skips decoration without a recognized mention', () => {
			const { textarea, overlay } = renderTextarea({ inputValue: 'plain text, no mention' });

			expect(overlay).toBeNull();
			expect(textarea).toHaveStyle({ color: inputAreaTheme.colors.textMain });
		});

		it('does not render the overlay in terminal mode', () => {
			const { container, textarea } = renderTextarea({ isTerminalMode: true });

			expect(container.querySelector('.maestro-input-text-overlay')).toBeNull();
			expect(textarea.style.color).not.toBe('transparent');
		});

		it('restores mention decoration when the selected textarea loses focus', () => {
			const { textarea, overlay } = renderTextarea({ inputValue: 'check @src/index.ts now' });

			textarea.focus();
			textarea.setSelectionRange(0, 5);
			fireEvent(document, new Event('selectionchange'));

			expect(overlay).toHaveStyle({ visibility: 'hidden' });

			// Chromium stops painting the selection on blur, so the chip has to come
			// back with it - nothing else fires until the user clicks back in.
			fireEvent.blur(textarea);

			expect(overlay).toHaveStyle({ visibility: 'visible' });
		});

		it('clears stale selection state while the decoration is unmounted', () => {
			const { textarea, getOverlay, rerenderProps } = renderTextarea({
				inputValue: 'check @src/index.ts now',
			});

			textarea.focus();
			textarea.setSelectionRange(0, 5);
			fireEvent(document, new Event('selectionchange'));

			expect(getOverlay()).toHaveStyle({ visibility: 'hidden' });

			// Terminal mode unmounts the overlay AND detaches the selectionchange
			// listener, so nothing can clear `hasSelection` while it is gone. Coming
			// back must not restore a permanently hidden decoration layer.
			rerenderProps({ isTerminalMode: true });
			expect(getOverlay()).toBeNull();

			rerenderProps({ isTerminalMode: false });
			expect(getOverlay()).toHaveStyle({ visibility: 'visible' });
		});

		it('re-syncs the overlay after the grown content commits, repairing the stale clamp', () => {
			const { textarea, overlay, rerenderWith } = renderTextarea({
				inputValue: 'line one @src/index.ts',
			});

			// Text region is 8 rows of 20px. The textarea has already outgrown it; the
			// overlay is still rendering the shorter, pre-keystroke content.
			makeScrollable(textarea, 220, 160);
			const overlayScroll = makeScrollable(overlay, 160, 160);

			// Native caret auto-scroll happens BEFORE React commits the taller overlay.
			textarea.scrollTop = 60;
			fireEvent.scroll(textarea);

			// The stale overlay cannot reach 60, so the browser clamps it: this is the
			// desync the user sees as a clipped final row.
			expect(overlay.scrollTop).toBe(0);
			expect(overlay.scrollTop).not.toBe(textarea.scrollTop);

			// Commit the taller overlay content. The layout effect keyed on the rendered
			// segments re-copies the scroll position once the overlay can actually reach it.
			overlayScroll.grow(220);
			rerenderWith('line one @src/index.ts\nline two');

			expect(overlay.scrollTop).toBe(60);
			expect(overlay.scrollTop).toBe(textarea.scrollTop);
		});

		it('keeps syncing the overlay on user-driven scrolling', () => {
			const { textarea, overlay } = renderTextarea({ inputValue: 'line one @src/index.ts' });

			makeScrollable(textarea, 400, 160);
			makeScrollable(overlay, 400, 160);

			textarea.scrollTop = 90;
			textarea.scrollLeft = 7;
			fireEvent.scroll(textarea);

			expect(overlay.scrollTop).toBe(90);
			expect(overlay.scrollLeft).toBe(7);
		});
	});

	/**
	 * The composer's font is what tells you at a glance whether what you are typing
	 * is a shell line or a sentence.
	 *
	 * Command mode and the terminal composer take a fixed-pitch face - a command
	 * line is shell text, and the card it ends up in renders it the same way. AI
	 * command mode does not: that draft is prose, and the command the model
	 * proposes gets monospace when it appears in the proposal card.
	 *
	 * "No override" reads as the empty string. The composer does set
	 * `fontFamily: 'inherit'` in SHARED_TYPOGRAPHY (so the decorative overlay is
	 * measured on the same face as the textarea), but jsdom's cssstyle drops the
	 * `inherit` keyword, so both "unset" and "inherit" surface as `''` here. Either
	 * way the assertion says what matters: no fixed-pitch stack was substituted.
	 */
	describe('InputTextarea font', () => {
		beforeEach(() => {
			// A real proportional face, and the one this was found with: it resolves
			// perfectly well, so no amount of fallback appending fixes it on its own.
			useSettingsStore.setState({ fontFamily: 'Avenir Next' });
		});

		it('types a command-mode draft in a fixed-pitch stack', () => {
			const { textarea } = renderTextarea({ isCommandModeDraft: true });

			expect(textarea.style.fontFamily).toMatch(/monospace/);
		});

		it('types a terminal-mode command in a fixed-pitch stack', () => {
			const { textarea } = renderTextarea({ isTerminalMode: true });

			expect(textarea.style.fontFamily).toMatch(/monospace/);
		});

		it('leaves an AI command request in the app font', () => {
			const { textarea } = renderTextarea({ isAiCommandDraft: true });

			expect(textarea.style.fontFamily).toBe('');
		});

		it('leaves an ordinary agent message in the app font', () => {
			const { textarea } = renderTextarea();

			expect(textarea.style.fontFamily).toBe('');
		});

		// The overlay is enabled for everything but terminal mode, so a command-mode
		// draft carrying an `@mention` paints chips under monospace glyphs. Measured
		// on a different face, every chip lands off the word it belongs to.
		it('gives the mention overlay the same fixed-pitch font as the textarea', () => {
			const { textarea, overlay } = renderTextarea({
				isCommandModeDraft: true,
				inputValue: 'grep @src/app.ts',
			});

			expect(overlay).not.toBeNull();
			expect(overlay.style.fontFamily).toBe(textarea.style.fontFamily);
			expect(overlay.style.fontFamily).toMatch(/monospace/);
		});
	});
});
describeSourceSuite('ModelEffortPills', () => {
	// Formatted through the real formatter rather than spelled out: the chord
	// renders as '⌘X' on macOS and 'Ctrl+X' elsewhere, and hardcoding either makes
	// the test pass on one platform's CI and fail on the other's.
	const HINT_KEYS = ['Meta', 'x'];
	const HINT_TEXT = `Try: ${formatShortcutKeys(HINT_KEYS)}`;
	// The hint row: the chord is drawn as separate key caps, so find it by its keys.
	const hintRow = () => getShortcutKeys(HINT_KEYS).closest('div') as HTMLElement;

	describe('ModelEffortPills', () => {
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
		describe('refreshing the model list', () => {
			it('offers Refresh in the model menu header and keeps the menu open', () => {
				const onRefreshModels = vi.fn();
				const setModelMenuOpen = vi.fn();
				renderPills({
					modelMenuOpen: true,
					shortcutKeys: HINT_KEYS,
					onRefreshModels,
					setModelMenuOpen,
				});

				fireEvent.click(screen.getByRole('button', { name: 'Refresh model list' }));

				expect(onRefreshModels).toHaveBeenCalledTimes(1);
				// The point of refreshing is to see the new model in this same list.
				expect(setModelMenuOpen).not.toHaveBeenCalled();
				expect(hintRow()).toHaveTextContent(HINT_TEXT);
			});

			it('is offered even where no shortcut hint is shown', () => {
				renderPills({ modelMenuOpen: true, onRefreshModels: vi.fn() });

				expect(screen.getByRole('button', { name: 'Refresh model list' })).toBeInTheDocument();
				expect(screen.queryByText(/^Try:/)).not.toBeInTheDocument();
			});

			it('blocks a second click while a refresh is running', () => {
				const onRefreshModels = vi.fn();
				renderPills({ modelMenuOpen: true, onRefreshModels, refreshingModels: true });

				const button = screen.getByRole('button', { name: 'Refresh model list' });
				expect(button).toBeDisabled();
				expect(button).toHaveAttribute('aria-busy', 'true');
			});

			it('is absent when the surface supplies no refresh', () => {
				renderPills({ modelMenuOpen: true, shortcutKeys: HINT_KEYS });

				expect(screen.queryByRole('button', { name: 'Refresh model list' })).toBeNull();
			});

			it('stays out of the effort menu', () => {
				renderPills({ effortMenuOpen: true, onRefreshModels: vi.fn() });

				expect(screen.queryByRole('button', { name: 'Refresh model list' })).toBeNull();
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
				// Safari reports the confirming Enter after compositionend, with keyCode 229.
				fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

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

				expect(onKeyDown).not.toHaveBeenCalled();
			});
		});
	});
});
describeSourceSuite('StagedImagesStrip', () => {
	describe('StagedImagesStrip', () => {
		function renderStrip(overrides = {}) {
			return render(
				<StagedImagesStrip
					isVisible
					stagedImages={['data:image/png;base64,a', 'data:image/png;base64,b']}
					theme={inputAreaTheme}
					setLightboxImage={vi.fn()}
					setStagedImages={vi.fn()}
					openAnnotator={vi.fn()}
					onReorder={vi.fn()}
					{...overrides}
				/>
			);
		}

		it('renders nothing when hidden or empty', () => {
			const { rerender } = renderStrip({ isVisible: false });
			expect(screen.queryByRole('img')).not.toBeInTheDocument();

			rerender(
				<StagedImagesStrip
					isVisible
					stagedImages={[]}
					theme={inputAreaTheme}
					setLightboxImage={vi.fn()}
					setStagedImages={vi.fn()}
					openAnnotator={vi.fn()}
					onReorder={vi.fn()}
				/>
			);
			expect(screen.queryByRole('img')).not.toBeInTheDocument();
		});

		it('opens lightbox when clicking a staged image', () => {
			const setLightboxImage = vi.fn();
			renderStrip({ setLightboxImage });

			// The tile, not the <img>: the image is decorative and pointer-events-none,
			// so a real press lands on the wrapper that carries the drag and the click.
			fireEvent.click(tileOf(0));

			expect(setLightboxImage).toHaveBeenCalledWith(
				'data:image/png;base64,a',
				['data:image/png;base64,a', 'data:image/png;base64,b'],
				'staged'
			);
		});

		it('opens annotator and replaces by image content', () => {
			const setStagedImages = vi.fn();
			const openAnnotator = vi.fn((_img, onSave) => onSave('data:image/png;base64,new'));
			renderStrip({ setStagedImages, openAnnotator });

			fireEvent.click(screen.getAllByLabelText('Annotate image')[0]);
			const updater = setStagedImages.mock.calls[0][0];

			expect(openAnnotator).toHaveBeenCalledWith('data:image/png;base64,a', expect.any(Function));
			expect(updater(['data:image/png;base64/a', 'data:image/png;base64,a'])).toEqual([
				'data:image/png;base64/a',
				'data:image/png;base64,new',
			]);
		});

		it('removes image by content', () => {
			const setStagedImages = vi.fn();
			renderStrip({ setStagedImages });

			fireEvent.click(screen.getAllByTestId('x-icon')[0].closest('button')!);
			const updater = setStagedImages.mock.calls[0][0];

			expect(updater(['data:image/png;base64,a', 'data:image/png;base64,b'])).toEqual([
				'data:image/png;base64,b',
			]);
		});

		// Drag-to-reorder. jsdom has no layout engine and no DragEvent, so the tests
		// have to supply both halves of the geometry the drop math reads: a stubbed
		// rect per tile, and a clientX that survives onto the event (fireEvent's init
		// object drops mouse coordinates when it falls back to plain Event).
		afterEach(() => {
			vi.restoreAllMocks();
		});

		/**
		 * The tile wrapper: drag source, drop target, and click target at once. The
		 * thumbnail image is `pointer-events-none`, so this is also the element a
		 * real press hit-tests to.
		 */
		function tileOf(index: number): HTMLElement {
			return screen.getAllByRole('button', { name: /^Staged image/ })[index];
		}

		/** Where a drag starts. Same element as the tile now; kept for readability. */
		function thumbOf(index: number): HTMLElement {
			return tileOf(index);
		}

		/** Lay the tiles out as two 100px-wide boxes side by side. */
		function stubTileLayout(tiles: HTMLElement[]) {
			const rects = new Map(tiles.map((tile, i) => [tile, { left: i * 100, width: 100 }]));
			vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
				this: Element
			) {
				const r = rects.get(this as HTMLElement) ?? { left: 0, width: 0 };
				return {
					...r,
					right: r.left + r.width,
					top: 0,
					bottom: 64,
					height: 64,
					x: r.left,
					y: 0,
					toJSON: () => ({}),
				} as DOMRect;
			});
		}

		function makeDataTransfer() {
			const store: Record<string, string> = {};
			return {
				types: [] as string[],
				effectAllowed: '',
				dropEffect: '',
				setData(type: string, value: string) {
					store[type] = value;
					if (!this.types.includes(type)) this.types.push(type);
				},
				getData(type: string) {
					return store[type] ?? '';
				},
			};
		}

		function fireAt(
			kind: 'dragOver' | 'drop',
			target: HTMLElement,
			dataTransfer: unknown,
			clientX: number
		) {
			const event = createEvent[kind](target, { dataTransfer });
			Object.defineProperty(event, 'clientX', { value: clientX });
			fireEvent(target, event);
		}

		it('reports a drop past a later tile as a forward move', () => {
			const onReorder = vi.fn();
			renderStrip({ onReorder });
			const tiles = [tileOf(0), tileOf(1)];
			stubTileLayout(tiles);
			const dataTransfer = makeDataTransfer();

			fireEvent.dragStart(thumbOf(0), { dataTransfer });
			// Right of the second tile's midpoint: the gap AFTER it.
			fireAt('dragOver', tiles[1], dataTransfer, 180);
			fireAt('drop', tiles[1], dataTransfer, 180);

			expect(onReorder).toHaveBeenCalledWith(0, 1);
		});

		it('reports a drop before an earlier tile as a backward move', () => {
			const onReorder = vi.fn();
			renderStrip({ onReorder });
			const tiles = [tileOf(0), tileOf(1)];
			stubTileLayout(tiles);
			const dataTransfer = makeDataTransfer();

			fireEvent.dragStart(thumbOf(1), { dataTransfer });
			// Left of the first tile's midpoint: the gap BEFORE it.
			fireAt('dragOver', tiles[0], dataTransfer, 20);
			fireAt('drop', tiles[0], dataTransfer, 20);

			expect(onReorder).toHaveBeenCalledWith(1, 0);
		});

		it('ignores a drop into the dragged image own gap', () => {
			const onReorder = vi.fn();
			renderStrip({ onReorder });
			const tiles = [tileOf(0), tileOf(1)];
			stubTileLayout(tiles);
			const dataTransfer = makeDataTransfer();

			fireEvent.dragStart(thumbOf(0), { dataTransfer });
			fireAt('dragOver', tiles[0], dataTransfer, 20);
			fireAt('drop', tiles[0], dataTransfer, 20);

			expect(onReorder).not.toHaveBeenCalled();
		});

		it('drags from a plain element, never a form control', () => {
			// Regression guard for the reason the strip could not be dragged into the
			// chat at all: the thumbnail was wrapped in a <button>, and Blink drops
			// the drag when a form control consumes the press for activation. That
			// held whether `draggable` sat on the button or on an ancestor, so the
			// test asserts the shape of the DOM rather than which element carries the
			// attribute.
			renderStrip();

			const tile = tileOf(0);
			expect(tile.tagName).not.toBe('BUTTON');
			expect(tile.getAttribute('draggable')).toBe('true');
			// The image must not be hit-testable: its own draggable="false" computes
			// -webkit-user-drag: none, which would stop the drag if it were the target.
			const img = screen.getAllByRole('presentation', { hidden: true })[0];
			expect(img.className).toContain('pointer-events-none');
			// The per-image controls opt out, so pressing one cannot start a tile drag.
			for (const control of within(tile).getAllByRole('button')) {
				expect(control.getAttribute('draggable')).toBe('false');
			}
		});

		it('hides the organizer button when only one image is staged', () => {
			// Nothing to compare and nothing to reorder: the button would open a modal
			// with no work in it.
			renderStrip({ stagedImages: ['data:image/png;base64,a'] });

			expect(screen.queryByLabelText('Open image organizer')).not.toBeInTheDocument();
		});

		it('shows the organizer button from two images up', () => {
			renderStrip();

			expect(screen.getByLabelText('Open image organizer')).toBeInTheDocument();
		});

		// The number is how you name an image in the message ("annotate screenshot
		// 3"), so it has to be readable before a drag starts, not only during one.
		describe('slot numbers', () => {
			/** The badge is faded rather than unmounted, so read its opacity. */
			function badgeOf(index: number): HTMLElement {
				return within(tileOf(index)).getByText(String(index + 1));
			}

			it('labels every thumbnail once there is more than one to pick from', () => {
				renderStrip();

				expect(badgeOf(0)).toHaveStyle({ opacity: '1' });
				expect(badgeOf(1)).toHaveStyle({ opacity: '1' });
			});

			it('leaves a lone thumbnail unlabelled, since there is nothing to pick', () => {
				renderStrip({ stagedImages: ['data:image/png;base64,a'] });

				expect(badgeOf(0)).toHaveStyle({ opacity: '0' });
			});

			// Mid-drag the number answers a different question - "which slot am I
			// aiming at" - so it appears even when there is only one image.
			it('labels a lone thumbnail while a drag is in flight', () => {
				renderStrip({ stagedImages: ['data:image/png;base64,a'] });

				fireEvent.dragStart(thumbOf(0), { dataTransfer: makeDataTransfer() });

				expect(badgeOf(0)).toHaveStyle({ opacity: '1' });
			});
		});

		it('carries the slot reference as plain text so a drop on the composer reads it', () => {
			renderStrip();
			const dataTransfer = makeDataTransfer();

			fireEvent.dragStart(thumbOf(1), { dataTransfer });

			expect(dataTransfer.getData('text/plain')).toBe('Screenshot 2');
			expect(dataTransfer.getData('application/x-maestro-staged-image')).toBe('1');
		});
	});
});
describe('InputTextarea.renders', () => {
	const session = createInputAreaSession();
	const otherAgent = createInputAreaSession({ id: 'session-2', name: 'Other' });

	function renderCounted(initialValue: string) {
		const inputRef: RefObject<HTMLTextAreaElement> = { current: null };
		const handlers = {
			onInputFocus: vi.fn(),
			onChange: vi.fn(),
			handleInputKeyDown: vi.fn(),
			handlePaste: vi.fn(),
			handleDrop: vi.fn(),
		};
		const tree = (value: string, agent = session) => (
			<InputTextarea
				agentId={agent.id}
				agentName={agent.name}
				toolType={agent.toolType}
				theme={inputAreaTheme}
				isTerminalMode={false}
				isCommandModeDraft={false}
				isAiCommandDraft={false}
				awaitingAiCommand={false}
				inputValue={value}
				spellCheckEnabled={false}
				inputRef={inputRef}
				{...handlers}
			/>
		);
		const view = render(tree(initialValue));
		counter.renders = 0;
		return {
			type: (value: string) => view.rerender(tree(value)),
			/** InputArea re-rendering with this agent's Session replaced by a streaming flush. */
			ownFlush: (value: string) => view.rerender(tree(value, { ...session })),
			renders: () => counter.renders,
		};
	}

	/** What a streaming flush from another agent does to the store. */
	function flushOtherAgent() {
		act(() => {
			useSessionStore.setState((s) => ({
				sessions: s.sessions.map((x) => (x.id === otherAgent.id ? { ...x } : x)),
			}));
		});
	}

	describe('InputTextarea render budget', () => {
		afterEach(() => {
			counter.active = false;
		});
		beforeEach(() => {
			counter.active = true;
			useSessionStore.setState({ sessions: [session, otherAgent], groups: [] } as never);
		});

		it('renders once per keystroke', () => {
			const composer = renderCounted('hel');
			composer.type('hell');
			expect(composer.renders()).toBe(1);
			composer.type('hello');
			expect(composer.renders()).toBe(2);
		});

		it("does not render on another agent's streaming flush while the draft has no @", () => {
			const composer = renderCounted('no mention here');
			flushOtherAgent();
			flushOtherAgent();
			expect(composer.renders()).toBe(0);
		});

		it("does not render when this agent's own Session object is replaced", () => {
			const composer = renderCounted('ask @Other');
			composer.ownFlush('ask @Other');
			expect(composer.renders()).toBe(0);
		});

		it('renders once per flush while the draft has an @, for the mention roster', () => {
			const composer = renderCounted('ask @Other');
			flushOtherAgent();
			expect(composer.renders()).toBe(1);
		});
	});
});

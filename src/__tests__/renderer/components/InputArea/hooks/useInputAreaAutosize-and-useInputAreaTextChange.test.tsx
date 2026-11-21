// Source: src/__tests__/renderer/components/InputArea/hooks/useInputAreaAutosize.test.tsx
// Source: src/__tests__/renderer/components/InputArea/hooks/useInputAreaTextChange.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { render } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { useInputAreaAutosize } from '../../../../../renderer/components/InputArea/hooks/useInputAreaAutosize';
import { fireEvent } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { afterEach } from 'vitest';
import { vi } from 'vitest';
import { useInputAreaTextChange } from '../../../../../renderer/components/InputArea/hooks/useInputAreaTextChange';
describeSourceSuite('useInputAreaAutosize', () => {
	function Harness({
		value,
		selectionEnd = value.length,
		initialScrollTop = 0,
	}: {
		value: string;
		selectionEnd?: number;
		initialScrollTop?: number;
	}) {
		const ref = useRef<HTMLTextAreaElement>(null);
		useInputAreaAutosize({ inputRef: ref, inputValue: value, activeTabId: 'tab-1' });

		return (
			<textarea
				ref={(el) => {
					if (!el) return;
					// The real composer textarea is controlled, so its DOM value tracks
					// inputValue. defaultValue is uncontrolled and would keep the previous
					// render's value across a rerender, so mirror the current value here -
					// scrollTextareaToCaretEnd reads textarea.value.length.
					el.value = value;
					Object.defineProperty(el, 'scrollHeight', { value: 200, configurable: true });
					Object.defineProperty(el, 'selectionEnd', { value: selectionEnd, configurable: true });
					el.scrollTop = initialScrollTop;
					ref.current = el;
				}}
				defaultValue={value}
				aria-label="input"
			/>
		);
	}

	describe('useInputAreaAutosize', () => {
		it('resizes a programmatic value change with the unified 176 cap', async () => {
			const { getByLabelText } = render(<Harness value="hello" />);

			await waitFor(() => {
				expect((getByLabelText('input') as HTMLTextAreaElement).style.height).toBe('176px');
			});
		});

		it('scrolls to the end when the caret is at the end of the value', async () => {
			const { getByLabelText } = render(<Harness value="hello" />);

			await waitFor(() => {
				expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(200);
			});
		});

		it('leaves the scroll position untouched when the caret is on an earlier line', async () => {
			const { getByLabelText } = render(
				<Harness value={'hello\nworld'} selectionEnd={2} initialScrollTop={42} />
			);

			await waitFor(() => {
				expect((getByLabelText('input') as HTMLTextAreaElement).style.height).toBe('176px');
			});
			// Exercises scrollTextareaToCaretEnd's contract directly: with selectionEnd on a
			// line before the final one it is a no-op, so the prior scroll position survives
			// the resize. NOTE: this harness pins selectionEnd via Object.defineProperty. The
			// real deferred @-mention / template flows place their caret in a later rAF, so
			// they do NOT reach the helper in this mid-text state during the commit-phase
			// effect (see PR #1294 discussion) - this only documents the helper itself.
			expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(42);
		});

		it('leaves the scroll untouched when the caret is mid-way through the final line', async () => {
			// A final logical line can soft-wrap past the height cap, so a caret before its
			// trailing characters is not guaranteed to be on the bottom visual row. Snapping
			// to scrollHeight would scroll that row out of view, so the gate keys off the
			// true end of the value and this mid-line caret is a no-op.
			const { getByLabelText } = render(
				<Harness value={'hello\nworld'} selectionEnd={8} initialScrollTop={42} />
			);

			await waitFor(() => {
				expect((getByLabelText('input') as HTMLTextAreaElement).style.height).toBe('176px');
			});
			expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(42);
		});

		it('scrolls a restored shorter draft with the caret at the end', async () => {
			const longDraft = 'a'.repeat(400);
			const { rerender, getByLabelText } = render(<Harness value={longDraft} />);

			// Restore a SHORTER draft with the caret at its end. The removed
			// shouldScrollTextareaToEnd heuristic used to skip this because the new value
			// was not longer than the old one, leaving scrollTop stale below the caret.
			rerender(<Harness value="hi" selectionEnd={2} initialScrollTop={40} />);

			await waitFor(() => {
				expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(200);
			});
		});
	});
});
describeSourceSuite('useInputAreaTextChange', () => {
	function Harness({
		isTerminalMode = false,
		slashCommandOpen = false,
		commandMode = 'off',
		previousValue = '',
		handlers,
	}: {
		isTerminalMode?: boolean;
		slashCommandOpen?: boolean;
		commandMode?: 'off' | 'shell' | 'ai';
		/** What the composer held before the edit under test. */
		previousValue?: string;
		handlers: Record<string, ReturnType<typeof vi.fn>>;
	}) {
		const keystrokeResizeScheduledRef = useRef(false);
		const onChange = useInputAreaTextChange({
			isTerminalMode,
			slashCommandOpen,
			commandMode,
			setCommandMode: handlers.setCommandMode,
			getPreviousValue: () => previousValue,
			keystrokeResizeScheduledRef,
			setInputValue: handlers.setInputValue,
			setSlashCommandOpen: handlers.setSlashCommandOpen,
			setSelectedSlashCommandIndex: handlers.setSelectedSlashCommandIndex,
			setAtMentionOpen: handlers.setAtMentionOpen,
			setAtMentionFilter: handlers.setAtMentionFilter,
			setAtMentionStartIndex: handlers.setAtMentionStartIndex,
			setSelectedAtMentionIndex: handlers.setSelectedAtMentionIndex,
		});

		return <textarea aria-label="input" onChange={onChange} />;
	}

	describe('useInputAreaTextChange', () => {
		afterEach(() => {
			vi.unstubAllGlobals();
		});

		function createHandlers() {
			return {
				setInputValue: vi.fn(),
				setSlashCommandOpen: vi.fn(),
				setSelectedSlashCommandIndex: vi.fn(),
				setAtMentionOpen: vi.fn(),
				setAtMentionFilter: vi.fn(),
				setAtMentionStartIndex: vi.fn(),
				setSelectedAtMentionIndex: vi.fn(),
				setCommandMode: vi.fn(),
			};
		}

		it('updates input immediately and opens slash command menu', () => {
			const handlers = createHandlers();
			render(<Harness handlers={handlers} />);

			fireEvent.change(screen.getByLabelText('input'), {
				target: { value: '/', selectionStart: 1 },
			});

			expect(handlers.setInputValue).toHaveBeenCalledWith('/');
			expect(handlers.setSelectedSlashCommandIndex).toHaveBeenCalledWith(0);
			expect(handlers.setSlashCommandOpen).toHaveBeenCalledWith(true);
		});

		it('closes slash command menu when value contains arguments', () => {
			const handlers = createHandlers();
			render(<Harness handlers={handlers} slashCommandOpen />);

			fireEvent.change(screen.getByLabelText('input'), {
				target: { value: '/clear now', selectionStart: 10 },
			});

			expect(handlers.setSlashCommandOpen).toHaveBeenCalledWith(false);
			expect(handlers.setSelectedSlashCommandIndex).not.toHaveBeenCalled();
		});

		it('opens @mention state in AI mode', () => {
			const handlers = createHandlers();
			render(<Harness handlers={handlers} />);

			fireEvent.change(screen.getByLabelText('input'), {
				target: { value: 'open @src', selectionStart: 9 },
			});

			expect(handlers.setAtMentionOpen).toHaveBeenCalledWith(true);
			expect(handlers.setAtMentionFilter).toHaveBeenCalledWith('src');
			expect(handlers.setAtMentionStartIndex).toHaveBeenCalledWith(5);
			expect(handlers.setSelectedAtMentionIndex).toHaveBeenCalledWith(0);
		});

		it('does not run @mention detection in terminal mode', () => {
			const handlers = createHandlers();
			render(<Harness handlers={handlers} isTerminalMode />);

			fireEvent.change(screen.getByLabelText('input'), {
				target: { value: '@src', selectionStart: 4 },
			});

			expect(handlers.setAtMentionOpen).not.toHaveBeenCalled();
		});

		it('scrolls the resized textarea to the caret at the end during the keystroke frame', () => {
			const handlers = createHandlers();
			const runAnimationFrame = vi.fn((callback: FrameRequestCallback): number => {
				callback(0);
				return 1;
			});
			vi.stubGlobal('requestAnimationFrame', runAnimationFrame);
			render(<Harness handlers={handlers} />);
			const textarea = screen.getByLabelText('input') as HTMLTextAreaElement;
			const value = `${'line\n'.repeat(80)}end`;
			textarea.scrollTop = 0;
			Object.defineProperty(textarea, 'scrollHeight', { value: 640, configurable: true });
			Object.defineProperty(textarea, 'selectionEnd', { value: value.length, configurable: true });

			fireEvent.change(textarea, {
				target: { value, selectionStart: value.length },
			});

			expect(runAnimationFrame).toHaveBeenCalledTimes(1);
			expect(textarea.scrollTop).toBe(640);
		});

		it('preserves the restored scroll when the caret sits before trailing text on the final line', () => {
			const handlers = createHandlers();
			const runAnimationFrame = vi.fn((callback: FrameRequestCallback): number => {
				callback(0);
				return 1;
			});
			vi.stubGlobal('requestAnimationFrame', runAnimationFrame);
			render(<Harness handlers={handlers} />);
			const textarea = screen.getByLabelText('input') as HTMLTextAreaElement;
			// Content well past TEXTAREA_MAX_HEIGHT, caret in the middle of the final logical
			// line (what an inserted mention or trailing whitespace leaves behind). That line
			// can soft-wrap across several visual rows, so the caret is not guaranteed to be
			// on the bottom row; snapping to scrollHeight would scroll it out of view. The
			// gate keys off the true end of the value, so this mid-line caret is a no-op and
			// the scroll resizeTextareaToContent restored survives.
			const value = `${'line\n'.repeat(80)}trailing`;
			const caret = value.length - 4;
			textarea.scrollTop = 96;
			Object.defineProperty(textarea, 'scrollHeight', { value: 640, configurable: true });
			Object.defineProperty(textarea, 'selectionEnd', { value: caret, configurable: true });

			fireEvent.change(textarea, {
				target: { value, selectionStart: caret },
			});

			expect(runAnimationFrame).toHaveBeenCalledTimes(1);
			expect(textarea.style.height).toBe('176px');
			expect(textarea.scrollTop).toBe(96);
		});

		it('coalesces a burst of keystrokes into one resize frame', () => {
			const handlers = createHandlers();
			const frames: FrameRequestCallback[] = [];
			const requestFrame = vi.fn((callback: FrameRequestCallback): number => {
				frames.push(callback);
				return frames.length;
			});
			vi.stubGlobal('requestAnimationFrame', requestFrame);
			render(<Harness handlers={handlers} />);
			const textarea = screen.getByLabelText('input') as HTMLTextAreaElement;
			Object.defineProperty(textarea, 'scrollHeight', { value: 640, configurable: true });

			// Three keystrokes before the browser paints: each resize forces a layout,
			// so they must share the one pending frame rather than queue three.
			for (const value of ['a', 'ab', 'abc']) {
				fireEvent.change(textarea, { target: { value, selectionStart: value.length } });
			}
			expect(requestFrame).toHaveBeenCalledTimes(1);

			frames[0](0);
			expect(textarea.style.height).toBe('176px');

			// Once the frame has run, the next keystroke schedules a fresh one.
			fireEvent.change(textarea, { target: { value: 'abcd', selectionStart: 4 } });
			expect(requestFrame).toHaveBeenCalledTimes(2);
		});

		it('leaves the scroll position alone when editing an earlier line', () => {
			const handlers = createHandlers();
			const runAnimationFrame = vi.fn((callback: FrameRequestCallback): number => {
				callback(0);
				return 1;
			});
			vi.stubGlobal('requestAnimationFrame', runAnimationFrame);
			render(<Harness handlers={handlers} />);
			const textarea = screen.getByLabelText('input') as HTMLTextAreaElement;
			const value = `${'line\n'.repeat(80)}end`;
			textarea.scrollTop = 42;
			Object.defineProperty(textarea, 'scrollHeight', { value: 640, configurable: true });
			// Caret parked on the FIRST line: scrollTextareaToCaretEnd only snaps when the
			// caret is at the very end of the value, so the keystroke resize must preserve
			// the scroll rather than jump the viewport to the bottom.
			Object.defineProperty(textarea, 'selectionEnd', { value: 2, configurable: true });

			fireEvent.change(textarea, {
				target: { value, selectionStart: 2 },
			});

			expect(textarea.scrollTop).toBe(42);
		});

		describe('command mode entry (the ! gesture)', () => {
			it('enters command mode and swallows the bang', () => {
				const handlers = createHandlers();
				render(<Harness handlers={handlers} />);

				fireEvent.change(screen.getByLabelText('input'), {
					target: { value: '!', selectionStart: 1 },
				});

				expect(handlers.setCommandMode).toHaveBeenCalledWith('shell');
				// The bang never reaches the text - that is the whole point.
				expect(handlers.setInputValue).toHaveBeenCalledWith('');
			});

			it('keeps the rest of a pasted command', () => {
				const handlers = createHandlers();
				render(<Harness handlers={handlers} />);

				fireEvent.change(screen.getByLabelText('input'), {
					target: { value: '!git status', selectionStart: 11 },
				});

				expect(handlers.setCommandMode).toHaveBeenCalledWith('shell');
				expect(handlers.setInputValue).toHaveBeenCalledWith('git status');
			});

			it('does not enter when the composer already held a message', () => {
				const handlers = createHandlers();
				render(<Harness handlers={handlers} previousValue="deploy the site" />);

				fireEvent.change(screen.getByLabelText('input'), {
					target: { value: '!deploy the site', selectionStart: 1 },
				});

				expect(handlers.setCommandMode).not.toHaveBeenCalled();
				expect(handlers.setInputValue).toHaveBeenCalledWith('!deploy the site');
			});

			it('climbs from command mode to AI command mode on a second bang', () => {
				const handlers = createHandlers();
				render(<Harness handlers={handlers} commandMode="shell" />);

				fireEvent.change(screen.getByLabelText('input'), {
					target: { value: '!', selectionStart: 1 },
				});

				expect(handlers.setCommandMode).toHaveBeenCalledWith('ai');
				expect(handlers.setInputValue).toHaveBeenCalledWith('');
			});

			it('leaves a bang typed into a non-empty command line as shell text', () => {
				const handlers = createHandlers();
				render(<Harness handlers={handlers} commandMode="shell" previousValue="echo " />);

				fireEvent.change(screen.getByLabelText('input'), {
					target: { value: 'echo !', selectionStart: 6 },
				});

				expect(handlers.setCommandMode).not.toHaveBeenCalled();
				expect(handlers.setInputValue).toHaveBeenCalledWith('echo !');
			});

			it('has no rung above AI command mode - the bang stays in the request', () => {
				const handlers = createHandlers();
				render(<Harness handlers={handlers} commandMode="ai" />);

				fireEvent.change(screen.getByLabelText('input'), {
					target: { value: '!', selectionStart: 1 },
				});

				expect(handlers.setCommandMode).not.toHaveBeenCalled();
				expect(handlers.setInputValue).toHaveBeenCalledWith('!');
			});

			it('suppresses the slash menu and @ mentions in AI command mode too', () => {
				const handlers = createHandlers();
				render(<Harness handlers={handlers} commandMode="ai" />);

				fireEvent.change(screen.getByLabelText('input'), {
					target: { value: '/usr', selectionStart: 4 },
				});

				expect(handlers.setSlashCommandOpen).toHaveBeenCalledWith(false);
				expect(handlers.setSlashCommandOpen).not.toHaveBeenCalledWith(true);
				expect(handlers.setAtMentionOpen).not.toHaveBeenCalledWith(true);
			});

			it('does not enter in terminal mode, which is already a shell', () => {
				const handlers = createHandlers();
				render(<Harness handlers={handlers} isTerminalMode />);

				fireEvent.change(screen.getByLabelText('input'), {
					target: { value: '!ls', selectionStart: 3 },
				});

				expect(handlers.setCommandMode).not.toHaveBeenCalled();
				expect(handlers.setInputValue).toHaveBeenCalledWith('!ls');
			});

			it('suppresses the slash menu in command mode so /usr/bin is a path', () => {
				const handlers = createHandlers();
				render(<Harness handlers={handlers} commandMode="shell" />);

				fireEvent.change(screen.getByLabelText('input'), {
					target: { value: '/usr', selectionStart: 4 },
				});

				expect(handlers.setSlashCommandOpen).toHaveBeenCalledWith(false);
				expect(handlers.setSlashCommandOpen).not.toHaveBeenCalledWith(true);
			});

			it('suppresses @ mentions in command mode', () => {
				const handlers = createHandlers();
				render(<Harness handlers={handlers} commandMode="shell" />);

				fireEvent.change(screen.getByLabelText('input'), {
					target: { value: 'scp file user@host', selectionStart: 18 },
				});

				expect(handlers.setAtMentionOpen).toHaveBeenCalledWith(false);
				expect(handlers.setAtMentionOpen).not.toHaveBeenCalledWith(true);
			});
		});
	});
});

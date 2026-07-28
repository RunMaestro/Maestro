import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInputAreaTextChange } from '../../../../../renderer/components/InputArea/hooks/useInputAreaTextChange';

function Harness({
	isTerminalMode = false,
	slashCommandOpen = false,
	handlers,
}: {
	isTerminalMode?: boolean;
	slashCommandOpen?: boolean;
	handlers: Record<string, ReturnType<typeof vi.fn>>;
}) {
	const keystrokeResizeScheduledRef = useRef(false);
	const onChange = useInputAreaTextChange({
		isTerminalMode,
		slashCommandOpen,
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

	it('scrolls past the cap when the caret sits before trailing text on the final line', () => {
		const handlers = createHandlers();
		const runAnimationFrame = vi.fn((callback: FrameRequestCallback): number => {
			callback(0);
			return 1;
		});
		vi.stubGlobal('requestAnimationFrame', runAnimationFrame);
		render(<Harness handlers={handlers} />);
		const textarea = screen.getByLabelText('input') as HTMLTextAreaElement;
		// Content well past TEXTAREA_MAX_HEIGHT, caret in the middle of the last row
		// (what an inserted mention or trailing whitespace leaves behind). That row is
		// the one being typed on, so it has to end up visible.
		const value = `${'line\n'.repeat(80)}trailing`;
		const caret = value.length - 4;
		textarea.scrollTop = 0;
		Object.defineProperty(textarea, 'scrollHeight', { value: 640, configurable: true });
		Object.defineProperty(textarea, 'selectionEnd', { value: caret, configurable: true });

		fireEvent.change(textarea, {
			target: { value, selectionStart: caret },
		});

		expect(runAnimationFrame).toHaveBeenCalledTimes(1);
		expect(textarea.style.height).toBe('176px');
		expect(textarea.scrollTop).toBe(640);
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
		// caret is in the final logical line, so the keystroke resize must preserve the
		// scroll rather than jump the viewport to the bottom.
		Object.defineProperty(textarea, 'selectionEnd', { value: 2, configurable: true });

		fireEvent.change(textarea, {
			target: { value, selectionStart: 2 },
		});

		expect(textarea.scrollTop).toBe(42);
	});
});

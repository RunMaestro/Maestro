import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useInputAreaTextChange } from '../../../../../renderer/components/InputArea/hooks/useInputAreaTextChange';

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

	it('pins the scroll to the bottom after a keystroke when the caret is at the end', () => {
		const handlers = createHandlers();
		const rafSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((cb: FrameRequestCallback) => {
				cb(0);
				return 0;
			});
		render(<Harness handlers={handlers} />);
		const textarea = screen.getByLabelText('input') as HTMLTextAreaElement;
		Object.defineProperty(textarea, 'scrollHeight', { value: 500, configurable: true });

		fireEvent.change(textarea, { target: { value: 'hello world', selectionStart: 11 } });

		expect(textarea.scrollTop).toBe(500);
		rafSpy.mockRestore();
	});

	it('leaves the scroll position alone when editing mid-text', () => {
		const handlers = createHandlers();
		const rafSpy = vi
			.spyOn(window, 'requestAnimationFrame')
			.mockImplementation((cb: FrameRequestCallback) => {
				cb(0);
				return 0;
			});
		render(<Harness handlers={handlers} />);
		const textarea = screen.getByLabelText('input') as HTMLTextAreaElement;
		Object.defineProperty(textarea, 'scrollHeight', { value: 500, configurable: true });
		textarea.scrollTop = 42;

		fireEvent.change(textarea, { target: { value: 'hello world', selectionStart: 3 } });

		expect(textarea.scrollTop).toBe(42);
		rafSpy.mockRestore();
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

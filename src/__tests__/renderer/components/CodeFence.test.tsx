import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { CodeFence, DETECTION_DEBOUNCE_MS } from '../../../renderer/components/CodeFence/CodeFence';
import { mockTheme } from '../../helpers/mockTheme';

// Drains the microtask queue so promise continuations chained inside the
// detection effect (resolveLanguage, detectLanguage) settle while fake timers
// are active. A couple of turns covers the awaits in the detection chain.
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await Promise.resolve();
	}
}

// Mock Shiki so CodeFence's async highlighting doesn't hit the real library.
// The highlight effect is exercised indirectly; we only assert on the resolved
// language (the `data-language` attribute), which is set before/around
// highlighting completes.
vi.mock('shiki', () => ({
	createHighlighter: vi.fn(async () => ({
		codeToHtml: () => '<pre class="shiki"><code>mocked</code></pre>',
		getLoadedLanguages: () => [],
		loadLanguage: async () => undefined,
	})),
	bundledLanguagesInfo: [],
	bundledLanguagesAlias: {},
}));

// Mock highlight.js so `detectLanguage` is fully controllable. Default: no
// confident guess, so individual tests opt in to a detection result.
const { mockHighlightAuto } = vi.hoisted(() => ({
	mockHighlightAuto: vi.fn(() => ({ language: null, relevance: 0 })),
}));
vi.mock('highlight.js', () => ({
	default: { highlightAuto: mockHighlightAuto },
}));

// Mock lucide-react icons used by CodeFence (the LanguagePicker is mocked
// separately below, so its icons don't matter here).
vi.mock('lucide-react', () => ({
	Clipboard: () => <span data-testid="clipboard-icon">Clipboard</span>,
}));

// Replace the real LanguagePicker (portal + async bundled-language loading)
// with a trivial stub that surfaces the current language and a button that
// fires `onChange`. This isolates CodeFence's own resolution logic, which is
// what bug #1080 is about, from the picker's UI internals.
vi.mock('../../../renderer/components/CodeFence/LanguagePicker', () => ({
	LanguagePicker: ({
		language,
		onChange,
	}: {
		language: string;
		onChange: (lang: string) => void;
	}) => (
		<button
			type="button"
			data-testid="lang-picker"
			data-picker-language={language}
			onClick={() => onChange('rust')}
		>
			{language}
		</button>
	),
}));

const defaultProps = {
	language: '',
	code: '',
	theme: mockTheme,
	onCopy: vi.fn(),
};

function fence() {
	return document.querySelector('[data-testid="code-fence"]');
}

function langOf() {
	return fence()!.getAttribute('data-language');
}

describe('CodeFence', () => {
	beforeEach(() => {
		mockHighlightAuto.mockReset();
		mockHighlightAuto.mockReturnValue({ language: null, relevance: 0 });
	});

	it('auto-detects a language for an untagged fence', async () => {
		// A bare fence has no explicit tag, so detection runs against the body.
		mockHighlightAuto.mockReturnValue({ language: 'javascript', relevance: 10 });
		render(<CodeFence {...defaultProps} language="" code='console.log("hello world");' />);
		await waitFor(() => {
			expect(langOf()).toBe('javascript');
		});
	});

	it('keeps a manually picked language after subsequent streaming code updates', async () => {
		// Fake timers let us deterministically flush the detection debounce
		// (DETECTION_DEBOUNCE_MS = 150ms) plus the async detectLanguage chain,
		// instead of sleeping a fixed wall-clock duration. A real-time sleep can
		// pass vacuously on a loaded runner (if the process is suspended, the
		// stray detection that should clobber the manual pick may never actually
		// fire), which silently weakens this negative-assertion regression gate.
		vi.useFakeTimers();
		try {
			// Untagged fence: detection would normally drive the language.
			// Detection stays unconfident here so the only thing that changes the
			// language is the user's pick.
			mockHighlightAuto.mockReturnValue({ language: null, relevance: 0 });
			const { rerender } = render(<CodeFence {...defaultProps} language="" code="const a = 1;" />);

			// Bare fence with no detection: flush the debounce + async detection so
			// it resolves to the plain-text fallback before the user picks.
			await act(async () => {
				vi.advanceTimersByTime(DETECTION_DEBOUNCE_MS + 10);
				await flushMicrotasks();
			});
			expect(langOf()).toBe('text');

			// User picks a language via the picker (stub fires onChange('rust')).
			act(() => {
				fireEvent.click(screen.getByTestId('lang-picker'));
			});
			expect(langOf()).toBe('rust');

			// Simulate streaming: more code keeps arriving, and detection would now
			// confidently guess a DIFFERENT language (javascript). If the override
			// guard regressed, a stray detection here would clobber the pick back
			// to javascript - so the assertion below would fail.
			mockHighlightAuto.mockReturnValue({ language: 'javascript', relevance: 50 });
			rerender(<CodeFence {...defaultProps} language="" code="const a = 1; const b = 2;" />);
			rerender(
				<CodeFence {...defaultProps} language="" code="const a = 1; const b = 2; const c = 3;" />
			);

			// Deterministically give the debounce + any pending detection a real
			// chance to run and (wrongly) overwrite the choice. Advancing past the
			// debounce window and flushing microtasks guarantees the detection path
			// had its full opportunity to fire; the override ref must still hold.
			await act(async () => {
				vi.advanceTimersByTime(DETECTION_DEBOUNCE_MS + 10);
				await flushMicrotasks();
			});

			expect(langOf()).toBe('rust');
		} finally {
			vi.useRealTimers();
		}
	});

	it('debounces detection so streaming does not thrash the resolved language', async () => {
		vi.useFakeTimers();
		try {
			mockHighlightAuto.mockReturnValue({ language: 'javascript', relevance: 50 });
			const { rerender } = render(<CodeFence {...defaultProps} language="" code="const a = 1;" />);

			// Stream several updates faster than the debounce window. Detection
			// feeds off the debounced snapshot, so highlightAuto should not fire
			// once per keystroke.
			for (let i = 2; i <= 6; i++) {
				rerender(
					<CodeFence {...defaultProps} language="" code={`const a = 1;${' x'.repeat(i)}`} />
				);
				act(() => {
					vi.advanceTimersByTime(20);
				});
			}

			const callsWhileStreaming = mockHighlightAuto.mock.calls.length;

			// Let the debounce settle. Detection now runs against the final
			// snapshot.
			await act(async () => {
				vi.advanceTimersByTime(200);
				await Promise.resolve();
			});

			// With debouncing intact, detection does NOT fire per streamed update.
			// The 5 mid-stream rerenders all land inside the 150ms debounce window
			// (only 20ms is advanced between each), so `debouncedCode` never changes
			// and the detection effect never re-runs. At most the initial mount
			// detection is in flight here. Without debouncing this would be ~5-6
			// (one detection per streamed character), so this bound is what catches
			// a broken/removed debounce.
			expect(callsWhileStreaming).toBeLessThanOrEqual(1);
			// After the debounce settles, detection runs exactly once more against
			// the final snapshot. Total is therefore the single mount detection plus
			// that one settling detection = 2. (It would be ~6 if detection fired
			// per character.)
			expect(mockHighlightAuto.mock.calls.length).toBeLessThanOrEqual(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('reuses cached highlighted HTML on remount instead of flashing the plain fallback', async () => {
		const code = 'const cachedHighlight = true;';
		const { unmount } = render(<CodeFence {...defaultProps} language="ts" code={code} />);

		await waitFor(() => {
			expect(document.querySelector('.shiki-host')?.textContent).toContain('mocked');
		});

		unmount();
		render(<CodeFence {...defaultProps} language="ts" code={code} />);

		expect(document.querySelector('.shiki-host')?.textContent).toContain('mocked');
	});
});

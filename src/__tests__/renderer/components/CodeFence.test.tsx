import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { CodeFence } from '../../../renderer/components/CodeFence/CodeFence';
import { mockTheme } from '../../helpers/mockTheme';

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
		// Untagged fence: detection would normally drive the language. Detection
		// stays unconfident here so the only thing that changes the language is
		// the user's pick.
		mockHighlightAuto.mockReturnValue({ language: null, relevance: 0 });
		const { rerender } = render(<CodeFence {...defaultProps} language="" code="const a = 1;" />);

		// Bare fence with no detection resolves to the plain-text fallback first.
		await waitFor(() => {
			expect(langOf()).toBe('text');
		});

		// User picks a language via the picker (stub fires onChange('rust')).
		fireEvent.click(screen.getByTestId('lang-picker'));
		await waitFor(() => {
			expect(langOf()).toBe('rust');
		});

		// Simulate streaming: more code keeps arriving. Even if detection would
		// now guess something, the manual override must win.
		mockHighlightAuto.mockReturnValue({ language: 'javascript', relevance: 50 });
		rerender(<CodeFence {...defaultProps} language="" code="const a = 1; const b = 2;" />);
		rerender(
			<CodeFence {...defaultProps} language="" code="const a = 1; const b = 2; const c = 3;" />
		);

		// Give any pending detection/effects a chance to run and (wrongly)
		// overwrite the choice. The override ref must hold.
		await new Promise((resolve) => setTimeout(resolve, 250));
		await waitFor(() => {
			expect(langOf()).toBe('rust');
		});
		expect(langOf()).toBe('rust');
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

			// Detection fired far fewer times than the number of streamed updates
			// (it would be ~6 without debouncing). The exact count depends on the
			// async detection chain, so we only assert it stayed bounded.
			expect(callsWhileStreaming).toBeLessThanOrEqual(2);
			expect(mockHighlightAuto.mock.calls.length).toBeLessThanOrEqual(3);
		} finally {
			vi.useRealTimers();
		}
	});
});

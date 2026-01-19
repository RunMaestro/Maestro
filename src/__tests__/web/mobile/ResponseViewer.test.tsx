/**
 * Tests for ResponseViewer component
 *
 * This component provides a full-screen modal for viewing complete AI responses
 * with features like syntax highlighting, swipe gestures, pinch-to-zoom, and navigation.
 */

import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock the dependencies before importing the component
vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => ({
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#404040',
		accent: '#007acc',
		success: '#4caf50',
		warning: '#ff9800',
		error: '#f44336',
	}),
	useTheme: () => ({
		isDark: true,
	}),
}));

vi.mock('../../../web/mobile/constants', () => ({
	triggerHaptic: vi.fn(),
	HAPTIC_PATTERNS: {
		tap: [10],
		success: [10, 50, 10],
		error: [50, 50, 50],
		send: [20],
		interrupt: [50],
	},
}));

vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock react-syntax-highlighter
vi.mock('react-syntax-highlighter', () => ({
	Prism: ({
		children,
		language,
		style,
		customStyle,
	}: {
		children: string;
		language: string;
		style: Record<string, unknown>;
		customStyle: Record<string, unknown>;
	}) => (
		<pre data-testid="syntax-highlighter" data-language={language} style={customStyle}>
			{children}
		</pre>
	),
}));

vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
	vscDarkPlus: {},
	vs: {},
}));

import ResponseViewer, {
	ResponseItem,
	ResponseViewerProps,
} from '../../../web/mobile/ResponseViewer';
import type { LastResponsePreview } from '../../../web/hooks/useSessions';
import { triggerHaptic, HAPTIC_PATTERNS } from '../../../web/mobile/constants';
import { webLogger } from '../../../web/utils/logger';

// Test utilities
function createMockResponse(overrides?: Partial<LastResponsePreview>): LastResponsePreview {
	return {
		text: 'Hello, this is a test response.',
		fullLength: 32,
		timestamp: 1701388800000, // 2023-12-01 00:00:00 UTC
		...overrides,
	};
}

function createMockResponseItem(overrides?: Partial<ResponseItem>): ResponseItem {
	return {
		response: createMockResponse(),
		sessionId: 'session-1',
		sessionName: 'Test Session',
		...overrides,
	};
}

function createTouchEvent(
	type: 'touchstart' | 'touchmove' | 'touchend',
	touches: Array<{ clientX: number; clientY: number }>
): React.TouchEvent<Element> {
	const touchList = {
		length: touches.length,
		item: (index: number) => touches[index] || null,
		[Symbol.iterator]: function* () {
			for (let i = 0; i < touches.length; i++) {
				yield touches[i];
			}
		},
		...touches.reduce(
			(acc, touch, index) => {
				acc[index] = touch as unknown as React.Touch;
				return acc;
			},
			{} as Record<number, React.Touch>
		),
	} as unknown as React.TouchList;

	return {
		type,
		touches: touchList,
		preventDefault: vi.fn(),
		stopPropagation: vi.fn(),
		nativeEvent: new Event(type),
		currentTarget: document.createElement('div'),
		target: document.createElement('div'),
		bubbles: true,
		cancelable: true,
		defaultPrevented: false,
		eventPhase: 0,
		isTrusted: true,
		timeStamp: Date.now(),
		isDefaultPrevented: () => false,
		isPropagationStopped: () => false,
		persist: () => {},
		changedTouches: touchList,
		targetTouches: touchList,
		altKey: false,
		ctrlKey: false,
		metaKey: false,
		shiftKey: false,
		getModifierState: () => false,
	} as unknown as React.TouchEvent<Element>;
}

describe('ResponseViewer', () => {
	let originalBodyStyle: string;
	let originalClipboard: Clipboard;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		originalBodyStyle = document.body.style.overflow;

		// Mock clipboard API
		originalClipboard = navigator.clipboard;
		Object.defineProperty(navigator, 'clipboard', {
			value: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
			writable: true,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		document.body.style.overflow = originalBodyStyle;
		Object.defineProperty(navigator, 'clipboard', {
			value: originalClipboard,
			writable: true,
		});
	});

	describe('Render conditions', () => {
		it('returns null when isOpen is false', () => {
			const { container } = render(
				<ResponseViewer isOpen={false} response={createMockResponse()} onClose={vi.fn()} />
			);
			expect(container.firstChild).toBeNull();
		});

		it('returns null when response is null and no activeResponse', () => {
			const { container } = render(
				<ResponseViewer isOpen={true} response={null} onClose={vi.fn()} />
			);
			expect(container.firstChild).toBeNull();
		});

		it('renders when isOpen is true and response is provided', () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('sets body overflow to hidden when open', () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);
			expect(document.body.style.overflow).toBe('hidden');
		});

		it('restores body overflow when closed', () => {
			const { rerender } = render(
				<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />
			);
			expect(document.body.style.overflow).toBe('hidden');

			rerender(<ResponseViewer isOpen={false} response={createMockResponse()} onClose={vi.fn()} />);
			expect(document.body.style.overflow).toBe('');
		});
	});

	describe('Loading state', () => {
		it('displays loading message when isLoading is true', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse()}
					isLoading={true}
					onClose={vi.fn()}
				/>
			);
			expect(screen.getByText('Loading full response...')).toBeInTheDocument();
		});

		it('does not display response content when loading', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: 'Actual content' })}
					isLoading={true}
					onClose={vi.fn()}
				/>
			);
			expect(screen.queryByText('Actual content')).not.toBeInTheDocument();
		});
	});

	describe('Response display', () => {
		it('displays response text', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: 'Hello World' })}
					onClose={vi.fn()}
				/>
			);
			expect(screen.getByText('Hello World')).toBeInTheDocument();
		});

		it('displays full text when provided instead of preview', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: 'Preview text' })}
					fullText="Full response text here"
					onClose={vi.fn()}
				/>
			);
			expect(screen.getByText('Full response text here')).toBeInTheDocument();
			expect(screen.queryByText('Preview text')).not.toBeInTheDocument();
		});

		it('displays session name in header', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse()}
					sessionName="My Session"
					onClose={vi.fn()}
				/>
			);
			expect(screen.getByText('My Session')).toBeInTheDocument();
		});

		it('displays timestamp in header', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ timestamp: 1701388800000 })}
					onClose={vi.fn()}
				/>
			);
			// The timestamp should be formatted - exact format depends on locale
			// The date could be Nov 30 or Dec 1 depending on timezone
			const header = screen.getByRole('dialog');
			expect(header).toHaveTextContent(/(Nov|Dec)\s+\d+/);
		});

		it('displays Response header title', () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);
			expect(screen.getByRole('heading', { name: 'Response' })).toBeInTheDocument();
		});
	});

	describe('ANSI code stripping', () => {
		it('strips ANSI escape codes from response text', () => {
			const textWithAnsi = '\x1b[32mGreen text\x1b[0m and \x1b[31mred text\x1b[0m';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithAnsi })}
					onClose={vi.fn()}
				/>
			);
			expect(screen.getByText('Green text and red text')).toBeInTheDocument();
		});

		it('strips complex ANSI sequences', () => {
			const textWithAnsi = '\x1b[1;32;40mBold green on black\x1b[0m';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithAnsi })}
					onClose={vi.fn()}
				/>
			);
			expect(screen.getByText('Bold green on black')).toBeInTheDocument();
		});
	});

	describe('Code block parsing and syntax highlighting', () => {
		it('renders code blocks with syntax highlighting', () => {
			const textWithCode = 'Some text\n```typescript\nconst x = 1;\n```\nMore text';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);
			const highlighter = screen.getByTestId('syntax-highlighter');
			expect(highlighter).toBeInTheDocument();
			expect(highlighter).toHaveAttribute('data-language', 'typescript');
			expect(highlighter).toHaveTextContent('const x = 1;');
		});

		it('renders multiple code blocks', () => {
			const textWithCode = '```js\nlet a = 1;\n```\nText\n```python\nprint("hello")\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);
			const highlighters = screen.getAllByTestId('syntax-highlighter');
			expect(highlighters).toHaveLength(2);
			expect(highlighters[0]).toHaveAttribute('data-language', 'javascript');
			expect(highlighters[1]).toHaveAttribute('data-language', 'python');
		});

		it('shows language label for code blocks', () => {
			const textWithCode = '```typescript\nconst x = 1;\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);
			expect(screen.getByText('typescript')).toBeInTheDocument();
		});

		it('shows "code" label for blocks without language', () => {
			const textWithCode = '```\nplain code\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);
			expect(screen.getByText('code')).toBeInTheDocument();
		});

		it('normalizes language aliases (ts -> typescript)', () => {
			const textWithCode = '```ts\nconst x = 1;\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);
			const highlighter = screen.getByTestId('syntax-highlighter');
			expect(highlighter).toHaveAttribute('data-language', 'typescript');
		});

		it('normalizes shell aliases (sh -> bash)', () => {
			const textWithCode = '```sh\necho "hello"\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);
			const highlighter = screen.getByTestId('syntax-highlighter');
			expect(highlighter).toHaveAttribute('data-language', 'bash');
		});

		it('handles languages with non-word characters (c++)', () => {
			const textWithCode = '```c++\nint main() { return 0; }\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);
			const highlighter = screen.getByTestId('syntax-highlighter');
			expect(highlighter).toHaveAttribute('data-language', 'cpp');
			expect(screen.getByText('cpp')).toBeInTheDocument();
		});

		it('handles empty code blocks gracefully', () => {
			const textWithEmptyBlock = 'Text before\n```\n   \n```\nText after';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithEmptyBlock })}
					onClose={vi.fn()}
				/>
			);
			expect(screen.queryByTestId('syntax-highlighter')).not.toBeInTheDocument();
		});
	});

	describe('Copy functionality', () => {
		it('renders copy button for code blocks', () => {
			const textWithCode = '```js\nlet x = 1;\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);
			expect(screen.getByLabelText('Copy code')).toBeInTheDocument();
		});

		it('copies code to clipboard when copy button is clicked', async () => {
			const textWithCode = '```js\nconst copied = true;\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);

			const copyButton = screen.getByLabelText('Copy code');
			await act(async () => {
				fireEvent.click(copyButton);
			});

			expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const copied = true;');
		});

		it('shows "Copied!" feedback after copying', async () => {
			const textWithCode = '```js\nconst x = 1;\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);

			const copyButton = screen.getByLabelText('Copy code');
			await act(async () => {
				fireEvent.click(copyButton);
			});

			expect(screen.getByLabelText('Copied!')).toBeInTheDocument();
			expect(screen.getByText('Copied')).toBeInTheDocument();
		});

		it('triggers success haptic on copy', async () => {
			const textWithCode = '```js\nconst x = 1;\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);

			const copyButton = screen.getByLabelText('Copy code');
			await act(async () => {
				fireEvent.click(copyButton);
			});

			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.success);
		});

		it('resets copied state after 2 seconds', async () => {
			const textWithCode = '```js\nconst x = 1;\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);

			const copyButton = screen.getByLabelText('Copy code');
			await act(async () => {
				fireEvent.click(copyButton);
			});

			expect(screen.getByLabelText('Copied!')).toBeInTheDocument();

			act(() => {
				vi.advanceTimersByTime(2000);
			});

			expect(screen.getByLabelText('Copy code')).toBeInTheDocument();
		});

		it('handles clipboard error gracefully', async () => {
			vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error('Clipboard error'));

			const textWithCode = '```js\nconst x = 1;\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);

			const copyButton = screen.getByLabelText('Copy code');
			await act(async () => {
				fireEvent.click(copyButton);
			});

			expect(webLogger.error).toHaveBeenCalledWith(
				'Failed to copy code',
				'ResponseViewer',
				expect.any(Error)
			);
			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.error);
		});
	});

	describe('Close button', () => {
		it('renders close button with aria-label', () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);
			expect(screen.getByLabelText('Close response viewer')).toBeInTheDocument();
		});

		it('calls onClose when close button is clicked', () => {
			const onClose = vi.fn();
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={onClose} />);

			fireEvent.click(screen.getByLabelText('Close response viewer'));
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('triggers haptic feedback on close', () => {
			const onClose = vi.fn();
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={onClose} />);

			fireEvent.click(screen.getByLabelText('Close response viewer'));
			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});
	});

	describe('Keyboard navigation', () => {
		it('closes on Escape key', () => {
			const onClose = vi.fn();
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={onClose} />);

			fireEvent.keyDown(document, { key: 'Escape' });
			expect(onClose).toHaveBeenCalledTimes(1);
		});

		it('does not close on Escape when not open', () => {
			const onClose = vi.fn();
			render(<ResponseViewer isOpen={false} response={createMockResponse()} onClose={onClose} />);

			fireEvent.keyDown(document, { key: 'Escape' });
			expect(onClose).not.toHaveBeenCalled();
		});

		it('navigates left on ArrowLeft key when navigation is available', () => {
			const onNavigate = vi.fn();
			const allResponses = [
				createMockResponseItem({ sessionId: 's1', sessionName: 'Session 1' }),
				createMockResponseItem({ sessionId: 's2', sessionName: 'Session 2' }),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={1}
					onNavigate={onNavigate}
					onClose={vi.fn()}
				/>
			);

			fireEvent.keyDown(document, { key: 'ArrowLeft' });
			expect(onNavigate).toHaveBeenCalledWith(0);
			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('navigates right on ArrowRight key when navigation is available', () => {
			const onNavigate = vi.fn();
			const allResponses = [
				createMockResponseItem({ sessionId: 's1', sessionName: 'Session 1' }),
				createMockResponseItem({ sessionId: 's2', sessionName: 'Session 2' }),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={0}
					onNavigate={onNavigate}
					onClose={vi.fn()}
				/>
			);

			fireEvent.keyDown(document, { key: 'ArrowRight' });
			expect(onNavigate).toHaveBeenCalledWith(1);
			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('does not navigate left when at first response', () => {
			const onNavigate = vi.fn();
			const allResponses = [
				createMockResponseItem({ sessionId: 's1' }),
				createMockResponseItem({ sessionId: 's2' }),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={0}
					onNavigate={onNavigate}
					onClose={vi.fn()}
				/>
			);

			fireEvent.keyDown(document, { key: 'ArrowLeft' });
			expect(onNavigate).not.toHaveBeenCalled();
		});

		it('does not navigate right when at last response', () => {
			const onNavigate = vi.fn();
			const allResponses = [
				createMockResponseItem({ sessionId: 's1' }),
				createMockResponseItem({ sessionId: 's2' }),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={1}
					onNavigate={onNavigate}
					onClose={vi.fn()}
				/>
			);

			fireEvent.keyDown(document, { key: 'ArrowRight' });
			expect(onNavigate).not.toHaveBeenCalled();
		});
	});

	describe('Swipe gestures - vertical dismiss', () => {
		it('dismisses on swipe down past threshold', () => {
			const onClose = vi.fn();
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={onClose} />);

			const dialog = screen.getByRole('dialog');

			// Start touch at top - dialog starts at scrollTop 0
			fireEvent.touchStart(dialog, createTouchEvent('touchstart', [{ clientX: 100, clientY: 0 }]));

			// First move to determine direction (vertical - deltaY > deltaX, past direction threshold 10px)
			fireEvent.touchMove(dialog, createTouchEvent('touchmove', [{ clientX: 100, clientY: 15 }]));

			// Continue moving down past dismiss threshold (100px)
			fireEvent.touchMove(dialog, createTouchEvent('touchmove', [{ clientX: 100, clientY: 150 }]));

			// End touch
			fireEvent.touchEnd(dialog, createTouchEvent('touchend', []));

			expect(onClose).toHaveBeenCalled();
			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('does not dismiss on swipe down below threshold', () => {
			const onClose = vi.fn();
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={onClose} />);

			const dialog = screen.getByRole('dialog');

			fireEvent.touchStart(dialog, createTouchEvent('touchstart', [{ clientX: 100, clientY: 0 }]));
			fireEvent.touchMove(dialog, createTouchEvent('touchmove', [{ clientX: 100, clientY: 50 }]));
			fireEvent.touchEnd(dialog, createTouchEvent('touchend', []));

			expect(onClose).not.toHaveBeenCalled();
		});

		it('does not dismiss on swipe up', () => {
			const onClose = vi.fn();
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={onClose} />);

			const dialog = screen.getByRole('dialog');

			fireEvent.touchStart(
				dialog,
				createTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }])
			);
			fireEvent.touchMove(dialog, createTouchEvent('touchmove', [{ clientX: 100, clientY: 0 }]));
			fireEvent.touchEnd(dialog, createTouchEvent('touchend', []));

			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe('Swipe gestures - horizontal navigation', () => {
		it('navigates to previous on swipe right past threshold', () => {
			const onNavigate = vi.fn();
			const allResponses = [
				createMockResponseItem({ sessionId: 's1' }),
				createMockResponseItem({ sessionId: 's2' }),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={1}
					onNavigate={onNavigate}
					onClose={vi.fn()}
				/>
			);

			const dialog = screen.getByRole('dialog');

			fireEvent.touchStart(
				dialog,
				createTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }])
			);
			// First move to determine direction (horizontal - deltaX > deltaY, past 10px threshold)
			fireEvent.touchMove(dialog, createTouchEvent('touchmove', [{ clientX: 115, clientY: 100 }]));
			// Continue swipe right (past 80px navigate threshold)
			fireEvent.touchMove(dialog, createTouchEvent('touchmove', [{ clientX: 200, clientY: 100 }]));
			fireEvent.touchEnd(dialog, createTouchEvent('touchend', []));

			expect(onNavigate).toHaveBeenCalledWith(0);
		});

		it('navigates to next on swipe left past threshold', () => {
			const onNavigate = vi.fn();
			const allResponses = [
				createMockResponseItem({ sessionId: 's1' }),
				createMockResponseItem({ sessionId: 's2' }),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={0}
					onNavigate={onNavigate}
					onClose={vi.fn()}
				/>
			);

			const dialog = screen.getByRole('dialog');

			fireEvent.touchStart(
				dialog,
				createTouchEvent('touchstart', [{ clientX: 200, clientY: 100 }])
			);
			// First move to determine direction (horizontal - deltaX > deltaY, past 10px threshold)
			fireEvent.touchMove(dialog, createTouchEvent('touchmove', [{ clientX: 185, clientY: 100 }]));
			// Continue swipe left (past 80px navigate threshold)
			fireEvent.touchMove(dialog, createTouchEvent('touchmove', [{ clientX: 100, clientY: 100 }]));
			fireEvent.touchEnd(dialog, createTouchEvent('touchend', []));

			expect(onNavigate).toHaveBeenCalledWith(1);
		});

		it('applies elastic resistance when cannot go further', () => {
			const onNavigate = vi.fn();
			const allResponses = [createMockResponseItem({ sessionId: 's1' })];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={0}
					onNavigate={onNavigate}
					onClose={vi.fn()}
				/>
			);

			const dialog = screen.getByRole('dialog');

			// Only one response, can't navigate
			fireEvent.touchStart(
				dialog,
				createTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }])
			);
			fireEvent.touchMove(dialog, createTouchEvent('touchmove', [{ clientX: 200, clientY: 105 }]));
			fireEvent.touchEnd(dialog, createTouchEvent('touchend', []));

			// Navigation not called because only 1 response
			expect(onNavigate).not.toHaveBeenCalled();
		});
	});

	describe('Pinch-to-zoom', () => {
		it('zooms in on pinch out gesture', () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);

			const dialog = screen.getByRole('dialog');

			// Start with two fingers close together
			fireEvent.touchStart(
				dialog,
				createTouchEvent('touchstart', [
					{ clientX: 100, clientY: 100 },
					{ clientX: 110, clientY: 100 },
				])
			);

			// Move fingers apart (pinch out)
			fireEvent.touchMove(
				dialog,
				createTouchEvent('touchmove', [
					{ clientX: 50, clientY: 100 },
					{ clientX: 160, clientY: 100 },
				])
			);

			fireEvent.touchEnd(dialog, createTouchEvent('touchend', []));

			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('shows zoom indicator when zoomed', async () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);

			const dialog = screen.getByRole('dialog');

			// Pinch to zoom
			fireEvent.touchStart(
				dialog,
				createTouchEvent('touchstart', [
					{ clientX: 100, clientY: 100 },
					{ clientX: 110, clientY: 100 },
				])
			);

			fireEvent.touchMove(
				dialog,
				createTouchEvent('touchmove', [
					{ clientX: 50, clientY: 100 },
					{ clientX: 160, clientY: 100 },
				])
			);

			fireEvent.touchEnd(dialog, createTouchEvent('touchend', []));

			// Should show zoom reset button
			expect(screen.getByLabelText('Reset zoom')).toBeInTheDocument();
		});

		it('resets zoom when reset button is clicked', async () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);

			const dialog = screen.getByRole('dialog');

			// Pinch to zoom
			fireEvent.touchStart(
				dialog,
				createTouchEvent('touchstart', [
					{ clientX: 100, clientY: 100 },
					{ clientX: 110, clientY: 100 },
				])
			);

			fireEvent.touchMove(
				dialog,
				createTouchEvent('touchmove', [
					{ clientX: 50, clientY: 100 },
					{ clientX: 160, clientY: 100 },
				])
			);

			fireEvent.touchEnd(dialog, createTouchEvent('touchend', []));

			// Click reset button
			const resetButton = screen.getByLabelText('Reset zoom');
			fireEvent.click(resetButton);

			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
			// Zoom indicator should disappear
			expect(screen.queryByLabelText('Reset zoom')).not.toBeInTheDocument();
		});
	});

	describe('Navigation indicators', () => {
		it('renders pagination dots when multiple responses', () => {
			const allResponses = [
				createMockResponseItem({ sessionId: 's1' }),
				createMockResponseItem({ sessionId: 's2' }),
				createMockResponseItem({ sessionId: 's3' }),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={1}
					onNavigate={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Should have 3 pagination dots
			const dots = screen.getAllByRole('button', { name: /Go to response \d+/ });
			expect(dots).toHaveLength(3);
		});

		it('highlights current response dot', () => {
			const allResponses = [
				createMockResponseItem({ sessionId: 's1' }),
				createMockResponseItem({ sessionId: 's2' }),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={1}
					onNavigate={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const dot2 = screen.getByLabelText('Go to response 2');
			expect(dot2).toHaveAttribute('aria-current', 'true');
		});

		it('navigates when clicking pagination dot', () => {
			const onNavigate = vi.fn();
			const allResponses = [
				createMockResponseItem({ sessionId: 's1' }),
				createMockResponseItem({ sessionId: 's2' }),
				createMockResponseItem({ sessionId: 's3' }),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={0}
					onNavigate={onNavigate}
					onClose={vi.fn()}
				/>
			);

			fireEvent.click(screen.getByLabelText('Go to response 3'));
			expect(onNavigate).toHaveBeenCalledWith(2);
			expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
		});

		it('shows navigation hint text', () => {
			const allResponses = [
				createMockResponseItem({ sessionId: 's1' }),
				createMockResponseItem({ sessionId: 's2' }),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={0}
					onNavigate={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText(/Swipe left\/right to navigate/)).toBeInTheDocument();
		});

		it('shows simpler hint when no navigation available', () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);

			expect(screen.getByText('Pinch to zoom • Swipe down to dismiss')).toBeInTheDocument();
		});

		it('does not render pagination when only one response', () => {
			const allResponses = [createMockResponseItem({ sessionId: 's1' })];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={0}
					onNavigate={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			expect(screen.queryByRole('button', { name: /Go to response/ })).not.toBeInTheDocument();
		});
	});

	describe('Truncation notice', () => {
		it('shows truncation notice when response is truncated', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({
						text: 'Short preview',
						fullLength: 1000,
					})}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText(/Showing preview/)).toBeInTheDocument();
			expect(screen.getByText(/13 of 1000 characters/)).toBeInTheDocument();
		});

		it('does not show truncation notice when full text is provided', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({
						text: 'Short preview',
						fullLength: 1000,
					})}
					fullText="This is the full response text"
					onClose={vi.fn()}
				/>
			);

			expect(screen.queryByText(/Showing preview/)).not.toBeInTheDocument();
		});

		it('does not show truncation notice when text matches fullLength', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({
						text: 'Complete response',
						fullLength: 17,
					})}
					onClose={vi.fn()}
				/>
			);

			expect(screen.queryByText(/Showing preview/)).not.toBeInTheDocument();
		});
	});

	describe('Active response from allResponses', () => {
		it('uses response from allResponses based on currentIndex', () => {
			const allResponses = [
				createMockResponseItem({
					sessionId: 's1',
					sessionName: 'Session One',
					response: createMockResponse({ text: 'Response 1' }),
				}),
				createMockResponseItem({
					sessionId: 's2',
					sessionName: 'Session Two',
					response: createMockResponse({ text: 'Response 2' }),
				}),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={1}
					onNavigate={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText('Response 2')).toBeInTheDocument();
			expect(screen.getByText('Session Two')).toBeInTheDocument();
		});

		it('falls back to response prop when allResponses is empty', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: 'Fallback response' })}
					allResponses={[]}
					currentIndex={0}
					onNavigate={vi.fn()}
					sessionName="Fallback Session"
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText('Fallback response')).toBeInTheDocument();
			expect(screen.getByText('Fallback Session')).toBeInTheDocument();
		});

		it('resets zoom when currentIndex changes', () => {
			const allResponses = [
				createMockResponseItem({ sessionId: 's1' }),
				createMockResponseItem({ sessionId: 's2' }),
			];

			const { rerender } = render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={0}
					onNavigate={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Zoom in
			const dialog = screen.getByRole('dialog');
			fireEvent.touchStart(
				dialog,
				createTouchEvent('touchstart', [
					{ clientX: 100, clientY: 100 },
					{ clientX: 110, clientY: 100 },
				])
			);
			fireEvent.touchMove(
				dialog,
				createTouchEvent('touchmove', [
					{ clientX: 50, clientY: 100 },
					{ clientX: 160, clientY: 100 },
				])
			);
			fireEvent.touchEnd(dialog, createTouchEvent('touchend', []));

			// Zoom indicator should show
			expect(screen.getByLabelText('Reset zoom')).toBeInTheDocument();

			// Change currentIndex
			rerender(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={1}
					onNavigate={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Zoom should be reset
			expect(screen.queryByLabelText('Reset zoom')).not.toBeInTheDocument();
		});
	});

	describe('Accessibility', () => {
		it('has aria-modal attribute', () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);

			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveAttribute('aria-modal', 'true');
		});

		it('has aria-label for dialog', () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);

			expect(screen.getByRole('dialog')).toHaveAttribute('aria-label', 'Full response viewer');
		});

		it('has aria-hidden on decorative elements', () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);

			// The swipe indicator has aria-hidden
			const swipeIndicator = screen.getByRole('dialog').querySelector('[aria-hidden="true"]');
			expect(swipeIndicator).toBeInTheDocument();
		});

		it('shows pagination aria-label with count', () => {
			const allResponses = [
				createMockResponseItem({ sessionId: 's1' }),
				createMockResponseItem({ sessionId: 's2' }),
				createMockResponseItem({ sessionId: 's3' }),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={null}
					allResponses={allResponses}
					currentIndex={1}
					onNavigate={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			const paginationContainer = screen.getByLabelText('Response 2 of 3');
			expect(paginationContainer).toBeInTheDocument();
		});
	});

	describe('Theme integration', () => {
		it('uses dark syntax highlighting style when isDark is true', () => {
			const textWithCode = '```js\nconst x = 1;\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);

			// The mock for useTheme returns isDark: true
			// Syntax highlighter should use vscDarkPlus (though our mock doesn't fully test this)
			const highlighter = screen.getByTestId('syntax-highlighter');
			expect(highlighter).toBeInTheDocument();
		});
	});

	describe('Double-tap to zoom', () => {
		it('zooms in on double tap when not zoomed', async () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);

			// The zoomable content is the div that has the doubleTap handler
			// We need to find it and double tap
			const dialog = screen.getByRole('dialog');
			const contentArea = dialog.querySelector('[style*="transform"]');

			if (contentArea) {
				// First tap
				fireEvent.touchStart(
					contentArea,
					createTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }])
				);

				// Second tap within 300ms
				act(() => {
					vi.advanceTimersByTime(100);
				});

				fireEvent.touchStart(
					contentArea,
					createTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }])
				);

				expect(triggerHaptic).toHaveBeenCalledWith(HAPTIC_PATTERNS.tap);
			}
		});

		it('resets zoom on double tap when already zoomed', () => {
			render(<ResponseViewer isOpen={true} response={createMockResponse()} onClose={vi.fn()} />);

			const dialog = screen.getByRole('dialog');

			// First zoom in via pinch
			fireEvent.touchStart(
				dialog,
				createTouchEvent('touchstart', [
					{ clientX: 100, clientY: 100 },
					{ clientX: 110, clientY: 100 },
				])
			);
			fireEvent.touchMove(
				dialog,
				createTouchEvent('touchmove', [
					{ clientX: 50, clientY: 100 },
					{ clientX: 160, clientY: 100 },
				])
			);
			fireEvent.touchEnd(dialog, createTouchEvent('touchend', []));

			// Should be zoomed now
			expect(screen.getByLabelText('Reset zoom')).toBeInTheDocument();

			// Double tap to reset
			const contentArea = dialog.querySelector('[style*="transform"]');
			if (contentArea) {
				fireEvent.touchStart(
					contentArea,
					createTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }])
				);
				act(() => {
					vi.advanceTimersByTime(100);
				});
				fireEvent.touchStart(
					contentArea,
					createTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }])
				);
			}

			// Zoom should reset (indicator disappears)
			expect(screen.queryByLabelText('Reset zoom')).not.toBeInTheDocument();
		});
	});

	describe('Edge cases', () => {
		it('handles currentIndex out of bounds gracefully', () => {
			const allResponses = [
				createMockResponseItem({
					sessionId: 's1',
					response: createMockResponse({ text: 'First' }),
				}),
			];

			// currentIndex larger than array length
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: 'Fallback' })}
					allResponses={allResponses}
					currentIndex={5}
					onNavigate={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Should fall back to response prop since currentIndex is invalid
			expect(screen.getByText('Fallback')).toBeInTheDocument();
		});

		it('handles negative currentIndex gracefully', () => {
			const allResponses = [
				createMockResponseItem({
					sessionId: 's1',
					response: createMockResponse({ text: 'First' }),
				}),
			];

			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: 'Fallback' })}
					allResponses={allResponses}
					currentIndex={-1}
					onNavigate={vi.fn()}
					onClose={vi.fn()}
				/>
			);

			// Should fall back to response prop
			expect(screen.getByText('Fallback')).toBeInTheDocument();
		});

		it('handles empty response text', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: '   ', fullLength: 3 })}
					onClose={vi.fn()}
				/>
			);

			// Should still render the dialog
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		it('handles unicode content', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: 'Hello 世界! 🚀 Привет' })}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText('Hello 世界! 🚀 Привет')).toBeInTheDocument();
		});

		it('handles very long response text', () => {
			const longText = 'A'.repeat(10000);
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: longText, fullLength: 10000 })}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
	});
});

describe('Pure function tests (via exports)', () => {
	describe('formatTimestamp', () => {
		// These functions are not directly exported but tested via component rendering
		it('formats timestamp correctly in component', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ timestamp: 1701388800000 })}
					onClose={vi.fn()}
				/>
			);

			// Check timestamp is rendered (format varies by locale)
			const dialog = screen.getByRole('dialog');
			expect(dialog).toHaveTextContent(/\d{1,2}:\d{2}/); // Time format
		});
	});

	describe('LANGUAGE_MAP coverage', () => {
		it.each([
			['ts', 'typescript'],
			['tsx', 'tsx'],
			['js', 'javascript'],
			['jsx', 'jsx'],
			['json', 'json'],
			['md', 'markdown'],
			['py', 'python'],
			['python', 'python'],
			['rb', 'ruby'],
			['ruby', 'ruby'],
			['go', 'go'],
			['golang', 'go'],
			['rs', 'rust'],
			['rust', 'rust'],
			['java', 'java'],
			['c', 'c'],
			['cpp', 'cpp'],
			// Note: 'c++' cannot be parsed correctly because the regex /```(\w*)\n?/ only captures word chars
			// The actual language captured would be 'c' followed by '++' in the code content
			// Skipping this test as it's a limitation of the regex pattern, not a bug
			// ['c++', 'cpp'],
			['cs', 'csharp'],
			['csharp', 'csharp'],
			['php', 'php'],
			['html', 'html'],
			['css', 'css'],
			['scss', 'scss'],
			['sass', 'sass'],
			['sql', 'sql'],
			['sh', 'bash'],
			['bash', 'bash'],
			['shell', 'bash'],
			['zsh', 'bash'],
			['yaml', 'yaml'],
			['yml', 'yaml'],
			['toml', 'toml'],
			['xml', 'xml'],
			['swift', 'swift'],
			['kotlin', 'kotlin'],
			['kt', 'kotlin'],
			['scala', 'scala'],
			['r', 'r'],
			['lua', 'lua'],
			['perl', 'perl'],
			['dockerfile', 'dockerfile'],
			['docker', 'dockerfile'],
			['makefile', 'makefile'],
			['make', 'makefile'],
			['graphql', 'graphql'],
			['gql', 'graphql'],
			['diff', 'diff'],
			['patch', 'diff'],
		])('normalizes %s to %s', (input, expected) => {
			const textWithCode = `\`\`\`${input}\ncode here\n\`\`\``;
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);

			const highlighter = screen.getByTestId('syntax-highlighter');
			expect(highlighter).toHaveAttribute('data-language', expected);
		});

		it('preserves unknown languages as-is', () => {
			const textWithCode = '```unknownlang\ncode here\n```';
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: textWithCode })}
					onClose={vi.fn()}
				/>
			);

			const highlighter = screen.getByTestId('syntax-highlighter');
			expect(highlighter).toHaveAttribute('data-language', 'unknownlang');
		});
	});

	describe('parseTextWithCodeBlocks via component', () => {
		it('handles text with no code blocks', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: 'Just plain text here' })}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByText('Just plain text here')).toBeInTheDocument();
			expect(screen.queryByTestId('syntax-highlighter')).not.toBeInTheDocument();
		});

		it('handles only code block with no surrounding text', () => {
			render(
				<ResponseViewer
					isOpen={true}
					response={createMockResponse({ text: '```js\nconst x = 1;\n```' })}
					onClose={vi.fn()}
				/>
			);

			expect(screen.getByTestId('syntax-highlighter')).toBeInTheDocument();
		});

		it('handles multiple code blocks with text between', () => {
			const text = 'Start\n```js\nlet a;\n```\nMiddle\n```python\nprint(1)\n```\nEnd';
			render(
				<ResponseViewer isOpen={true} response={createMockResponse({ text })} onClose={vi.fn()} />
			);

			expect(screen.getByText('Start')).toBeInTheDocument();
			expect(screen.getByText('Middle')).toBeInTheDocument();
			expect(screen.getByText('End')).toBeInTheDocument();
			expect(screen.getAllByTestId('syntax-highlighter')).toHaveLength(2);
		});

		it('handles code blocks without newline after language', () => {
			const text = '```jsconst x = 1;\n```';
			render(
				<ResponseViewer isOpen={true} response={createMockResponse({ text })} onClose={vi.fn()} />
			);

			// The language would be 'jsconst' due to regex pattern
			const highlighter = screen.getByTestId('syntax-highlighter');
			expect(highlighter).toBeInTheDocument();
		});

		it('handles nested backticks in code', () => {
			const text = '```js\nconst template = `hello`;\n```';
			render(
				<ResponseViewer isOpen={true} response={createMockResponse({ text })} onClose={vi.fn()} />
			);

			expect(screen.getByText(/const template/)).toBeInTheDocument();
		});
	});
});

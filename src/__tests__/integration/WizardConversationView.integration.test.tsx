import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	WizardConversationView,
	type WizardConversationViewProps,
} from '../../renderer/components/InlineWizard/WizardConversationView';
import type { Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'wizard-integration',
	name: 'Wizard Integration',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#242424',
		border: '#3a3a3a',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#60a5fa',
		accentDim: '#60a5fa20',
		accentText: '#93c5fd',
		accentForeground: '#0f172a',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const renderView = (props: Partial<WizardConversationViewProps> = {}) =>
	render(<WizardConversationView theme={theme} conversationHistory={[]} {...props} />);

describe('WizardConversationView integration', () => {
	let originalScrollTo: typeof HTMLElement.prototype.scrollTo | undefined;
	let scrollToSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		originalScrollTo = HTMLElement.prototype.scrollTo;
		scrollToSpy = vi.fn();
		Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
			configurable: true,
			value: scrollToSpy,
		});
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		vi.stubGlobal('cancelAnimationFrame', vi.fn());
	});

	afterEach(() => {
		if (originalScrollTo) {
			Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
				configurable: true,
				value: originalScrollTo,
			});
		} else {
			delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
		}
		vi.unstubAllGlobals();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('renders thinking content with running and completed tool execution details', () => {
		renderView({
			isLoading: true,
			showThinking: true,
			agentName: 'Codex',
			thinkingContent: 'Reviewing project structure',
			toolExecutions: [
				{
					toolName: 'Read',
					state: { status: 'complete', input: { file_path: 'docs/plan.md' } },
					timestamp: 1,
				},
				{
					toolName: 'Bash',
					state: { status: 'running', input: { command: 'npm run test:integration' } },
					timestamp: 2,
				},
			],
		});

		expect(screen.getByTestId('wizard-thinking-display')).toBeInTheDocument();
		expect(screen.getByTestId('thinking-display-content')).toHaveTextContent(
			'Reviewing project structure'
		);
		expect(screen.getByText('Read')).toBeInTheDocument();
		expect(screen.getByText('Bash')).toBeInTheDocument();
		expect(screen.getByText('docs/plan.md')).toBeInTheDocument();
		expect(screen.getByText('npm run test:integration')).toBeInTheDocument();
		expect(screen.getByText('✓')).toBeInTheDocument();
		expect(screen.getByText('●')).toBeInTheDocument();
	});

	it('maps wizard errors to friendly messages and wires retry and dismiss actions', () => {
		const onRetry = vi.fn();
		const onClearError = vi.fn();
		const { rerender } = renderView({
			error: 'session is not active',
			onRetry,
			onClearError,
		});

		expect(screen.getByTestId('error-title')).toHaveTextContent('Session Error');
		fireEvent.click(screen.getByTestId('error-retry-button'));
		fireEvent.click(screen.getByTestId('error-dismiss-button'));
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onClearError).toHaveBeenCalledTimes(1);

		rerender(
			<WizardConversationView
				theme={theme}
				conversationHistory={[]}
				error="failed to spawn codex"
			/>
		);
		expect(screen.getByTestId('error-title')).toHaveTextContent('Failed to Start Agent');

		rerender(
			<WizardConversationView
				theme={theme}
				conversationHistory={[]}
				error="agent exited with code 1"
			/>
		);
		expect(screen.getByTestId('error-title')).toHaveTextContent('Agent Error');

		rerender(
			<WizardConversationView
				theme={theme}
				conversationHistory={[]}
				error="failed to parse response"
			/>
		);
		expect(screen.getByTestId('error-title')).toHaveTextContent('Response Error');

		rerender(
			<WizardConversationView
				theme={theme}
				conversationHistory={[]}
				error="unexpected provider output"
			/>
		);
		expect(screen.getByTestId('error-title')).toHaveTextContent('Something Went Wrong');
		expect(screen.getByTestId('error-description')).toHaveTextContent('unexpected provider output');
	});

	it('suppresses auto-scroll after manual scroll but forces it for a new user message', () => {
		const firstMessage = {
			id: 'assistant-1',
			role: 'assistant' as const,
			content: 'Initial assistant reply',
			timestamp: 1,
		};
		const { rerender } = renderView({ conversationHistory: [firstMessage] });
		const container = screen.getByTestId('wizard-conversation-view');

		Object.defineProperties(container, {
			scrollHeight: { configurable: true, value: 1000 },
			clientHeight: { configurable: true, value: 300 },
			scrollTop: { configurable: true, value: 100 },
		});

		scrollToSpy.mockClear();
		fireEvent.scroll(container);

		rerender(
			<WizardConversationView
				theme={theme}
				conversationHistory={[
					firstMessage,
					{
						id: 'assistant-2',
						role: 'assistant',
						content: 'More assistant detail',
						timestamp: 2,
					},
				]}
			/>
		);
		expect(scrollToSpy).not.toHaveBeenCalled();

		rerender(
			<WizardConversationView
				theme={theme}
				conversationHistory={[
					firstMessage,
					{
						id: 'assistant-2',
						role: 'assistant',
						content: 'More assistant detail',
						timestamp: 2,
					},
					{
						id: 'user-1',
						role: 'user',
						content: 'Add this to the plan',
						timestamp: 3,
					},
				]}
			/>
		);

		expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' });
	});

	it('ignores programmatic scroll events and rotates typing filler phrases', () => {
		vi.useFakeTimers();
		const rafCallbacks: FrameRequestCallback[] = [];
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			rafCallbacks.push(callback);
			return rafCallbacks.length;
		});
		vi.stubGlobal('cancelAnimationFrame', vi.fn());

		const { unmount } = renderView({ isLoading: true, agentName: 'Codex' });
		const container = screen.getByTestId('wizard-conversation-view');

		Object.defineProperties(container, {
			scrollHeight: { configurable: true, value: 1000 },
			clientHeight: { configurable: true, value: 300 },
			scrollTop: { configurable: true, value: 100 },
		});

		fireEvent.scroll(container);

		act(() => {
			for (let index = 0; index < 120 && rafCallbacks.length > 0; index += 1) {
				rafCallbacks.shift()?.((index + 1) * 31);
			}
		});

		act(() => {
			vi.advanceTimersByTime(5000);
		});

		expect(screen.getByTestId('wizard-typing-indicator')).toBeInTheDocument();
		unmount();
	});
});

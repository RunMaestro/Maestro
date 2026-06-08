import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { mockTheme } from '../../../../../helpers/mockTheme';
import {
	ConfidenceMeter,
	ConversationErrorPanel,
	ConversationInputPanel,
	InitialQuestionBubble,
	MessageBubble,
	ReadyToProceedPanel,
	StreamingResponseBubble,
	ThinkingDisplay,
	ToolExecutionEntry,
} from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/components';
import type { WizardMessage } from '../../../../../../renderer/components/Wizard/WizardContext';

vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock('../../../../../../renderer/utils/markdownConfig', () => ({
	REMARK_GFM_PLUGINS: [],
	createWizardBubbleMarkdownComponents: () => ({}),
}));

const assistantMessage: WizardMessage = {
	id: 'assistant-1',
	role: 'assistant',
	content: '**Hello**',
	timestamp: 1_700_000_000_000,
	confidence: 88,
	ready: true,
};

describe('ConversationScreen components', () => {
	it('clamps confidence and shows ready copy at threshold', () => {
		render(<ConfidenceMeter confidence={120} theme={mockTheme} />);

		expect(screen.getByText('100%')).toBeInTheDocument();
		expect(screen.getByText('Ready to create your Playbook!')).toBeInTheDocument();
	});

	it('clamps low confidence without ready copy', () => {
		render(<ConfidenceMeter confidence={-10} theme={mockTheme} />);

		expect(screen.getByText('0%')).toBeInTheDocument();
		expect(screen.queryByText('Ready to create your Playbook!')).not.toBeInTheDocument();
	});

	it('renders user and assistant message bubbles with their distinct content paths', () => {
		const userMessage: WizardMessage = {
			id: 'user-1',
			role: 'user',
			content: 'Plain user text',
			timestamp: 1_700_000_000_000,
		};
		const { rerender } = render(
			<MessageBubble
				message={userMessage}
				theme={mockTheme}
				agentName="Project Agent"
				wizardMarkdownComponents={{}}
				providerName="Claude"
			/>
		);

		expect(screen.getByText('Plain user text')).toBeInTheDocument();
		expect(screen.queryByTestId('markdown')).not.toBeInTheDocument();

		rerender(
			<MessageBubble
				message={assistantMessage}
				theme={mockTheme}
				agentName="Project Agent"
				wizardMarkdownComponents={{}}
				providerName="Claude"
			/>
		);

		expect(screen.getByTestId('markdown')).toHaveTextContent('**Hello**');
		expect(screen.getByText('88% confident')).toBeInTheDocument();
		expect(screen.getByText('Claude')).toBeInTheDocument();
	});

	it('renders initial and streaming assistant bubbles', () => {
		render(
			<>
				<InitialQuestionBubble
					theme={mockTheme}
					agentName="Agent"
					initialQuestion="What is this?"
				/>
				<StreamingResponseBubble theme={mockTheme} agentName="Agent" streamingText="Streaming" />
			</>
		);

		expect(screen.getByText('What is this?')).toBeInTheDocument();
		expect(screen.getByText(/Streaming/)).toBeInTheDocument();
	});

	it('renders thinking fallback and tool execution detail', () => {
		const { rerender } = render(
			<ThinkingDisplay theme={mockTheme} agentName="Agent" thinkingContent="" toolExecutions={[]} />
		);

		expect(screen.getByTestId('thinking-display-content')).toHaveTextContent('Reasoning...');

		rerender(
			<ThinkingDisplay
				theme={mockTheme}
				agentName="Agent"
				thinkingContent="Planning"
				toolExecutions={[
					{
						toolName: 'Read',
						timestamp: 1,
						state: { status: 'complete', input: { file_path: '/tmp/file.ts' } },
					},
				]}
			/>
		);

		expect(screen.getByText('Planning')).toBeInTheDocument();
		expect(screen.getByText('Read')).toBeInTheDocument();
		expect(screen.getByText('/tmp/file.ts')).toBeInTheDocument();
	});

	it('renders running tool entries without unsafe object output', () => {
		render(
			<ToolExecutionEntry
				theme={mockTheme}
				tool={{
					toolName: 'Search',
					timestamp: 1,
					state: { status: 'running', input: { query: 'wizard' } },
				}}
			/>
		);

		expect(screen.getByText('Search')).toBeInTheDocument();
		expect(screen.getByText('wizard')).toBeInTheDocument();
	});

	it('wires error panel actions and non-retry recovery copy', () => {
		const onRetry = vi.fn();
		const onGoBack = vi.fn();
		const onDownloadDebugLogs = vi.fn();

		render(
			<ConversationErrorPanel
				theme={mockTheme}
				error="Raw error"
				detectedError={{
					type: 'auth_expired',
					title: 'Auth failed',
					message: 'Please sign in',
					recoveryHint: 'Run login',
					canRetry: false,
				}}
				errorRetryCount={3}
				onRetry={onRetry}
				onGoBack={onGoBack}
				onDownloadDebugLogs={onDownloadDebugLogs}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
		fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));
		fireEvent.click(screen.getByRole('button', { name: '(Debug Logs)' }));

		expect(screen.getByText('Auth failed')).toBeInTheDocument();
		expect(screen.getByText('Run login')).toBeInTheDocument();
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(onGoBack).toHaveBeenCalledTimes(1);
		expect(onDownloadDebugLogs).toHaveBeenCalledTimes(1);
	});

	it('shows Try Again after repeated generic errors', () => {
		render(
			<ConversationErrorPanel
				theme={mockTheme}
				error="Raw error"
				detectedError={null}
				errorRetryCount={3}
				onRetry={vi.fn()}
				onGoBack={vi.fn()}
				onDownloadDebugLogs={vi.fn()}
			/>
		);

		expect(screen.getByRole('button', { name: 'Try Again' })).toBeInTheDocument();
		expect(screen.getByText('Raw error')).toBeInTheDocument();
	});

	it('wires ready panel action', () => {
		const onLetsGo = vi.fn();
		render(<ReadyToProceedPanel theme={mockTheme} onLetsGo={onLetsGo} />);

		fireEvent.click(screen.getByRole('button', { name: "Let's Get Started!" }));

		expect(onLetsGo).toHaveBeenCalledTimes(1);
	});

	it('wires input send, shortcut, thinking toggle, disabled state, and resize', () => {
		const inputRef: React.MutableRefObject<HTMLTextAreaElement | null> = { current: null };
		const setInputValue = vi.fn();
		const setShowThinking = vi.fn();
		const onSendMessage = vi.fn();

		const { rerender } = render(
			<ConversationInputPanel
				theme={mockTheme}
				inputRef={inputRef}
				inputValue="hello"
				setInputValue={setInputValue}
				isConversationLoading={false}
				conversationHistory={[assistantMessage]}
				confidenceLevel={20}
				showThinking={false}
				setShowThinking={setShowThinking}
				onSendMessage={onSendMessage}
			/>
		);

		const textarea = screen.getByPlaceholderText('Describe your project...') as HTMLTextAreaElement;
		Object.defineProperty(textarea, 'scrollHeight', { configurable: true, value: 140 });
		fireEvent.change(textarea, { target: { value: 'updated' } });
		fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
		fireEvent.input(textarea);
		fireEvent.click(screen.getByRole('button', { name: /Send/i }));
		fireEvent.click(screen.getByTitle(/show ai thinking/i));

		expect(setInputValue).toHaveBeenCalled();
		expect(textarea.style.height).toBe('120px');
		expect(onSendMessage).toHaveBeenCalledTimes(2);
		expect(setShowThinking).toHaveBeenCalledWith(true);
		expect(screen.getByText('Your turn - continue the conversation')).toBeInTheDocument();

		rerender(
			<ConversationInputPanel
				theme={mockTheme}
				inputRef={inputRef}
				inputValue="hello"
				setInputValue={setInputValue}
				isConversationLoading={true}
				conversationHistory={[assistantMessage]}
				confidenceLevel={20}
				showThinking
				setShowThinking={setShowThinking}
				onSendMessage={onSendMessage}
			/>
		);

		expect(screen.getByPlaceholderText('Describe your project...')).toBeDisabled();
		expect(screen.getByRole('button', { name: /Send/i })).toBeDisabled();
		expect(screen.getByTitle(/hide ai thinking/i)).toBeInTheDocument();
	});

	it('keeps the send button disabled for blank input', () => {
		render(
			<ConversationInputPanel
				theme={mockTheme}
				inputRef={{ current: null }}
				inputValue="   "
				setInputValue={vi.fn()}
				isConversationLoading={false}
				conversationHistory={[]}
				confidenceLevel={0}
				showThinking={false}
				setShowThinking={vi.fn()}
				onSendMessage={vi.fn()}
			/>
		);

		expect(screen.getByRole('button', { name: /Send/i })).toBeDisabled();
		expect(screen.queryByText('Your turn - continue the conversation')).not.toBeInTheDocument();
	});
});

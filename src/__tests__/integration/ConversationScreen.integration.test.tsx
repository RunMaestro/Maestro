import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConversationScreen } from '../../renderer/components/Wizard/screens/ConversationScreen';
import {
	WizardProvider,
	useWizard,
	type WizardMessage,
	type WizardState,
} from '../../renderer/components/Wizard/WizardContext';
import type { Theme } from '../../renderer/types';
import { logger } from '../../renderer/utils/logger';

const mocks = vi.hoisted(() => ({
	startConversation: vi.fn(),
	endConversation: vi.fn(),
	isConversationActive: vi.fn(),
	sendMessage: vi.fn(),
	downloadLogs: vi.fn(),
	getNextFillerPhrase: vi.fn(),
	setShowThinking: vi.fn(),
	scrollIntoView: vi.fn(),
	typingIndicatorProps: null as { onRequestNewPhrase?: () => void } | null,
}));

vi.mock('../../renderer/components/Wizard/services/conversationManager', () => ({
	conversationManager: {
		startConversation: (...args: unknown[]) => mocks.startConversation(...args),
		endConversation: (...args: unknown[]) => mocks.endConversation(...args),
		isConversationActive: (...args: unknown[]) => mocks.isConversationActive(...args),
		sendMessage: (...args: unknown[]) => mocks.sendMessage(...args),
	},
	createUserMessage: (content: string) => ({
		id: `user-${content}`,
		role: 'user',
		content,
		timestamp: 1_700_000_000_000,
	}),
	createAssistantMessage: (response: any) => ({
		id: `assistant-${response.structured?.message ?? response.rawText ?? 'response'}`,
		role: 'assistant',
		content: response.structured?.message ?? response.rawText ?? '',
		timestamp: 1_700_000_060_000,
		confidence: response.structured?.confidence,
		ready: response.structured?.ready,
	}),
}));

vi.mock('../../renderer/components/Wizard/services/wizardPrompts', () => ({
	getConfidenceColor: (confidence: number) =>
		confidence >= 80 ? '#22c55e' : confidence >= 50 ? '#f59e0b' : '#ef4444',
	getInitialQuestion: () => 'What are we building today?',
	READY_CONFIDENCE_THRESHOLD: 80,
}));

vi.mock('../../renderer/components/Wizard/services/phaseGenerator', () => ({
	AUTO_RUN_FOLDER_NAME: 'Auto Run Docs',
	wizardDebugLogger: {
		downloadLogs: (...args: unknown[]) => mocks.downloadLogs(...args),
	},
}));

vi.mock('../../renderer/components/Wizard/services/fillerPhrases', () => ({
	getNextFillerPhrase: () => mocks.getNextFillerPhrase(),
}));

vi.mock('../../renderer/components/Wizard/shared/TypingIndicator', async () => {
	const React = await vi.importActual<typeof import('react')>('react');
	return {
		TypingIndicator: (props: { agentName: string; onRequestNewPhrase: () => void }) => {
			mocks.typingIndicatorProps = props;
			return React.createElement(
				'div',
				{ 'data-testid': 'wizard-typing-indicator' },
				props.agentName
			);
		},
	};
});

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#111827',
		bgSidebar: '#1f2937',
		bgActivity: '#0f172a',
		border: '#374151',
		textMain: '#f9fafb',
		textDim: '#9ca3af',
		accent: '#2563eb',
		accentForeground: '#ffffff',
		success: '#16a34a',
		warning: '#f59e0b',
		error: '#dc2626',
	},
};

const existingHistory: WizardMessage[] = [
	{
		id: 'assistant-1',
		role: 'assistant',
		content: '**Plan** looks good.',
		confidence: 72,
		timestamp: 1_700_000_000_000,
	},
	{
		id: 'user-1',
		role: 'user',
		content: 'Add mobile support.',
		timestamp: 1_700_000_060_000,
	},
	{
		id: 'system-1',
		role: 'system',
		content: 'Recovered from interruption.',
		timestamp: 1_700_000_120_000,
	},
];

let originalScrollIntoView: typeof Element.prototype.scrollIntoView | undefined;

function ConversationHarness({
	initialState = {},
	showThinking = false,
}: {
	initialState?: Partial<WizardState>;
	showThinking?: boolean;
}) {
	const wizard = useWizard();
	const [ready, setReady] = React.useState(false);

	React.useEffect(() => {
		wizard.restoreState({
			currentStep: 'conversation',
			selectedAgent: 'codex',
			directoryPath: '/repo',
			agentName: 'Launch Project',
			conversationHistory: [],
			confidenceLevel: 0,
			isReadyToProceed: false,
			isConversationLoading: false,
			conversationError: null,
			existingDocsChoice: null,
			sessionSshRemoteConfig: undefined,
			...initialState,
		});
		setReady(true);
	}, []);

	return (
		<>
			<div data-testid="current-step">{wizard.state.currentStep}</div>
			<div data-testid="confidence-level">{wizard.state.confidenceLevel}</div>
			<div data-testid="conversation-error">{wizard.state.conversationError ?? ''}</div>
			{ready && (
				<ConversationScreen
					theme={theme}
					showThinking={showThinking}
					setShowThinking={mocks.setShowThinking}
				/>
			)}
		</>
	);
}

function renderConversation(initialState?: Partial<WizardState>, showThinking = false) {
	return render(
		<WizardProvider>
			<ConversationHarness initialState={initialState} showThinking={showThinking} />
		</WizardProvider>
	);
}

describe('ConversationScreen integration', () => {
	beforeEach(() => {
		mocks.startConversation.mockReset();
		mocks.endConversation.mockReset();
		mocks.isConversationActive.mockReset();
		mocks.sendMessage.mockReset();
		mocks.downloadLogs.mockReset();
		mocks.getNextFillerPhrase.mockReset();
		mocks.setShowThinking.mockReset();
		mocks.scrollIntoView.mockReset();
		mocks.typingIndicatorProps = null;

		mocks.startConversation.mockResolvedValue('wizard-session');
		mocks.endConversation.mockResolvedValue(undefined);
		mocks.isConversationActive.mockReturnValue(true);
		mocks.sendMessage.mockResolvedValue({ success: true });
		mocks.getNextFillerPhrase.mockReturnValue('Reviewing the project details...');

		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: false });
		vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({ success: false });
		vi.mocked(window.maestro.settings.set).mockResolvedValue(undefined);

		originalScrollIntoView = Element.prototype.scrollIntoView;
		Element.prototype.scrollIntoView = mocks.scrollIntoView;
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		Element.prototype.scrollIntoView = originalScrollIntoView;
	});

	it('renders resumed history and advances when the wizard is ready', async () => {
		renderConversation({
			conversationHistory: existingHistory,
			confidenceLevel: 85,
			isReadyToProceed: true,
		});

		expect(await screen.findByText('Plan')).toBeInTheDocument();
		expect(screen.getByText('72% confident')).toBeInTheDocument();
		expect(screen.getByText('Codex')).toBeInTheDocument();
		expect(screen.getByText('Add mobile support.')).toBeInTheDocument();
		expect(screen.getByText('Recovered from interruption.')).toBeInTheDocument();
		expect(screen.getByText('Ready to create your Playbook!')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: "Let's Get Started!" }));

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('preparing-plan');
		});
		expect(mocks.startConversation).not.toHaveBeenCalled();
	});

	it('loads existing Auto Run documents and auto-sends the continuation prompt', async () => {
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
			success: true,
			files: ['Phase-01.md', 'Phase-02.md'],
		});
		vi.mocked(window.maestro.autorun.readDoc)
			.mockResolvedValueOnce({ success: true, content: '# Phase 1' })
			.mockRejectedValueOnce(new Error('missing file'));
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onComplete?.({
				success: true,
				response: {
					parseSuccess: true,
					rawText: 'Continue with more details.',
					structured: {
						confidence: 60,
						ready: false,
						message: 'Continue with more details.',
					},
				},
			});
			return { success: true };
		});
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

		renderConversation({ existingDocsChoice: 'continue' });

		await waitFor(() => {
			expect(mocks.startConversation).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: 'codex',
					directoryPath: '/repo',
					projectName: 'Launch Project',
					existingDocs: [{ filename: 'Phase-01.md', content: '# Phase 1' }],
				})
			);
		});

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 150));
		});

		await waitFor(() => {
			expect(mocks.sendMessage).toHaveBeenCalledWith(
				'Please analyze the existing Auto Run documents and provide a synopsis of the current plan.',
				[],
				expect.objectContaining({
					onChunk: expect.any(Function),
					onComplete: expect.any(Function),
					onError: expect.any(Function),
				})
			);
		});
		expect(warnSpy).toHaveBeenCalledWith(
			'Failed to read existing doc Phase-02.md:',
			undefined,
			expect.any(Error)
		);
		expect(await screen.findByText('Continue with more details.')).toBeInTheDocument();
		expect(screen.getByTestId('confidence-level')).toHaveTextContent('60');
	});

	it('handles initialization failures, missing agents, and existing document lookup fallbacks', async () => {
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

		mocks.startConversation.mockRejectedValueOnce(new Error('startup failed'));
		renderConversation();

		expect(
			(await screen.findAllByText('Failed to initialize conversation. Please try again.')).length
		).toBeGreaterThan(0);
		expect(errorSpy).toHaveBeenCalledWith(
			'Failed to initialize conversation:',
			undefined,
			expect.any(Error)
		);
		cleanup();

		mocks.startConversation.mockReset();
		mocks.startConversation.mockResolvedValue('wizard-session');
		mocks.sendMessage.mockClear();
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValueOnce({
			success: true,
			files: [],
		});
		renderConversation({ existingDocsChoice: 'continue' });

		await waitFor(() => expect(mocks.startConversation).toHaveBeenCalled());
		expect(mocks.startConversation.mock.calls[0][0].existingDocs).toBeUndefined();
		cleanup();

		mocks.startConversation.mockClear();
		vi.mocked(window.maestro.autorun.listDocs).mockRejectedValueOnce(new Error('list failed'));
		renderConversation({ existingDocsChoice: 'continue' });

		await waitFor(() => expect(mocks.startConversation).toHaveBeenCalled());
		expect(warnSpy).toHaveBeenCalledWith(
			'Failed to fetch existing docs:',
			undefined,
			expect.any(Error)
		);
		cleanup();

		mocks.startConversation.mockClear();
		mocks.isConversationActive.mockReturnValue(false);
		renderConversation({ selectedAgent: undefined });
		await screen.findByText('What are we building today?');
		expect(mocks.startConversation).not.toHaveBeenCalled();

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Start without an agent' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(
			(await screen.findAllByText('No agent selected. Please go back and select an agent.')).length
		).toBeGreaterThan(0);
	});

	it('restarts inactive continue-mode conversations and handles plain continuation responses', async () => {
		const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		mocks.isConversationActive.mockReturnValue(false);
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
			success: true,
			files: ['Phase-01.md', 'Phase-02.md'],
		});
		vi.mocked(window.maestro.autorun.readDoc)
			.mockResolvedValueOnce({ success: true, content: '# Phase 1' })
			.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({ success: true, content: '# Phase 1' })
			.mockRejectedValueOnce(new Error('read failed'));
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onChunk?.(
				'noise\n{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Analyzing"}}}'
			);
			callbacks.onThinkingChunk?.('private notes');
			callbacks.onThinkingChunk?.('{"confidence":80,"message":"json"}');
			callbacks.onToolExecution?.({
				toolName: 'Read',
				state: { status: 'complete', input: { file_path: '/repo/plan.md' } },
				timestamp: 2,
			});
			callbacks.onComplete?.({
				success: true,
				response: {
					parseSuccess: false,
					rawText: 'Plain analysis done.',
				},
			});
			return { success: true };
		});

		renderConversation({ existingDocsChoice: 'continue' }, true);

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 150));
		});

		await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalled());
		expect(mocks.startConversation).toHaveBeenCalledTimes(2);
		expect(mocks.startConversation.mock.calls[1][0].existingDocs).toEqual([
			{ filename: 'Phase-01.md', content: '# Phase 1' },
		]);
		expect(warnSpy).toHaveBeenCalledWith(
			'Failed to read existing doc Phase-02.md:',
			undefined,
			expect.any(Error)
		);
		expect(await screen.findByText('Plain analysis done.')).toBeInTheDocument();
	});

	it('sends user messages, records ready responses, and auto-continues deferred replies', async () => {
		const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
		mocks.isConversationActive.mockReturnValue(false);
		mocks.sendMessage
			.mockImplementationOnce(async (_message, _history, callbacks) => {
				callbacks.onChunk?.(
					'not json\n{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Drafting"}}}'
				);
				callbacks.onThinkingChunk?.('private reasoning');
				callbacks.onThinkingChunk?.('{"confidence":80,"message":"json"}');
				callbacks.onToolExecution?.({
					toolName: 'Read',
					state: { status: 'complete', input: { file_path: '/repo/README.md' } },
					timestamp: 1,
				});
				callbacks.onComplete?.({
					success: true,
					response: {
						parseSuccess: true,
						rawText: 'Let me research this.',
						structured: {
							confidence: 85,
							ready: true,
							message: 'Let me research this.',
						},
					},
				});
				return { success: true };
			})
			.mockImplementationOnce(async (_message, _history, callbacks) => {
				callbacks.onComplete?.({
					success: true,
					response: {
						parseSuccess: true,
						rawText: 'Analysis complete.',
						structured: {
							confidence: 90,
							ready: true,
							message: 'Analysis complete.',
						},
					},
				});
				return { success: true };
			});

		renderConversation(undefined, true);
		await screen.findByText('What are we building today?');

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Build a planning app' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findByText('Let me research this.')).toBeInTheDocument();
		expect(mocks.startConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'codex',
				directoryPath: '/repo',
				projectName: 'Launch Project',
			})
		);
		expect(screen.getByTestId('confidence-level')).toHaveTextContent('85');
		expect(logSpy).toHaveBeenCalledWith(
			'[ConversationScreen] Detected deferred response phrase, scheduling auto-continue'
		);

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 850));
		});

		await waitFor(() => {
			expect(mocks.sendMessage).toHaveBeenCalledTimes(2);
		});
		expect(mocks.sendMessage.mock.calls[1][0]).toBe('Please proceed with your analysis.');
		expect(await screen.findByText('Analysis complete.')).toBeInTheDocument();
	});

	it('handles non-ready, plain, and failed continuation responses', async () => {
		const logSpy = vi.spyOn(logger, 'info').mockImplementation(() => {});
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		mocks.sendMessage
			.mockImplementationOnce(async (_message, _history, callbacks) => {
				callbacks.onComplete?.({
					success: true,
					response: {
						parseSuccess: true,
						rawText: 'Need more detail.',
						structured: {
							confidence: 45,
							ready: false,
							message: 'Need more detail.',
						},
					},
				});
				return { success: true };
			})
			.mockImplementationOnce(async (_message, _history, callbacks) => {
				callbacks.onComplete?.({
					success: true,
					response: {
						parseSuccess: false,
						rawText: 'Plain response.',
					},
				});
				return { success: true };
			});
		renderConversation();
		const input = screen.getByPlaceholderText('Describe your project...');

		fireEvent.change(input, { target: { value: 'What else do you need?' } });
		fireEvent.click(screen.getByRole('button', { name: /send/i }));
		expect(await screen.findByText('Need more detail.')).toBeInTheDocument();
		expect(screen.getByTestId('confidence-level')).toHaveTextContent('45');

		fireEvent.change(input, { target: { value: 'Here is more context.' } });
		fireEvent.click(screen.getByRole('button', { name: /send/i }));
		expect(await screen.findByText('Plain response.')).toBeInTheDocument();
		cleanup();

		mocks.sendMessage.mockReset();
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onError?.('Continue callback failed');
			return {
				success: false,
				error: 'Continue result failed',
				detectedError: {
					title: 'Continue Failed',
					message: 'The continuation could not finish.',
					recoveryHint: 'Try sending the message again.',
					canRetry: true,
				},
			};
		});
		renderConversation({ existingDocsChoice: 'continue' });

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 150));
		});

		expect(await screen.findByText('Continue Failed')).toBeInTheDocument();
		expect(screen.getByText('The continuation could not finish.')).toBeInTheDocument();
		expect(errorSpy).toHaveBeenCalledWith(
			'Conversation error:',
			undefined,
			'Continue callback failed'
		);
		expect(logSpy).toHaveBeenCalledWith('[ConversationScreen] No structured data in response');
	});

	it('shows live thinking and tool details while a response is pending', async () => {
		mocks.sendMessage.mockImplementation((_message, _history, callbacks) => {
			callbacks.onThinkingChunk?.('Tracing the repository');
			callbacks.onThinkingChunk?.('{"confidence":80,"message":"structured response"}');
			callbacks.onToolExecution?.({
				toolName: 'Read',
				state: { status: 'running', input: { file_path: '/repo/README.md' } },
				timestamp: 1,
			});
			callbacks.onToolExecution?.({
				toolName: 'Bash',
				state: { status: 'complete', input: { command: 'pnpm test' } },
				timestamp: 2,
			});
			callbacks.onToolExecution?.({
				toolName: 'Idle',
				timestamp: 3,
			});
			return new Promise(() => {});
		});

		renderConversation({ conversationHistory: existingHistory }, true);

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Inspect the docs' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findByTestId('wizard-thinking-display')).toBeInTheDocument();
		expect(screen.getByTestId('thinking-display-content')).toHaveTextContent(
			'Tracing the repository'
		);
		expect(screen.queryByText('structured response')).not.toBeInTheDocument();
		expect(screen.getByText('Read')).toBeInTheDocument();
		expect(screen.getByText('Bash')).toBeInTheDocument();
		expect(screen.getByText('Idle')).toBeInTheDocument();
		expect(screen.getByText('/repo/README.md')).toBeInTheDocument();
	});

	it('handles send exceptions, textarea resizing, and thinking toggle controls', async () => {
		mocks.sendMessage.mockRejectedValueOnce('plain failure');
		renderConversation({ conversationHistory: existingHistory });
		const input = screen.getByPlaceholderText('Describe your project...') as HTMLTextAreaElement;
		Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 180 });

		fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
		expect(mocks.sendMessage).not.toHaveBeenCalled();

		fireEvent.input(input);
		expect(input.style.height).toBe('120px');

		fireEvent.click(screen.getByRole('button', { name: /thinking/i }));
		expect(mocks.setShowThinking).toHaveBeenCalledWith(true);

		fireEvent.change(input, {
			target: { value: 'Trigger a thrown failure' },
		});
		fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });

		expect((await screen.findAllByText('Unknown error occurred')).length).toBeGreaterThan(0);

		fireEvent.keyDown(input, { key: 'Escape' });
		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('directory-selection');
		});
	});

	it('surfaces provider recovery details, debug logs, retry, and back navigation', async () => {
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onError?.('Agent timed out');
			return {
				success: false,
				error: 'Authentication failed',
				detectedError: {
					title: 'Authentication Required',
					message: 'Please sign in again.',
					recoveryHint: 'Run the provider login command.',
					canRetry: false,
				},
			};
		});
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

		renderConversation({ conversationHistory: existingHistory });

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Try again' },
		});
		fireEvent.keyDown(screen.getByPlaceholderText('Describe your project...'), {
			key: 'Enter',
			metaKey: true,
		});

		expect(await screen.findByText('Authentication Required')).toBeInTheDocument();
		expect(screen.getByText('Please sign in again.')).toBeInTheDocument();
		expect(screen.getByText('Run the provider login command.')).toBeInTheDocument();
		expect(errorSpy).toHaveBeenCalledWith('Conversation error:', undefined, 'Agent timed out');

		fireEvent.click(screen.getByRole('button', { name: '(Debug Logs)' }));
		expect(mocks.downloadLogs).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
		await waitFor(() => {
			expect(screen.getByTestId('conversation-error')).toHaveTextContent('');
		});

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Try once more' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));
		await screen.findByText('Authentication Required');
		fireEvent.click(screen.getByRole('button', { name: 'Go Back' }));

		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('directory-selection');
		});
	});

	it('initializes unnamed projects and renders provider fallback labels', async () => {
		renderConversation({
			agentName: undefined as any,
			selectedAgent: 'claude-code',
			conversationHistory: [
				{
					id: 'assistant-claude',
					role: 'assistant',
					content: 'Claude response.',
					timestamp: 1_700_000_000_000,
				},
			],
		});
		expect(await screen.findByText('Claude response.')).toBeInTheDocument();
		expect(screen.getByText('Claude')).toBeInTheDocument();
		expect(screen.getByText('🤖 Agent')).toBeInTheDocument();
		cleanup();

		renderConversation({
			agentName: undefined as any,
			selectedAgent: 'opencode',
			conversationHistory: [
				{
					id: 'assistant-opencode',
					role: 'assistant',
					content: 'OpenCode response.',
					timestamp: 1_700_000_000_000,
				},
			],
		});
		expect(await screen.findByText('OpenCode response.')).toBeInTheDocument();
		expect(screen.getByText('OpenCode')).toBeInTheDocument();
		cleanup();

		renderConversation({
			agentName: undefined as any,
			selectedAgent: 'custom-agent' as any,
			conversationHistory: [
				{
					id: 'assistant-custom',
					role: 'assistant',
					content: 'Custom response.',
					timestamp: 1_700_000_000_000,
				},
			],
		});
		expect(await screen.findByText('Custom response.')).toBeInTheDocument();
		expect(screen.getByText('custom-agent')).toBeInTheDocument();
		cleanup();

		renderConversation({
			agentName: undefined as any,
			selectedAgent: 'codex',
		});
		await waitFor(() => {
			expect(mocks.startConversation).toHaveBeenLastCalledWith(
				expect.objectContaining({ projectName: 'My Project' })
			);
		});
		expect(await screen.findByText('🤖 Agent')).toBeInTheDocument();
	});

	it('keeps startup completion from updating after unmount', async () => {
		let resolveStart!: (sessionId: string) => void;
		mocks.startConversation.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					resolveStart = resolve;
				})
		);

		renderConversation();
		await waitFor(() => expect(resolveStart).toEqual(expect.any(Function)));
		cleanup();

		await act(async () => {
			resolveStart('late-session');
			await Promise.resolve();
		});

		expect(mocks.startConversation).toHaveBeenCalledTimes(1);
	});

	it('guards duplicate sends and renders minimal thinking plus rotating filler phrases', async () => {
		let resolveSend!: (value: { success: boolean }) => void;
		mocks.sendMessage.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveSend = resolve;
				})
		);
		renderConversation(undefined, true);
		await screen.findByText('What are we building today?');

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Keep this pending' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findByTestId('wizard-thinking-display')).toBeInTheDocument();
		expect(screen.getByTestId('thinking-display-content')).toHaveTextContent('Reasoning...');
		expect(mocks.sendMessage).toHaveBeenCalledTimes(1);

		await act(async () => {
			resolveSend({ success: true });
			await Promise.resolve();
		});

		cleanup();
		renderConversation({ isConversationLoading: true });
		expect(screen.getByTestId('wizard-typing-indicator')).toBeInTheDocument();
		act(() => {
			mocks.typingIndicatorProps?.onRequestNewPhrase?.();
		});
		expect(mocks.getNextFillerPhrase).toHaveBeenCalledTimes(2);
	});

	it('renders streaming fallback branches and handles thrown send errors', async () => {
		let resolveSend!: (value: { success: boolean }) => void;
		mocks.sendMessage.mockImplementationOnce(async (_message, _history, callbacks) => {
			callbacks.onChunk?.(
				'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Streaming answer"}}}'
			);
			return new Promise((resolve) => {
				resolveSend = resolve;
			});
		});
		renderConversation({ agentName: undefined as any });
		await screen.findByText('What are we building today?');

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Stream a response' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findByText(/Streaming answer/)).toBeInTheDocument();
		expect(screen.getAllByText('🤖 Agent').length).toBeGreaterThan(0);
		await act(async () => {
			resolveSend({ success: true });
			await Promise.resolve();
		});
		cleanup();

		mocks.sendMessage.mockRejectedValueOnce(new Error('object failure'));
		renderConversation();
		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Throw an Error object' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));
		expect((await screen.findAllByText('object failure')).length).toBeGreaterThan(0);
	});

	it('hides thinking callbacks and handles non-callback send failures without metadata', async () => {
		mocks.sendMessage.mockImplementationOnce(async (_message, _history, callbacks) => {
			callbacks.onThinkingChunk?.('Hidden reasoning');
			callbacks.onToolExecution?.({
				toolName: 'Read',
				state: { status: 'running', input: { path: '/repo/secret.md' } },
				timestamp: 5,
			});
			callbacks.onComplete?.({ success: false });
			return { success: false, error: 'Plain send failure' };
		});

		renderConversation(undefined, false);
		await screen.findByText('What are we building today?');
		await waitFor(() => expect(mocks.startConversation).toHaveBeenCalled());
		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Fail without detected metadata' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect((await screen.findAllByText('Plain send failure')).length).toBeGreaterThan(0);
		expect(screen.queryByText('Hidden reasoning')).not.toBeInTheDocument();
		expect(screen.queryByText('/repo/secret.md')).not.toBeInTheDocument();
	});

	it('restarts continue mode with existing docs and covers hidden thinking callbacks', async () => {
		let resolveSend!: (value: { success: boolean }) => void;
		mocks.isConversationActive.mockReturnValue(false);
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
			success: true,
			files: ['Phase-01.md'],
		});
		vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({
			success: true,
			content: '# Phase 1',
		});
		mocks.sendMessage.mockImplementationOnce(async (_message, _history, callbacks) => {
			callbacks.onThinkingChunk?.('Visible thinking');
			callbacks.onThinkingChunk?.('{"message":"skip this"}');
			callbacks.onToolExecution?.({
				toolName: 'Read',
				state: { status: 'complete', input: { path: '/repo/phase.md' } },
				timestamp: 3,
			});
			return new Promise((resolve) => {
				resolveSend = resolve;
			});
		});

		renderConversation(
			{
				agentName: undefined as any,
				existingDocsChoice: 'continue',
			},
			true
		);

		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 150));
		});

		await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalled());
		expect(mocks.startConversation).toHaveBeenLastCalledWith(
			expect.objectContaining({
				existingDocs: [{ filename: 'Phase-01.md', content: '# Phase 1' }],
				projectName: 'My Project',
			})
		);
		expect(await screen.findByText('Visible thinking')).toBeInTheDocument();
		expect(screen.getByText('Read')).toBeInTheDocument();
		expect(screen.queryByText('skip this')).not.toBeInTheDocument();

		await act(async () => {
			resolveSend({ success: true });
			await Promise.resolve();
		});
	});

	it('covers continue-mode restart fallback responses and document loading fallbacks', async () => {
		mocks.isConversationActive.mockReturnValue(false);
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
			success: true,
			files: ['Phase-01.md'],
		});
		vi.mocked(window.maestro.autorun.readDoc).mockResolvedValue({ success: false });
		mocks.sendMessage.mockImplementationOnce(async (_message, _history, callbacks) => {
			callbacks.onComplete?.({
				success: true,
				response: {
					parseSuccess: true,
					rawText: 'Ready continue response.',
					structured: {
						confidence: 90,
						ready: true,
						message: 'Ready continue response.',
					},
				},
			});
			return { success: true };
		});

		renderConversation(
			{
				agentName: undefined as any,
				existingDocsChoice: 'continue',
			},
			false
		);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 150));
		});

		await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalled());
		expect(mocks.startConversation).toHaveBeenLastCalledWith(
			expect.objectContaining({
				existingDocs: undefined,
				projectName: 'My Project',
			})
		);
		expect(await screen.findByText('Ready continue response.')).toBeInTheDocument();
		expect(screen.getByText('Ready to create your Playbook!')).toBeInTheDocument();
		cleanup();

		mocks.isConversationActive.mockReturnValue(false);
		vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({ success: false });
		mocks.sendMessage.mockImplementationOnce(async (_message, _history, callbacks) => {
			callbacks.onThinkingChunk?.('Hidden thinking');
			callbacks.onToolExecution?.({
				toolName: 'Read',
				state: { status: 'running', input: { path: '/repo/hidden.md' } },
				timestamp: 4,
			});
			callbacks.onComplete?.({ success: false });
			return { success: false, error: 'Continue failed without metadata' };
		});

		renderConversation({ existingDocsChoice: 'continue' }, false);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 150));
		});

		expect((await screen.findAllByText('Continue failed without metadata')).length).toBeGreaterThan(
			0
		);
		expect(screen.queryByText('Hidden thinking')).not.toBeInTheDocument();
		expect(screen.queryByText('/repo/hidden.md')).not.toBeInTheDocument();
	});

	it('handles continue-mode loading guard and thrown failures', async () => {
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});

		renderConversation({
			existingDocsChoice: 'continue',
			isConversationLoading: true,
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 150));
		});
		expect(mocks.sendMessage).not.toHaveBeenCalled();
		cleanup();

		mocks.sendMessage.mockRejectedValueOnce('plain continue failure');
		renderConversation({ existingDocsChoice: 'continue' });
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 150));
		});
		expect((await screen.findAllByText('Unknown error occurred')).length).toBeGreaterThan(0);
		cleanup();

		mocks.sendMessage.mockRejectedValueOnce(new Error('continue object failure'));
		renderConversation({ existingDocsChoice: 'continue' });
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 150));
		});
		expect((await screen.findAllByText('continue object failure')).length).toBeGreaterThan(0);
		expect(errorSpy).not.toHaveBeenCalledWith(
			'Conversation error:',
			undefined,
			'plain continue failure'
		);
	});
});

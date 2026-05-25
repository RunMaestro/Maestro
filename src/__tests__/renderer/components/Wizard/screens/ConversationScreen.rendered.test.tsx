/**
 * ConversationScreen.rendered.test.tsx
 *
 * Rendered coverage for the wizard conversation screen.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationScreen } from '../../../../../renderer/components/Wizard/screens/ConversationScreen';
import {
	WizardProvider,
	useWizard,
	type WizardMessage,
	type WizardState,
} from '../../../../../renderer/components/Wizard/WizardContext';
import type { Theme } from '../../../../../renderer/types';

const mocks = vi.hoisted(() => ({
	startConversation: vi.fn(),
	endConversation: vi.fn(),
	isConversationActive: vi.fn(),
	sendMessage: vi.fn(),
	downloadLogs: vi.fn(),
	getNextFillerPhrase: vi.fn(),
	setShowThinking: vi.fn(),
	listDocs: vi.fn(),
	readDoc: vi.fn(),
	scrollIntoView: vi.fn(),
}));

vi.mock('../../../../../renderer/components/Wizard/services/conversationManager', () => ({
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

vi.mock('../../../../../renderer/components/Wizard/services/wizardPrompts', () => ({
	getConfidenceColor: (confidence: number) =>
		confidence >= 80 ? '#22c55e' : confidence >= 50 ? '#f59e0b' : '#ef4444',
	getInitialQuestion: () => 'What are we building today?',
	READY_CONFIDENCE_THRESHOLD: 80,
}));

vi.mock('../../../../../renderer/components/Wizard/services/phaseGenerator', () => ({
	AUTO_RUN_FOLDER_NAME: 'Auto Run Docs',
	wizardDebugLogger: {
		downloadLogs: (...args: unknown[]) => mocks.downloadLogs(...args),
	},
}));

vi.mock('../../../../../renderer/components/Wizard/services/fillerPhrases', () => ({
	getNextFillerPhrase: () => mocks.getNextFillerPhrase(),
}));

const mockTheme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#252525',
		bgActivity: '#2a2a2a',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		textFaint: '#555555',
		accent: '#4a9eff',
		accentForeground: '#ffffff',
		buttonBg: '#333333',
		buttonHover: '#444444',
		headerBg: '#202020',
		scrollbarTrack: '#1a1a1a',
		scrollbarThumb: '#444444',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
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
					theme={mockTheme}
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

describe('ConversationScreen rendered behavior', () => {
	beforeEach(() => {
		mocks.startConversation.mockReset();
		mocks.endConversation.mockReset();
		mocks.isConversationActive.mockReset();
		mocks.sendMessage.mockReset();
		mocks.downloadLogs.mockReset();
		mocks.getNextFillerPhrase.mockReset();
		mocks.setShowThinking.mockReset();
		mocks.listDocs.mockReset();
		mocks.readDoc.mockReset();
		mocks.scrollIntoView.mockReset();

		mocks.startConversation.mockResolvedValue('wizard-session');
		mocks.endConversation.mockResolvedValue(undefined);
		mocks.isConversationActive.mockReturnValue(true);
		mocks.sendMessage.mockResolvedValue({ success: true });
		mocks.getNextFillerPhrase.mockReturnValue('Reviewing the project details...');
		mocks.listDocs.mockResolvedValue({ success: false });
		mocks.readDoc.mockResolvedValue({ success: false });

		Element.prototype.scrollIntoView = mocks.scrollIntoView;
		(window as any).maestro = {
			settings: {
				get: vi.fn(),
				set: vi.fn(),
			},
			autorun: {
				listDocs: mocks.listDocs,
				readDoc: mocks.readDoc,
			},
		};
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		(window as any).maestro = undefined;
	});

	it('renders resumed conversation history with provider, confidence, ready, and navigation states', async () => {
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

	it('renders provider labels and default agent names for alternate providers', async () => {
		const first = renderConversation({
			selectedAgent: 'claude-code',
			agentName: '',
			conversationHistory: [existingHistory[0]],
		});
		expect(await screen.findByText('Claude')).toBeInTheDocument();
		expect(screen.getAllByText('🤖 Agent')).not.toHaveLength(0);
		first.unmount();
		cleanup();

		const second = renderConversation({
			selectedAgent: 'opencode',
			conversationHistory: [existingHistory[0]],
		});
		expect(await screen.findByText('OpenCode')).toBeInTheDocument();
		second.unmount();
		cleanup();

		renderConversation({
			selectedAgent: 'custom-agent',
			conversationHistory: [existingHistory[0]],
		});
		expect(await screen.findByText('custom-agent')).toBeInTheDocument();
	});

	it('starts a new conversation with existing documents and auto-sends the continuation prompt', async () => {
		mocks.listDocs.mockResolvedValue({ success: true, files: ['Phase-01.md', 'Phase-02.md'] });
		mocks.readDoc
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
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

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
			expect.any(Error)
		);
		await screen.findByText('Continue with more details.');
		expect(screen.getByTestId('confidence-level')).toHaveTextContent('60');
	});

	it('starts continue mode without existing docs when listing is empty or unavailable', async () => {
		mocks.listDocs.mockResolvedValueOnce({ success: true, files: [] });

		const firstRender = renderConversation({ existingDocsChoice: 'continue' });

		await waitFor(() => {
			expect(mocks.startConversation).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: 'codex',
					existingDocs: undefined,
				})
			);
		});

		firstRender.unmount();
		cleanup();
		mocks.startConversation.mockClear();
		mocks.listDocs.mockReset();
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const listError = new Error('docs folder unavailable');
		mocks.listDocs.mockRejectedValueOnce(listError);

		renderConversation({ existingDocsChoice: 'continue' });

		await waitFor(() => {
			expect(mocks.startConversation).toHaveBeenCalledWith(
				expect.objectContaining({
					agentType: 'codex',
					existingDocs: undefined,
				})
			);
		});
		expect(warnSpy).toHaveBeenCalledWith('Failed to fetch existing docs:', listError);
	});

	it('initializes with project-name fallback and ignores empty document reads', async () => {
		mocks.listDocs.mockResolvedValue({ success: true, files: ['Empty.md', 'Missing.md'] });
		mocks.readDoc
			.mockResolvedValueOnce({ success: true, content: '' })
			.mockResolvedValueOnce({ success: false });

		renderConversation({
			agentName: '',
			existingDocsChoice: 'continue',
		});

		await waitFor(() => {
			expect(mocks.startConversation).toHaveBeenCalledWith(
				expect.objectContaining({
					projectName: 'My Project',
					existingDocs: undefined,
				})
			);
		});
	});

	it('does not set initialization state after unmounting before start resolves or rejects', async () => {
		let resolveStart: () => void = () => {};
		mocks.startConversation.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				resolveStart = resolve;
			})
		);

		const first = renderConversation();
		first.unmount();
		await act(async () => {
			resolveStart();
		});

		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		let rejectStart: (error: Error) => void = () => {};
		mocks.startConversation.mockReturnValueOnce(
			new Promise<void>((_resolve, reject) => {
				rejectStart = reject;
			})
		);

		const second = renderConversation();
		second.unmount();
		await act(async () => {
			rejectStart(new Error('late initialization failure'));
		});

		expect(errorSpy).toHaveBeenCalledWith('Failed to initialize conversation:', expect.any(Error));
	});

	it('does not auto-send the continuation prompt while conversation state is already loading', async () => {
		renderConversation({
			existingDocsChoice: 'continue',
			isConversationLoading: true,
		});

		await waitFor(() => {
			expect(mocks.startConversation).toHaveBeenCalledTimes(1);
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 150));
		});

		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});

	it('stops continue-mode auto-send when the selected agent is cleared before retrying an inactive conversation', async () => {
		vi.useFakeTimers();
		mocks.isConversationActive.mockReturnValue(false);
		let capturedWizard: ReturnType<typeof useWizard> | undefined;

		function CaptureWizardState() {
			capturedWizard = useWizard();
			return null;
		}

		render(
			<WizardProvider>
				<CaptureWizardState />
				<ConversationHarness initialState={{ existingDocsChoice: 'continue' }} />
			</WizardProvider>
		);

		await act(async () => {
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(mocks.startConversation).toHaveBeenCalledTimes(1);

		act(() => {
			capturedWizard!.restoreState({
				...capturedWizard!.state,
				selectedAgent: null,
			});
		});

		act(() => {
			vi.advanceTimersByTime(100);
		});

		expect(
			screen.getAllByText('No agent selected. Please go back and select an agent.')
		).not.toHaveLength(0);
		expect(mocks.sendMessage).not.toHaveBeenCalled();
		expect(screen.getByTestId('conversation-error')).toHaveTextContent(
			'No agent selected. Please go back and select an agent.'
		);
	});

	it('reinitializes inactive continue-mode sends and handles unstructured callback success', async () => {
		mocks.isConversationActive.mockReturnValue(false);
		mocks.listDocs.mockResolvedValue({ success: true, files: ['Phase-01.md', 'Missing.md'] });
		mocks.readDoc
			.mockResolvedValueOnce({ success: true, content: '# Phase 1' })
			.mockRejectedValueOnce(new Error('missing continue doc'))
			.mockResolvedValueOnce({ success: true, content: '# Phase 1' })
			.mockRejectedValueOnce(new Error('missing continue doc'));
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onChunk?.(
				'not json\n{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Streaming synopsis"}}}'
			);
			callbacks.onThinkingChunk?.('visible reasoning');
			callbacks.onThinkingChunk?.('{"message":"structured response"}');
			callbacks.onToolExecution?.({
				toolName: 'Read',
				state: { status: 'running', input: { file_path: '/repo/Auto Run Docs/Phase-01.md' } },
				timestamp: 2,
			});
			callbacks.onComplete?.({
				success: true,
				response: {
					parseSuccess: false,
					rawText: 'Unstructured synopsis.',
				},
			});
			return { success: true };
		});

		renderConversation({ existingDocsChoice: 'continue' }, true);

		expect(await screen.findByText('Unstructured synopsis.')).toBeInTheDocument();
		expect(mocks.startConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				agentType: 'codex',
				directoryPath: '/repo',
				projectName: 'Launch Project',
				existingDocs: [{ filename: 'Phase-01.md', content: '# Phase 1' }],
			})
		);
		expect(warnSpy).toHaveBeenCalledWith('Failed to read doc Missing.md:', expect.any(Error));
	});

	it('reinitializes inactive continue mode with fallback project names and ready structured results', async () => {
		mocks.isConversationActive.mockReturnValue(false);
		mocks.listDocs.mockResolvedValue({ success: true, files: ['Empty.md'] });
		mocks.readDoc.mockResolvedValue({ success: false });
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onComplete?.({
				success: true,
				response: {
					parseSuccess: true,
					rawText: 'Ready synopsis.',
					structured: {
						confidence: 90,
						ready: true,
						message: 'Ready synopsis.',
					},
				},
			});
			return { success: true };
		});

		renderConversation({
			agentName: '',
			existingDocsChoice: 'continue',
		});

		expect(await screen.findByText('Ready synopsis.')).toBeInTheDocument();
		expect(mocks.startConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				projectName: 'My Project',
				existingDocs: undefined,
			})
		);
		expect(screen.getByTestId('confidence-level')).toHaveTextContent('90');
	});

	it('surfaces inactive continue-mode result failures without detected errors', async () => {
		mocks.isConversationActive.mockReturnValue(false);
		mocks.listDocs.mockResolvedValue({ success: false });
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onThinkingChunk?.('hidden continue reasoning');
			callbacks.onToolExecution?.({
				toolName: 'Read',
				state: { status: 'running', input: { file_path: '/repo/hidden.md' } },
				timestamp: 1,
			});
			return {
				success: false,
				error: 'Continue result failed',
			};
		});

		renderConversation({ existingDocsChoice: 'continue' });

		expect(await screen.findAllByText('Continue result failed')).not.toHaveLength(0);
		expect(screen.queryByText('hidden continue reasoning')).not.toBeInTheDocument();
		expect(screen.queryByText('/repo/hidden.md')).not.toBeInTheDocument();
	});

	it('handles continue-mode completion callbacks without a response payload', async () => {
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onComplete?.({ success: false });
			return { success: true };
		});

		renderConversation({ existingDocsChoice: 'continue' });

		await waitFor(() => {
			expect(mocks.sendMessage).toHaveBeenCalled();
		});
		expect(screen.queryByText('Analysis complete.')).not.toBeInTheDocument();
	});

	it('surfaces continue-mode callback and result failures with detected recovery details', async () => {
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onError?.('Provider rejected the continuation request');
			return {
				success: false,
				error: 'Session lost',
				detectedError: {
					title: 'Session Lost',
					message: 'The provider session ended.',
					recoveryHint: 'Start a new provider session.',
					canRetry: true,
				},
			};
		});
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		renderConversation({ existingDocsChoice: 'continue' });

		expect(await screen.findByText('Session Lost')).toBeInTheDocument();
		expect(screen.getByText('The provider session ended.')).toBeInTheDocument();
		expect(screen.getByText('Start a new provider session.')).toBeInTheDocument();
		expect(errorSpy).toHaveBeenCalledWith(
			'Conversation error:',
			'Provider rejected the continuation request'
		);
	});

	it('shows thrown continue-mode send errors as conversation errors', async () => {
		mocks.sendMessage.mockRejectedValueOnce(new Error('Continuation failed'));

		renderConversation({ existingDocsChoice: 'continue' });

		expect(await screen.findAllByText('Continuation failed')).not.toHaveLength(0);
	});

	it('shows fallback messages for non-Error continue-mode send failures', async () => {
		mocks.sendMessage.mockRejectedValueOnce('plain continuation failure');

		renderConversation({ existingDocsChoice: 'continue' });

		expect(await screen.findAllByText('Unknown error occurred')).not.toHaveLength(0);
	});

	it('sends a user message, records structured ready responses, and auto-continues deferred replies', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
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

		await screen.findByText('Let me research this.');
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
		await screen.findByText('Analysis complete.');
	});

	it('does not initialize a new conversation without an agent selection', async () => {
		renderConversation({ selectedAgent: null });

		expect(await screen.findByText('What are we building today?')).toBeInTheDocument();
		await waitFor(() => {
			expect(mocks.startConversation).not.toHaveBeenCalled();
		});
	});

	it('announces structured user-send responses that are not ready yet', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onComplete?.({
				success: true,
				response: {
					parseSuccess: true,
					rawText: 'Tell me more about the target users.',
					structured: {
						confidence: 70,
						ready: false,
						message: 'Tell me more about the target users.',
					},
				},
			});
			return { success: true };
		});

		renderConversation({ conversationHistory: existingHistory });

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Add more details' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findByText('Tell me more about the target users.')).toBeInTheDocument();
		expect(screen.getByTestId('confidence-level')).toHaveTextContent('70');
		expect(logSpy).toHaveBeenCalledWith('[ConversationScreen] Setting confidence to:', 70);
	});

	it('ignores blank sends and resizes the textarea to its scroll height cap', async () => {
		renderConversation({ conversationHistory: existingHistory });

		const textarea = screen.getByPlaceholderText('Describe your project...') as HTMLTextAreaElement;
		Object.defineProperty(textarea, 'scrollHeight', {
			configurable: true,
			value: 200,
		});

		fireEvent.input(textarea);
		expect(textarea.style.height).toBe('120px');

		fireEvent.change(textarea, { target: { value: '   ' } });
		fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});

	it('uses Ctrl+Enter to send while plain Enter keeps editing', async () => {
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onComplete?.({
				success: true,
				response: {
					parseSuccess: false,
					rawText: 'Sent with control.',
				},
			});
			return { success: true };
		});

		renderConversation({ conversationHistory: existingHistory });

		const textarea = screen.getByPlaceholderText('Describe your project...');
		fireEvent.change(textarea, { target: { value: 'Plain enter should not send' } });
		fireEvent.keyDown(textarea, { key: 'Enter' });
		expect(mocks.sendMessage).not.toHaveBeenCalled();

		fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });
		expect(await screen.findByText('Sent with control.')).toBeInTheDocument();
	});

	it('shows a no-agent error when sending after the selected provider is missing', async () => {
		mocks.isConversationActive.mockReturnValue(false);

		renderConversation({
			selectedAgent: null,
			conversationHistory: existingHistory,
		});

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Send without provider' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(
			await screen.findAllByText('No agent selected. Please go back and select an agent.')
		).not.toHaveLength(0);
		expect(mocks.sendMessage).not.toHaveBeenCalled();
	});

	it('reinitializes user sends with the fallback project name', async () => {
		mocks.isConversationActive.mockReturnValue(false);
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onComplete?.({
				success: true,
				response: {
					parseSuccess: false,
					rawText: 'Reinitialized response.',
				},
			});
			return { success: true };
		});

		renderConversation({
			agentName: '',
			conversationHistory: existingHistory,
		});

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Reinitialize before send' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findByText('Reinitialized response.')).toBeInTheDocument();
		expect(mocks.startConversation).toHaveBeenCalledWith(
			expect.objectContaining({
				projectName: 'My Project',
			})
		);
	});

	it('records unstructured user-send responses and announces the generic completion path', async () => {
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onComplete?.({
				success: true,
				response: {
					parseSuccess: false,
					rawText: 'Plain assistant response.',
				},
			});
			return { success: true };
		});

		renderConversation({ conversationHistory: existingHistory });

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Respond plainly' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findByText('Plain assistant response.')).toBeInTheDocument();
		expect(logSpy).toHaveBeenCalledWith('[ConversationScreen] No structured data in response');
	});

	it('handles user-send completion and result failures without detected errors', async () => {
		mocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
			callbacks.onComplete?.({ success: false });
			return {
				success: false,
				error: 'Plain result failure',
			};
		});

		renderConversation({ conversationHistory: existingHistory });

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Return a plain failure' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findAllByText('Plain result failure')).not.toHaveLength(0);
	});

	it('shows thrown Error messages from user sends', async () => {
		mocks.sendMessage.mockRejectedValueOnce(new Error('Provider exploded'));

		renderConversation({ conversationHistory: existingHistory });

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Throw as Error' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findAllByText('Provider exploded')).not.toHaveLength(0);
	});

	it('shows callback errors, detected error recovery details, debug logs, retry labels, and back navigation', async () => {
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

		renderConversation({ conversationHistory: existingHistory });

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Try again' },
		});
		fireEvent.keyDown(screen.getByPlaceholderText('Describe your project...'), {
			key: 'Enter',
			metaKey: true,
		});

		await screen.findByText('Authentication Required');
		expect(screen.getByText('Please sign in again.')).toBeInTheDocument();
		expect(screen.getByText('Run the provider login command.')).toBeInTheDocument();

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

	it('shows live thinking content and running tool details while a send is pending', async () => {
		mocks.sendMessage.mockImplementation((_message, _history, callbacks) => {
			callbacks.onThinkingChunk?.('Tracing the repository');
			callbacks.onThinkingChunk?.('{"confidence":80,"message":"structured response"}');
			callbacks.onToolExecution?.({
				toolName: 'Read',
				state: { status: 'running', input: { file_path: '/repo/README.md' } },
				timestamp: 1,
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
		expect(screen.getByText('/repo/README.md')).toBeInTheDocument();
	});

	it('renders complete and default-running tool executions without thinking text', async () => {
		mocks.sendMessage.mockImplementation((_message, _history, callbacks) => {
			callbacks.onThinkingChunk?.('{"message":"structured response"}');
			callbacks.onToolExecution?.({
				toolName: 'Write',
				state: { status: 'complete' },
				timestamp: 1,
			});
			callbacks.onToolExecution?.({
				toolName: 'Shell',
				state: { input: { command: 'npm test' } },
				timestamp: 2,
			});
			return new Promise(() => {});
		});

		renderConversation({ agentName: '', conversationHistory: existingHistory }, true);

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Run the tools' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findByText('Write')).toBeInTheDocument();
		expect(screen.getByText('✓')).toBeInTheDocument();
		expect(screen.getByText('Shell')).toBeInTheDocument();
		expect(screen.getByText('npm test')).toBeInTheDocument();
		expect(screen.getAllByText('🤖 Agent')).not.toHaveLength(0);
		expect(screen.getByTestId('thinking-display-content')).not.toHaveTextContent('Reasoning...');
	});

	it('ignores thinking and tool callbacks while thinking display is hidden', async () => {
		mocks.sendMessage.mockImplementation((_message, _history, callbacks) => {
			callbacks.onThinkingChunk?.('hidden reasoning');
			callbacks.onToolExecution?.({
				toolName: 'Read',
				state: { status: 'running', input: { file_path: '/repo/hidden.md' } },
				timestamp: 1,
			});
			return new Promise(() => {});
		});

		renderConversation({ conversationHistory: existingHistory }, false);

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Do hidden work' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findByTestId('wizard-typing-indicator')).toBeInTheDocument();
		expect(screen.queryByText('hidden reasoning')).not.toBeInTheDocument();
		expect(screen.queryByText('/repo/hidden.md')).not.toBeInTheDocument();
	});

	it('renders streaming chunks with the default agent name while a send is pending', async () => {
		mocks.sendMessage.mockImplementation((_message, _history, callbacks) => {
			callbacks.onChunk?.(
				'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Streaming now"}}}'
			);
			return new Promise(() => {});
		});

		renderConversation({
			agentName: '',
			conversationHistory: existingHistory,
		});

		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Stream response' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findByText('Streaming now')).toBeInTheDocument();
		expect(screen.getAllByText('🤖 Agent')).not.toHaveLength(0);
	});

	it('shows fallback loading states and toggles the thinking preference', async () => {
		const { rerender } = render(
			<WizardProvider>
				<ConversationHarness
					initialState={{ isConversationLoading: true, conversationHistory: existingHistory }}
				/>
			</WizardProvider>
		);

		expect(await screen.findByTestId('wizard-typing-indicator')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /thinking/i }));
		expect(mocks.setShowThinking).toHaveBeenCalledWith(true);

		rerender(
			<WizardProvider>
				<ConversationHarness
					initialState={{ isConversationLoading: true, conversationHistory: existingHistory }}
					showThinking
				/>
			</WizardProvider>
		);

		expect(await screen.findByTestId('wizard-thinking-display')).toBeInTheDocument();
		fireEvent.keyDown(
			screen.getByText('Plan').closest('.flex') ?? screen.getByTestId('current-step'),
			{
				key: 'Escape',
			}
		);
		await waitFor(() => {
			expect(screen.getByTestId('current-step')).toHaveTextContent('directory-selection');
		});
	});

	it('uses the default agent label in the minimal thinking state', async () => {
		renderConversation(
			{
				agentName: '',
				isConversationLoading: true,
				conversationHistory: existingHistory,
			},
			true
		);

		expect(await screen.findByTestId('wizard-thinking-display')).toBeInTheDocument();
		expect(screen.getAllByText('🤖 Agent')).not.toHaveLength(0);
		expect(screen.getByText('Reasoning...')).toBeInTheDocument();
	});

	it('requests a new filler phrase after the loading phrase finishes typing', () => {
		vi.useFakeTimers();
		const originalRaf = globalThis.requestAnimationFrame;
		const originalCaf = globalThis.cancelAnimationFrame;
		let rafCallbacks: FrameRequestCallback[] = [];
		globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
			rafCallbacks.push(callback);
			return rafCallbacks.length;
		}) as typeof requestAnimationFrame;
		globalThis.cancelAnimationFrame = vi.fn();

		function flushRaf(timestamp: number) {
			const callbacks = [...rafCallbacks];
			rafCallbacks = [];
			for (const callback of callbacks) {
				callback(timestamp);
			}
		}

		try {
			renderConversation({
				isConversationLoading: true,
				conversationHistory: existingHistory,
			});

			expect(screen.getByTestId('wizard-typing-indicator')).toBeInTheDocument();
			expect(mocks.getNextFillerPhrase).not.toHaveBeenCalled();

			for (const timestamp of [100, 130, 160, 190, 220, 250, 280, 310, 340, 370, 400, 430, 460]) {
				act(() => flushRaf(timestamp));
			}
			act(() => vi.advanceTimersByTime(5000));

			expect(mocks.getNextFillerPhrase).toHaveBeenCalledTimes(1);
		} finally {
			globalThis.requestAnimationFrame = originalRaf;
			globalThis.cancelAnimationFrame = originalCaf;
		}
	});

	it('handles initialization and send exceptions with fallback error messages', async () => {
		mocks.startConversation.mockRejectedValueOnce(new Error('spawn failed'));
		const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		renderConversation();

		expect(
			await screen.findAllByText('Failed to initialize conversation. Please try again.')
		).toHaveLength(2);
		expect(errorSpy).toHaveBeenCalledWith('Failed to initialize conversation:', expect.any(Error));

		cleanup();
		mocks.startConversation.mockResolvedValue('wizard-session');
		mocks.sendMessage.mockRejectedValue('bad failure');

		renderConversation({ conversationHistory: existingHistory });
		fireEvent.change(screen.getByPlaceholderText('Describe your project...'), {
			target: { value: 'Send failure' },
		});
		fireEvent.click(screen.getByRole('button', { name: /send/i }));

		expect(await screen.findAllByText('Unknown error occurred')).toHaveLength(2);
	});
});

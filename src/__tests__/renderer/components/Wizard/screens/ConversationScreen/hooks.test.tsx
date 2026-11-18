import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { mockTheme } from '../../../../../helpers/mockTheme';
import { StreamingResponseBubble } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/components/StreamingResponseBubble';
import type {
	ConversationCallbacks,
	SendMessageResult,
} from '../../../../../../renderer/components/Wizard/services/conversationManager';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConversationAnnouncements } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/hooks/useConversationAnnouncements';
import { useConversationAutoContinue } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/hooks/useConversationAutoContinue';
import { useConversationBootstrap } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/hooks/useConversationBootstrap';
import { useWizardConversationSend } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/hooks/useWizardConversationSend';
import { AUTO_CONTINUE_MESSAGE } from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/utils/deferredResponse';
import type {
	ConversationRefs,
	SendStateSetters,
	WizardConversationState,
} from '../../../../../../renderer/components/Wizard/screens/ConversationScreen/types';

const conversationMocks = vi.hoisted(() => ({
	startConversation: vi.fn(),
	sendMessage: vi.fn(),
	endConversation: vi.fn(),
	isConversationActive: vi.fn(),
}));

const sentryMocks = vi.hoisted(() => ({
	captureException: vi.fn(),
}));

vi.mock(
	'../../../../../../renderer/components/Wizard/services/conversationManager',
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import('../../../../../../renderer/components/Wizard/services/conversationManager')
			>();

		return {
			...actual,
			conversationManager: conversationMocks,
		};
	}
);

vi.mock('../../../../../../renderer/utils/sentry', () => sentryMocks);

function createState(overrides: Partial<WizardConversationState> = {}): WizardConversationState {
	return {
		selectedAgent: 'claude-code',
		directoryPath: '/project',
		agentName: 'Project',
		conversationHistory: [],
		isConversationLoading: false,
		existingDocsChoice: null,
		sessionSshRemoteConfig: undefined,
		...overrides,
	};
}

function createRefs(): ConversationRefs {
	const input = document.createElement('textarea');
	vi.spyOn(input, 'focus');

	return {
		inputRef: { current: input },
		isSendingRef: { current: false },
		initialQuestionAddedRef: { current: false },
		autoContinueTriggeredRef: { current: false },
		showThinkingRef: { current: true },
	};
}

function createSetters(): SendStateSetters {
	return {
		setInputValue: vi.fn(),
		setShowInitialQuestion: vi.fn(),
		setStreamingText: vi.fn(),
		setFillerPhrase: vi.fn(),
		setDetectedError: vi.fn(),
		setThinkingContent: vi.fn(),
		setToolExecutions: vi.fn(),
		setErrorRetryCount: vi.fn(),
	};
}

function renderSendHook({
	state = createState(),
	inputValue = 'Build a dashboard',
	showInitialQuestion = true,
	refs = createRefs(),
	setters = createSetters(),
	addMessage = vi.fn(),
	setConfidenceLevel = vi.fn(),
	setIsReadyToProceed = vi.fn(),
	setConversationLoading = vi.fn(),
	setConversationError = vi.fn(),
	announce = vi.fn(),
	scheduleAutoContinue = vi.fn(),
}: Partial<{
	state: WizardConversationState;
	inputValue: string;
	showInitialQuestion: boolean;
	refs: ConversationRefs;
	setters: SendStateSetters;
	addMessage: ReturnType<typeof vi.fn>;
	setConfidenceLevel: ReturnType<typeof vi.fn>;
	setIsReadyToProceed: ReturnType<typeof vi.fn>;
	setConversationLoading: ReturnType<typeof vi.fn>;
	setConversationError: ReturnType<typeof vi.fn>;
	announce: ReturnType<typeof vi.fn>;
	scheduleAutoContinue: ReturnType<typeof vi.fn>;
}> = {}) {
	const rendered = renderHook(
		(currentState: WizardConversationState) =>
			useWizardConversationSend({
				state: currentState,
				inputValue,
				showInitialQuestion,
				initialQuestion: 'Initial question?',
				refs,
				setters,
				addMessage,
				setConfidenceLevel,
				setIsReadyToProceed,
				setConversationLoading,
				setConversationError,
				announce,
				scheduleAutoContinue,
			}),
		{ initialProps: state }
	);

	return {
		...rendered,
		state,
		refs,
		setters,
		addMessage,
		setConfidenceLevel,
		setIsReadyToProceed,
		setConversationLoading,
		setConversationError,
		announce,
		scheduleAutoContinue,
	};
}

describe('ConversationScreen hooks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		conversationMocks.startConversation.mockResolvedValue('wizard-session');
		conversationMocks.isConversationActive.mockReturnValue(true);
		conversationMocks.sendMessage.mockResolvedValue({ success: true });
		vi.mocked(window.maestro.autorun.listDocs)
			.mockReset()
			.mockResolvedValue({ success: true, files: [] });
		vi.mocked(window.maestro.autorun.readDoc)
			.mockReset()
			.mockResolvedValue({ success: true, content: 'Current plan' });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('useConversationAnnouncements', () => {
		it('announces explicit messages and ready transitions', () => {
			const { result, rerender } = renderHook(
				({ ready, confidence }) =>
					useConversationAnnouncements({
						isReadyToProceed: ready,
						confidenceLevel: confidence,
					}),
				{ initialProps: { ready: false, confidence: 40 } }
			);

			act(() => result.current.announce('Message sent'));
			expect(result.current.announcement).toBe('Message sent');
			expect(result.current.announcementKey).toBe(1);

			rerender({ ready: true, confidence: 85 });
			expect(result.current.announcement).toBe(
				'Confidence level 85%. Ready to proceed! You can now create your Playbook.'
			);
			expect(result.current.announcementKey).toBe(2);

			rerender({ ready: true, confidence: 90 });
			expect(result.current.announcementKey).toBe(2);
		});
	});

	describe('useConversationAutoContinue', () => {
		it('delays setting the auto-continue input and then sends it', () => {
			vi.useFakeTimers();
			const setInputValue = vi.fn();
			const handleSend = vi.fn();
			const isSendingRef = { current: false };
			const handleSendMessageRef = { current: handleSend };

			const { result, rerender } = renderHook(
				({ inputValue }) =>
					useConversationAutoContinue({
						inputValue,
						isConversationLoading: false,
						isSendingRef,
						setInputValue,
						handleSendMessageRef,
					}),
				{ initialProps: { inputValue: '' } }
			);

			act(() => result.current(AUTO_CONTINUE_MESSAGE));
			rerender({ inputValue: '' });
			act(() => vi.advanceTimersByTime(799));
			expect(setInputValue).not.toHaveBeenCalled();

			act(() => vi.advanceTimersByTime(1));
			expect(setInputValue).toHaveBeenCalledWith(AUTO_CONTINUE_MESSAGE);

			rerender({ inputValue: AUTO_CONTINUE_MESSAGE });
			expect(handleSend).toHaveBeenCalledTimes(1);
		});

		it('does not send while already sending', () => {
			const handleSend = vi.fn();
			renderHook(() =>
				useConversationAutoContinue({
					inputValue: AUTO_CONTINUE_MESSAGE,
					isConversationLoading: false,
					isSendingRef: { current: true },
					setInputValue: vi.fn(),
					handleSendMessageRef: { current: handleSend },
				})
			);

			expect(handleSend).not.toHaveBeenCalled();
		});

		it('does not schedule input while conversation is loading', () => {
			vi.useFakeTimers();
			const setInputValue = vi.fn();
			const { result } = renderHook(() =>
				useConversationAutoContinue({
					inputValue: '',
					isConversationLoading: true,
					isSendingRef: { current: false },
					setInputValue,
					handleSendMessageRef: { current: vi.fn() },
				})
			);

			act(() => result.current(AUTO_CONTINUE_MESSAGE));
			act(() => vi.advanceTimersByTime(800));

			expect(setInputValue).not.toHaveBeenCalled();
		});
	});

	describe('useConversationBootstrap', () => {
		it('starts a fresh conversation and cleans it up on unmount', async () => {
			const setConversationStarted = vi.fn();
			const { unmount } = renderHook(() =>
				useConversationBootstrap({
					state: createState(),
					conversationStarted: false,
					setConversationStarted,
					setShowInitialQuestion: vi.fn(),
					initialQuestionAddedRef: { current: false },
					setConversationError: vi.fn(),
				})
			);

			await waitFor(() => expect(conversationMocks.startConversation).toHaveBeenCalled());
			expect(conversationMocks.startConversation).toHaveBeenCalledWith({
				agentType: 'claude-code',
				directoryPath: '/project',
				// The project is the FOLDER, not the agent's name (issue #1225).
				projectName: 'project',
				model: undefined,
				sessionCustomPath: undefined,
				sessionCustomArgs: undefined,
				sessionCustomEnvVars: undefined,
				existingDocs: undefined,
				sshRemoteConfig: undefined,
				claudeTokenSource: {
					enableMaestroP: undefined,
					maestroPMode: undefined,
					maestroPPath: undefined,
				},
			});
			expect(setConversationStarted).toHaveBeenCalledWith(true);

			unmount();
			expect(conversationMocks.endConversation).toHaveBeenCalledTimes(1);
		});

		it.each([
			[undefined, undefined],
			[{}, undefined],
			[{ GROK_HOME: '/accounts/a', GROK_AUTH_PATH: '/accounts/a/auth' }, undefined],
			[{ GROK_HOME: '/accounts/b', GROK_AUTH_PATH: '/accounts/b/auth' }, 'remote-b'],
		] as const)(
			'hands Grok env %j and host %s through bootstrap and send paths',
			async (env, remoteId) => {
				const state = createState({
					selectedAgent: 'grok',
					customPath: '/custom/grok',
					customArgs: '--reasoning-effort high',
					customEnvVars: env,
					plannerModel: 'grok-4.3',
					sessionSshRemoteConfig: remoteId ? { enabled: true, remoteId } : undefined,
				});
				const started = vi.fn();
				renderHook(() =>
					useConversationBootstrap({
						state,
						conversationStarted: false,
						setConversationStarted: started,
						setShowInitialQuestion: vi.fn(),
						initialQuestionAddedRef: { current: false },
						setConversationError: vi.fn(),
					})
				);
				await waitFor(() => expect(started).toHaveBeenCalledWith(true));
				expect(conversationMocks.startConversation).toHaveBeenCalledExactlyOnceWith({
					agentType: 'grok',
					directoryPath: '/project',
					projectName: 'project',
					model: 'grok-4.3',
					sessionCustomPath: state.customPath,
					sessionCustomArgs: state.customArgs,
					sessionCustomEnvVars: env,
					sshRemoteConfig: state.sessionSshRemoteConfig,
					existingDocs: undefined,
					claudeTokenSource: {
						enableMaestroP: undefined,
						maestroPMode: undefined,
						maestroPPath: undefined,
					},
				});
				const expectedConfig = conversationMocks.startConversation.mock.calls[0][0];
				const history = [
					{ id: 'old', role: 'assistant' as const, content: 'Prior plan', timestamp: 1 },
				];
				const hook = renderSendHook({
					state: { ...state, conversationHistory: history },
					showInitialQuestion: false,
				});
				for (const mode of ['message', 'survey', 'existing-docs'] as const) {
					conversationMocks.isConversationActive.mockReturnValue(mode === 'message');
					vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
						success: true,
						files: ['plan.md'],
					});
					hook.rerender({
						...state,
						conversationHistory: history,
						plannerModel: mode === 'message' ? undefined : 'grok-4.5',
					});
					await act(async () => {
						if (mode === 'message') await hook.result.current.handleSendMessage();
						else await hook.result.current.sendOpeningMessage(mode);
					});
					expect(conversationMocks.startConversation).toHaveBeenLastCalledWith({
						...expectedConfig,
						model: mode === 'message' ? undefined : 'grok-4.5',
						existingDocs:
							mode === 'existing-docs'
								? [{ filename: 'plan.md', content: 'Current plan' }]
								: undefined,
					});
					expect(conversationMocks.sendMessage).toHaveBeenLastCalledWith(
						expect.any(String),
						history,
						expect.any(Object)
					);
				}
				expect(conversationMocks.startConversation).toHaveBeenCalledTimes(4);
			}
		);

		it.each(['selection', 'unmount'] as const)(
			'discards bootstrap documents after %s',
			async (change) => {
				let resolveDocs!: (value: { success: boolean; files: string[] }) => void;
				vi.mocked(window.maestro.autorun.listDocs).mockReturnValueOnce(
					new Promise((resolve) => {
						resolveDocs = resolve;
					})
				);
				const state = createState({
					selectedAgent: 'grok',
					existingDocsChoice: 'continue',
					customEnvVars: { GROK_HOME: '/accounts/a' },
				});
				const controls = {
					conversationStarted: false,
					setConversationStarted: vi.fn(),
					setShowInitialQuestion: vi.fn(),
					initialQuestionAddedRef: { current: false },
					setConversationError: vi.fn(),
				};
				const hook = renderHook((state) => useConversationBootstrap({ state, ...controls }), {
					initialProps: state,
				});
				if (change === 'unmount') hook.unmount();
				else {
					hook.rerender({
						...state,
						directoryPath: '/new-project',
						customEnvVars: { GROK_HOME: '/accounts/b' },
					});
					await waitFor(() => expect(controls.setConversationStarted).toHaveBeenCalledWith(true));
				}
				await act(async () => resolveDocs({ success: true, files: ['old.md'] }));
				expect(conversationMocks.startConversation).toHaveBeenCalledTimes(
					change === 'unmount' ? 0 : 1
				);
				if (change === 'selection')
					expect(conversationMocks.startConversation).toHaveBeenLastCalledWith(
						expect.objectContaining({
							directoryPath: '/new-project',
							sessionCustomEnvVars: { GROK_HOME: '/accounts/b' },
							existingDocs: undefined,
						})
					);
			}
		);

		it('resumes existing history without restarting the manager', () => {
			const initialQuestionAddedRef = { current: false };
			const setConversationStarted = vi.fn();
			const setShowInitialQuestion = vi.fn();

			renderHook(() =>
				useConversationBootstrap({
					state: createState({
						conversationHistory: [{ id: 'm1', role: 'assistant', content: 'Hi', timestamp: 1 }],
					}),
					conversationStarted: false,
					setConversationStarted,
					setShowInitialQuestion,
					initialQuestionAddedRef,
					setConversationError: vi.fn(),
				})
			);

			expect(conversationMocks.startConversation).not.toHaveBeenCalled();
			expect(setConversationStarted).toHaveBeenCalledWith(true);
			expect(setShowInitialQuestion).toHaveBeenCalledWith(false);
			expect(initialQuestionAddedRef.current).toBe(true);
		});

		it('surfaces initialization failures', async () => {
			const error = new Error('spawn failed');
			conversationMocks.startConversation.mockRejectedValueOnce(error);
			const setConversationError = vi.fn();

			renderHook(() =>
				useConversationBootstrap({
					state: createState(),
					conversationStarted: false,
					setConversationStarted: vi.fn(),
					setShowInitialQuestion: vi.fn(),
					initialQuestionAddedRef: { current: false },
					setConversationError,
				})
			);

			await waitFor(() =>
				expect(setConversationError).toHaveBeenCalledWith(
					'Failed to initialize conversation. Please try again.'
				)
			);
			expect(sentryMocks.captureException).toHaveBeenCalledWith(error, {
				level: 'error',
				tags: { area: 'conversation_bootstrap' },
				extra: {
					mounted: true,
					selectedAgent: 'claude-code',
					directoryPath: '/project',
					agentName: 'Project',
					existingDocsChoice: null,
					conversationHistoryLength: 0,
					hasSshRemoteConfig: false,
					sshRemoteId: null,
				},
			});
		});
	});

	describe('useWizardConversationSend', () => {
		describe.each(['message', 'survey', 'existing-docs'] as const)('%s ownership', (mode) => {
			describe.each([
				['document list', 'resolve'],
				['document list', 'reject'],
				['document read', 'resolve'],
				['document read', 'reject'],
				['preparation', 'resolve'],
				['preparation', 'reject'],
			] as const)('pending %s that will %s', (stage, outcome) => {
				it.each(['configuration', 'provider', 'host', 'unmount'] as const)(
					'ignores late preparation after %s without disturbing the replacement',
					async (change) => {
						let release!: () => void;
						vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
							success: true,
							files: ['plan.md'],
						});
						if (stage === 'document list') {
							vi.mocked(window.maestro.autorun.listDocs).mockReturnValueOnce(
								new Promise((resolve, reject) => {
									release = () =>
										outcome === 'reject'
											? reject(new Error('obsolete listing'))
											: resolve({ success: true, files: ['obsolete.md'] });
								})
							);
						} else if (stage === 'document read') {
							vi.mocked(window.maestro.autorun.readDoc).mockReturnValueOnce(
								new Promise((resolve, reject) => {
									release = () =>
										outcome === 'reject'
											? reject(new Error('obsolete read'))
											: resolve({ success: true, content: 'Obsolete plan' });
								})
							);
						} else {
							conversationMocks.startConversation.mockReturnValueOnce(
								new Promise((resolve, reject) => {
									release = () =>
										outcome === 'reject'
											? reject(new Error('obsolete preparation'))
											: resolve('obsolete-session');
								})
							);
						}
						const state = createState({
							selectedAgent: 'grok',
							existingDocsChoice: 'continue',
							customEnvVars: { GROK_HOME: '/accounts/a' },
						});
						const hook = renderSendHook({ state, showInitialQuestion: false });
						let stale!: Promise<void>;
						act(() => {
							stale =
								mode === 'message'
									? hook.result.current.handleSendMessage()
									: hook.result.current.sendOpeningMessage(mode);
						});
						const boundary =
							stage === 'document list'
								? window.maestro.autorun.listDocs
								: stage === 'document read'
									? window.maestro.autorun.readDoc
									: conversationMocks.startConversation;
						await waitFor(() => expect(boundary).toHaveBeenCalledOnce());
						expect(conversationMocks.sendMessage).not.toHaveBeenCalled();
						const currentState = {
							...state,
							...(change === 'configuration'
								? {
										directoryPath: '/replacement',
										customPath: '/custom/grok',
										customArgs: '--reasoning-effort high',
										plannerModel: 'grok-4.5',
										customEnvVars: { GROK_HOME: '/accounts/b' },
									}
								: change === 'provider'
									? { selectedAgent: 'claude-code' as const }
									: { sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-b' } }),
						};
						if (change === 'unmount') hook.unmount();
						else hook.rerender(currentState);
						expect(conversationMocks.endConversation).toHaveBeenCalledOnce();
						expect(hook.refs.isSendingRef.current).toBe(false);
						let finish!: () => void;
						let replacement: Promise<void> | undefined;
						if (change !== 'unmount') {
							conversationMocks.sendMessage.mockImplementationOnce(
								() =>
									new Promise((resolve) => {
										finish = () => resolve({ success: true });
									})
							);
							act(() => {
								replacement = hook.result.current.handleSendMessage();
							});
							await waitFor(() => expect(conversationMocks.sendMessage).toHaveBeenCalledOnce());
							expect(conversationMocks.startConversation).toHaveBeenLastCalledWith(
								expect.objectContaining({
									agentType: currentState.selectedAgent,
									directoryPath: currentState.directoryPath,
									model: currentState.plannerModel,
									sessionCustomEnvVars: currentState.customEnvVars,
									sshRemoteConfig: currentState.sessionSshRemoteConfig,
									existingDocs: [{ filename: 'plan.md', content: 'Current plan' }],
								})
							);
						}
						// Only the old continuation runs after this snapshot; invalidation itself is allowed to clean up.
						const observers = [
							conversationMocks.startConversation,
							conversationMocks.sendMessage,
							conversationMocks.endConversation,
							...Object.values(hook.setters),
							hook.addMessage,
							hook.setConversationLoading,
							hook.setConversationError,
							hook.setConfidenceLevel,
							hook.setIsReadyToProceed,
							hook.announce,
							hook.scheduleAutoContinue,
							vi.mocked(hook.refs.inputRef.current!.focus),
						];
						const counts = observers.map((observer) => vi.mocked(observer).mock.calls.length);
						await act(async () => {
							release();
							await stale;
						});
						observers.forEach((observer, i) => expect(observer).toHaveBeenCalledTimes(counts[i]));
						expect(hook.refs.isSendingRef.current).toBe(change !== 'unmount');
						if (replacement) {
							await act(async () => {
								finish();
								await replacement;
							});
							expect(hook.refs.isSendingRef.current).toBe(false);
							expect(hook.refs.inputRef.current?.focus).toHaveBeenCalledOnce();
						}
					}
				);
			});

			describe.each(['failure', 'rejection'] as const)('late %s', (outcome) => {
				it.each([
					['custom path', { customPath: '/replacement/grok' }],
					['custom args', { customArgs: '--reasoning-effort low' }],
					['account environment', { customEnvVars: { GROK_HOME: '/accounts/b' } }],
					['planner model', { plannerModel: 'grok-4.5' }],
					['SSH host', { sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-b' } }],
					['Claude token opt-in', { enableMaestroP: false }],
					['Claude token mode', { maestroPMode: 'interactive' }],
					['Claude token executable', { maestroPPath: '/replacement/maestro-p' }],
					['provider', { selectedAgent: 'claude-code' }],
					['unmount', null],
				] satisfies [string, Partial<WizardConversationState> | null][])(
					'ignores stale callbacks and cleanup after changing %s',
					async (change, patch) => {
						const pending: {
							callbacks: ConversationCallbacks;
							resolve: (value: SendMessageResult) => void;
							reject: (error: Error) => void;
						}[] = [];
						conversationMocks.sendMessage.mockImplementation(
							(_message, _history, callbacks) =>
								new Promise<SendMessageResult>((resolve, reject) => {
									pending.push({ callbacks, resolve, reject });
								})
						);
						const state = createState({
							selectedAgent: change.startsWith('Claude') ? 'claude-code' : 'grok',
							...(change.startsWith('Claude')
								? {
										enableMaestroP: true,
										maestroPMode: 'dynamic' as const,
										maestroPPath: '/original/maestro-p',
									}
								: {}),
							customEnvVars: { GROK_HOME: '/accounts/a' },
						});
						const hook = renderSendHook({ state, showInitialQuestion: false });
						let stale!: Promise<void>;
						act(() => {
							stale =
								mode === 'message'
									? hook.result.current.handleSendMessage()
									: hook.result.current.sendOpeningMessage(mode);
						});
						await waitFor(() => expect(pending).toHaveLength(1));
						if (patch) hook.rerender({ ...state, ...patch });
						else hook.unmount();
						expect(conversationMocks.endConversation).toHaveBeenCalledOnce();
						let replacement: Promise<void> | undefined;
						if (patch) {
							act(() => {
								replacement =
									mode === 'message'
										? hook.result.current.handleSendMessage()
										: hook.result.current.sendOpeningMessage(mode);
							});
							await waitFor(() => expect(pending).toHaveLength(2));
							const current = { ...state, ...patch };
							expect(conversationMocks.startConversation).toHaveBeenLastCalledWith(
								expect.objectContaining({
									agentType: current.selectedAgent,
									model: current.plannerModel,
									sessionCustomPath: current.customPath,
									sessionCustomArgs: current.customArgs,
									sessionCustomEnvVars: current.customEnvVars,
									sshRemoteConfig: current.sessionSshRemoteConfig,
									claudeTokenSource: {
										enableMaestroP: current.enableMaestroP,
										maestroPMode: current.maestroPMode,
										maestroPPath: current.maestroPPath,
									},
								})
							);
							act(() => pending[1].callbacks.onChunk?.('replacement stream'));
						}
						const observers = [
							...Object.values(hook.setters),
							hook.addMessage,
							hook.setConversationLoading,
							hook.setConversationError,
							hook.setConfidenceLevel,
							hook.setIsReadyToProceed,
							hook.announce,
							hook.scheduleAutoContinue,
							conversationMocks.endConversation,
							vi.mocked(hook.refs.inputRef.current!.focus),
						];
						const counts = observers.map((observer) => vi.mocked(observer).mock.calls.length);
						const completion: SendMessageResult = {
							success: true,
							response: {
								structured: {
									confidence: 90,
									ready: true,
									message: 'Let me research this for you.',
								},
								rawText: 'Owned response',
								parseSuccess: true,
							},
						};
						await act(async () => {
							pending[0].callbacks.onChunk?.('stale stream');
							pending[0].callbacks.onThinkingChunk?.('stale thinking');
							pending[0].callbacks.onToolExecution?.({ toolName: 'Read', timestamp: 1 });
							pending[0].callbacks.onComplete?.(completion);
							pending[0].callbacks.onError?.('stale callback failure');
							if (outcome === 'rejection') pending[0].reject(new Error('stale rejection'));
							else
								pending[0].resolve({
									success: false,
									error: 'stale failure',
									detectedError: {
										type: 'rate_limited',
										title: 'Rate limited',
										message: 'Stale limit',
										recoveryHint: 'Try later',
										canRetry: true,
									},
								});
							await stale;
						});
						observers.forEach((observer, i) => expect(observer).toHaveBeenCalledTimes(counts[i]));
						expect(hook.refs.isSendingRef.current).toBe(patch !== null);
						expect(hook.refs.autoContinueTriggeredRef.current).toBe(false);
						if (replacement) {
							await act(async () => {
								pending[1].callbacks.onComplete?.(completion);
								pending[1].resolve(completion);
								await replacement;
							});
							expect(hook.setConfidenceLevel).toHaveBeenCalledExactlyOnceWith(90);
							expect(hook.setIsReadyToProceed).toHaveBeenCalledExactlyOnceWith(true);
							expect(hook.setConversationLoading).toHaveBeenLastCalledWith(false);
							expect(hook.refs.isSendingRef.current).toBe(false);
							expect(hook.refs.inputRef.current?.focus).toHaveBeenCalledOnce();
						}
					}
				);
			});

			it('keeps ownership across history/loading renders and replays retained context next time', async () => {
				vi.mocked(window.maestro.autorun.listDocs).mockResolvedValue({
					success: true,
					files: ['plan.md'],
				});
				const state = createState({
					selectedAgent: 'grok',
					existingDocsChoice: 'continue',
					customEnvVars: { GROK_HOME: '/accounts/a' },
					conversationHistory: [
						{ id: 'prior', role: 'assistant', content: 'Prior plan', timestamp: 1 },
					],
				});
				let callbacks!: ConversationCallbacks;
				let finish!: () => void;
				conversationMocks.sendMessage.mockImplementationOnce((_message, _history, handlers) => {
					callbacks = handlers;
					return new Promise((resolve) => {
						finish = () => resolve({ success: true });
					});
				});
				const hook = renderSendHook({ state, showInitialQuestion: false });
				let send!: Promise<void>;
				act(() => {
					send =
						mode === 'message'
							? hook.result.current.handleSendMessage()
							: hook.result.current.sendOpeningMessage(mode);
				});
				await waitFor(() => expect(conversationMocks.sendMessage).toHaveBeenCalledOnce());
				const user = hook.addMessage.mock.calls[0][0];
				const history = [...state.conversationHistory, { ...user, id: 'user', timestamp: 2 }];
				hook.rerender({ ...state, conversationHistory: history, isConversationLoading: true });
				expect(conversationMocks.endConversation).not.toHaveBeenCalled();
				expect(hook.refs.isSendingRef.current).toBe(true);
				act(() => callbacks.onChunk?.('{"type":"text","data":"Still owned"}\n'));
				expect(hook.setters.setStreamingText).toHaveBeenLastCalledWith('Still owned');
				hook.rerender({ ...state, conversationHistory: history, isConversationLoading: false });
				await act(async () => {
					await hook.result.current.handleSendMessage();
					await hook.result.current.sendOpeningMessage('survey');
				});
				expect(conversationMocks.sendMessage).toHaveBeenCalledOnce();
				await act(async () => {
					callbacks.onComplete?.({
						success: true,
						response: {
							structured: { confidence: 90, ready: true, message: 'Retained answer' },
							rawText: 'Retained answer',
							parseSuccess: true,
						},
					});
					finish();
					await send;
				});
				expect(hook.setIsReadyToProceed).toHaveBeenCalledExactlyOnceWith(true);
				expect(hook.refs.inputRef.current?.focus).toHaveBeenCalledOnce();
				const assistant = hook.addMessage.mock.calls.at(-1)![0];
				const retained = [...history, { ...assistant, id: 'answer', timestamp: 3 }];
				const current = {
					...state,
					conversationHistory: retained,
					customPath: '/custom/grok',
					customArgs: '--reasoning-effort high',
					customEnvVars: { GROK_HOME: '/accounts/b' },
					plannerModel: 'grok-4.5',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-b' },
				};
				hook.rerender(current);
				await act(async () => {
					await hook.result.current.handleSendMessage();
				});
				expect(conversationMocks.startConversation).toHaveBeenLastCalledWith(
					expect.objectContaining({
						agentType: 'grok',
						model: current.plannerModel,
						sessionCustomPath: current.customPath,
						sessionCustomArgs: current.customArgs,
						sessionCustomEnvVars: current.customEnvVars,
						sshRemoteConfig: current.sessionSshRemoteConfig,
						existingDocs: [{ filename: 'plan.md', content: 'Current plan' }],
					})
				);
				expect(conversationMocks.sendMessage).toHaveBeenLastCalledWith(
					'Build a dashboard',
					retained,
					expect.any(Object)
				);
				expect(retained.map((message) => message.content)).toEqual([
					'Prior plan',
					user.content,
					'Retained answer',
				]);
				expect(window.maestro.autorun.readDoc).toHaveBeenCalledTimes(2);
				expect(conversationMocks.endConversation).not.toHaveBeenCalled();
			});
		});

		it('sends a normal message, streams callbacks, and marks ready', async () => {
			const response = {
				structured: { confidence: 85, ready: true, message: 'Ready' },
				rawText: 'Ready',
				parseSuccess: true,
			};
			conversationMocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
				callbacks.onChunk?.(
					'{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Hi"}}}'
				);
				callbacks.onThinkingChunk?.('thinking');
				callbacks.onThinkingChunk?.('{"confidence":85,"message":"Ready"}');
				callbacks.onToolExecution?.({ toolName: 'Read', timestamp: 1 });
				callbacks.onComplete?.({ success: true, response });
				return { success: true, response };
			});

			const hook = renderSendHook();

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(hook.setters.setInputValue).toHaveBeenCalledWith('');
			expect(hook.setters.setShowInitialQuestion).toHaveBeenCalledWith(false);
			expect(hook.addMessage).toHaveBeenCalledWith({
				role: 'assistant',
				content: 'Initial question?',
			});
			expect(hook.addMessage).toHaveBeenCalledWith({
				role: 'user',
				content: 'Build a dashboard',
			});
			expect(hook.setters.setStreamingText).toHaveBeenCalledWith(expect.any(Function));
			expect(hook.setters.setThinkingContent).toHaveBeenCalledWith(expect.any(Function));
			expect(hook.setters.setToolExecutions).toHaveBeenCalledWith(expect.any(Function));
			expect(hook.setConfidenceLevel).toHaveBeenCalledWith(85);
			expect(hook.setIsReadyToProceed).toHaveBeenCalledWith(true);
			expect(hook.setConversationLoading).toHaveBeenNthCalledWith(1, true);
			expect(hook.setConversationLoading).toHaveBeenLastCalledWith(false);
			expect(hook.refs.inputRef.current?.focus).toHaveBeenCalled();
		});

		it.each(['message', 'survey', 'existing-docs'] as const)(
			'renders owned Grok %s previews and ignores callbacks after provider changes',
			async (mode) => {
				let callbacks!: ConversationCallbacks;
				let finish!: () => void;
				conversationMocks.sendMessage.mockImplementation((_message, _history, handlers) => {
					callbacks = handlers;
					return new Promise((resolve) => {
						finish = () => resolve({ success: true });
					});
				});
				const state = createState({ selectedAgent: 'grok' });
				const setters = createSetters();
				let text = '';
				const preview = render(
					<StreamingResponseBubble theme={mockTheme} agentName="grok" streamingText={text} />
				);
				vi.mocked(setters.setStreamingText).mockImplementation((value) => {
					text = typeof value === 'function' ? value(text) : value;
					preview.rerender(
						<StreamingResponseBubble theme={mockTheme} agentName="grok" streamingText={text} />
					);
				});
				const hook = renderSendHook({ state, setters, showInitialQuestion: false });
				let send!: Promise<void>;
				act(() => {
					send =
						mode === 'message'
							? hook.result.current.handleSendMessage()
							: hook.result.current.sendOpeningMessage(mode);
				});
				await waitFor(() => expect(conversationMocks.sendMessage).toHaveBeenCalledOnce());
				for (const chunk of [
					'{"ty',
					'pe":"thought","data":"private"}\n',
					'{"type":"text","data":"Hello "}\n',
					'{"type":"text","data":"world"}\n',
				]) {
					act(() => callbacks.onChunk?.(chunk));
				}
				expect(screen.getByText('Hello world')).toBeInTheDocument();
				expect(screen.getByText('🤖 grok')).toBeInTheDocument();
				expect(preview.container).not.toHaveTextContent('private');
				expect(hook.setIsReadyToProceed).not.toHaveBeenCalled();
				hook.rerender({ ...state, selectedAgent: 'claude-code' });
				expect(conversationMocks.endConversation).toHaveBeenCalledOnce();
				act(() => {
					callbacks.onChunk?.('late text');
					callbacks.onError?.('late error');
				});
				expect(preview.container).not.toHaveTextContent(/Hello|late/);
				expect(hook.setConversationError).not.toHaveBeenCalledWith('late error');
				await act(async () => {
					finish();
					await send;
				});
				expect(hook.refs.inputRef.current?.focus).not.toHaveBeenCalled();
				for (const selectedAgent of ['claude-code', 'grok'] as const) {
					hook.rerender({ ...state, selectedAgent });
					act(() => {
						send = hook.result.current.handleSendMessage();
					});
					await waitFor(() =>
						expect(conversationMocks.sendMessage).toHaveBeenCalledTimes(
							selectedAgent === 'claude-code' ? 2 : 3
						)
					);
					act(() =>
						callbacks.onChunk?.(
							selectedAgent === 'grok'
								? 'Fresh turn'
								: '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"text":"Fresh turn"}}}'
						)
					);
					expect(screen.getByText('Fresh turn')).toBeInTheDocument();
					expect(preview.container).not.toHaveTextContent(/Hello|private|late/);
					await act(async () => {
						finish();
						await send;
					});
				}
			}
		);

		it('prevents duplicate sends with the immediate guard', async () => {
			const refs = createRefs();
			refs.isSendingRef.current = true;
			const hook = renderSendHook({ refs });

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(conversationMocks.sendMessage).not.toHaveBeenCalled();
		});

		it('schedules auto-continue once for deferred assistant responses', async () => {
			const response = {
				structured: {
					confidence: 50,
					ready: false,
					message: 'Let me research this for you.',
				},
				rawText: 'Let me research this for you.',
				parseSuccess: true,
			};
			conversationMocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
				callbacks.onComplete?.({ success: true, response });
				return { success: true, response };
			});

			const hook = renderSendHook({ showInitialQuestion: false });

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(hook.scheduleAutoContinue).toHaveBeenCalledWith(AUTO_CONTINUE_MESSAGE);
			expect(hook.refs.autoContinueTriggeredRef.current).toBe(true);
		});

		it('propagates detected send failures', async () => {
			const detectedError = {
				type: 'rate_limited' as const,
				title: 'Rate limited',
				message: 'Slow down',
				recoveryHint: 'Try later',
				canRetry: true,
			};
			conversationMocks.sendMessage.mockResolvedValue({
				success: false,
				error: 'Failed',
				detectedError,
			});
			const hook = renderSendHook({ showInitialQuestion: false });

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(hook.setConversationError).toHaveBeenCalledWith('Failed');
			expect(hook.setters.setDetectedError).toHaveBeenCalledWith(detectedError);
			expect(hook.setters.setErrorRetryCount).toHaveBeenCalledWith(expect.any(Function));
		});

		it('propagates callback errors and announcements', async () => {
			conversationMocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
				callbacks.onError?.('Callback failed');
				return { success: false, error: 'Callback failed' };
			});
			const hook = renderSendHook({ showInitialQuestion: false });

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(hook.setConversationError).toHaveBeenCalledWith('Callback failed');
			expect(hook.announce).toHaveBeenCalledWith('Error: Callback failed. Please try again.');
			expect(hook.setters.setErrorRetryCount).toHaveBeenCalledTimes(1);
		});

		it('ignores thinking and tool callbacks while thinking display is off', async () => {
			conversationMocks.sendMessage.mockImplementation(async (_message, _history, callbacks) => {
				callbacks.onThinkingChunk?.('hidden thinking');
				callbacks.onToolExecution?.({ toolName: 'Read', timestamp: 1 });
				return { success: true };
			});
			const refs = createRefs();
			refs.showThinkingRef.current = false;
			const setters = createSetters();
			const hook = renderSendHook({ refs, setters, showInitialQuestion: false });

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(setters.setThinkingContent).toHaveBeenCalledWith('');
			expect(setters.setThinkingContent).not.toHaveBeenCalledWith(expect.any(Function));
			expect(setters.setToolExecutions).toHaveBeenCalledWith([]);
			expect(setters.setToolExecutions).not.toHaveBeenCalledWith(expect.any(Function));
		});

		it('auto-sends existing-doc analysis with empty history', async () => {
			conversationMocks.sendMessage.mockResolvedValue({ success: true });
			const hook = renderSendHook({ inputValue: '', showInitialQuestion: true });

			await act(async () => {
				await hook.result.current.sendOpeningMessage('existing-docs');
			});

			expect(hook.setters.setShowInitialQuestion).toHaveBeenCalledWith(false);
			expect(hook.refs.initialQuestionAddedRef.current).toBe(true);
			expect(hook.addMessage).toHaveBeenCalledWith({
				role: 'user',
				content:
					'Please analyze the existing Auto Run documents and provide a synopsis of the current plan.',
			});
			expect(conversationMocks.sendMessage).toHaveBeenCalledWith(
				expect.stringContaining('Please analyze the existing Auto Run documents'),
				[],
				expect.any(Object)
			);
			expect(hook.announce).toHaveBeenCalledWith('Analyzing existing documents...');
		});

		it('starts the conversation if a send arrives after manager cleanup', async () => {
			conversationMocks.isConversationActive.mockReturnValue(false);
			conversationMocks.sendMessage.mockResolvedValue({ success: true });
			const hook = renderSendHook({ showInitialQuestion: false });

			await act(async () => {
				await hook.result.current.handleSendMessage();
			});

			expect(conversationMocks.startConversation).toHaveBeenCalledWith({
				agentType: 'claude-code',
				directoryPath: '/project',
				projectName: 'project',
				model: undefined,
				sessionCustomPath: undefined,
				sessionCustomArgs: undefined,
				sessionCustomEnvVars: undefined,
				existingDocs: undefined,
				sshRemoteConfig: undefined,
				claudeTokenSource: {
					enableMaestroP: undefined,
					maestroPMode: undefined,
					maestroPPath: undefined,
				},
			});
		});
	});
});

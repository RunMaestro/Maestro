import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { parseWizardIntent } from '../../../services/wizardIntentParser';
import {
	startInlineWizardConversation,
	sendWizardMessage,
	type ConversationCallbacks,
	type ExistingDocumentWithContent,
	type InlineWizardConversationSession,
} from '../../../services/inlineWizardConversation';
import { logger } from '../../../utils/logger';
import { hasCapabilityCached } from '../../agent/useAgentCapabilities';
import {
	fetchHistoryFilePath,
	hasExistingDocuments,
	listExistingDocuments,
	loadDocumentContents,
	resolveAutoRunFolderPath,
} from './documents';
import { generateMessageId, initialInlineWizardState } from './state';
import type {
	InlineWizardMode,
	InlineWizardSessionOverrides,
	InlineWizardSshRemoteConfig,
	InlineWizardState,
	PreviousUIState,
	SetInlineWizardTabState,
} from './types';
import type { ToolType } from '../../../types';
import type { ExistingDocument } from '../../../utils/existingDocsDetector';

interface UseInlineWizardConversationActionsParams {
	currentTabId: string | null;
	setCurrentTabId: Dispatch<SetStateAction<string | null>>;
	tabStatesRef: MutableRefObject<Map<string, InlineWizardState>>;
	previousUIStateRefsMap: MutableRefObject<Map<string, PreviousUIState | null>>;
	conversationSessionsMap: MutableRefObject<Map<string, InlineWizardConversationSession>>;
	setTabState: SetInlineWizardTabState;
	getEffectiveTabId: () => string;
}

export function useInlineWizardConversationActions({
	currentTabId,
	setCurrentTabId,
	tabStatesRef,
	previousUIStateRefsMap,
	conversationSessionsMap,
	setTabState,
	getEffectiveTabId,
}: UseInlineWizardConversationActionsParams) {
	const startWizard = useCallback(
		async (
			naturalLanguageInput?: string,
			currentUIState?: PreviousUIState,
			projectPath?: string,
			agentType?: ToolType,
			sessionName?: string,
			tabId?: string,
			sessionId?: string,
			configuredAutoRunFolderPath?: string,
			sessionSshRemoteConfig?: InlineWizardSshRemoteConfig,
			conductorProfile?: string,
			sessionOverrides?: InlineWizardSessionOverrides
		): Promise<void> => {
			const effectiveTabId = tabId || 'default';
			const effectiveAutoRunFolderPath = resolveAutoRunFolderPath(
				projectPath,
				configuredAutoRunFolderPath
			);

			logger.info(`Starting inline wizard on tab ${effectiveTabId}`, '[InlineWizard]', {
				projectPath,
				agentType,
				sessionName,
				hasInput: !!naturalLanguageInput,
				autoRunFolderPath: effectiveAutoRunFolderPath,
			});

			if (currentUIState) {
				previousUIStateRefsMap.current.set(effectiveTabId, currentUIState);
			}

			setCurrentTabId(effectiveTabId);

			setTabState(effectiveTabId, () => ({
				...initialInlineWizardState,
				isActive: true,
				isInitializing: true,
				isWaiting: false,
				mode: null,
				goal: null,
				confidence: 0,
				ready: false,
				conversationHistory: [],
				isGeneratingDocs: false,
				generatedDocuments: [],
				existingDocuments: [],
				previousUIState: currentUIState || null,
				error: null,
				projectPath: projectPath || null,
				agentType: agentType || null,
				sessionName: sessionName || null,
				tabId: effectiveTabId,
				sessionId: sessionId || null,
				streamingContent: '',
				generationProgress: null,
				currentDocumentIndex: 0,
				lastUserMessageContent: null,
				agentSessionId: null,
				subfolderName: null,
				subfolderPath: null,
				autoRunFolderPath: effectiveAutoRunFolderPath,
				sessionSshRemoteConfig,
				sessionCustomPath: sessionOverrides?.customPath,
				sessionCustomArgs: sessionOverrides?.customArgs,
				sessionCustomEnvVars: sessionOverrides?.customEnvVars,
				sessionCustomModel: sessionOverrides?.customModel,
				conductorProfile,
			}));

			try {
				const historyFilePath = await fetchHistoryFilePath(sessionId, sessionSshRemoteConfig);
				const hasExistingDocs = await hasExistingDocuments(effectiveAutoRunFolderPath);

				let mode: InlineWizardMode;
				let goal: string | null = null;
				let existingDocs: ExistingDocument[] = [];

				const trimmedInput = naturalLanguageInput?.trim() || '';

				if (!trimmedInput) {
					mode = hasExistingDocs ? 'ask' : 'new';
				} else {
					const intentResult = parseWizardIntent(trimmedInput, hasExistingDocs);
					mode = intentResult.mode;
					goal = intentResult.goal || null;
				}

				let docsWithContent: ExistingDocumentWithContent[] = [];
				if (mode === 'iterate' && effectiveAutoRunFolderPath) {
					existingDocs = await listExistingDocuments(effectiveAutoRunFolderPath);
					docsWithContent = await loadDocumentContents(existingDocs, effectiveAutoRunFolderPath);
				}

				if (
					(mode === 'new' || mode === 'iterate') &&
					agentType &&
					hasCapabilityCached(agentType, 'supportsWizard') &&
					effectiveAutoRunFolderPath
				) {
					const session = startInlineWizardConversation({
						mode,
						agentType,
						directoryPath: projectPath || effectiveAutoRunFolderPath,
						projectName: sessionName || 'Project',
						goal: goal || undefined,
						existingDocs: docsWithContent.length > 0 ? docsWithContent : undefined,
						autoRunFolderPath: effectiveAutoRunFolderPath,
						sessionSshRemoteConfig,
						sessionCustomPath: sessionOverrides?.customPath,
						sessionCustomArgs: sessionOverrides?.customArgs,
						sessionCustomEnvVars: sessionOverrides?.customEnvVars,
						sessionCustomModel: sessionOverrides?.customModel,
						conductorProfile,
						historyFilePath,
					});

					conversationSessionsMap.current.set(effectiveTabId, session);

					logger.info(`Wizard conversation started (mode: ${mode})`, '[InlineWizard]', {
						sessionId: session.sessionId,
						tabId: effectiveTabId,
						mode,
						goal: goal || null,
						existingDocsCount: docsWithContent.length,
						autoRunFolderPath: effectiveAutoRunFolderPath,
					});
				} else if (
					(mode === 'new' || mode === 'iterate') &&
					agentType &&
					!hasCapabilityCached(agentType, 'supportsWizard')
				) {
					logger.warn(`Wizard not supported for agent type: ${agentType}`, '[InlineWizard]');
					setTabState(effectiveTabId, (prev) => ({
						...prev,
						isInitializing: false,
						error: `The inline wizard is not supported for this agent type.`,
					}));
					return;
				}

				setTabState(effectiveTabId, (prev) => ({
					...prev,
					isInitializing: false,
					mode,
					goal,
					existingDocuments: existingDocs,
					historyFilePath,
				}));
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Failed to initialize wizard';
				logger.error('[useInlineWizard] startWizard error:', undefined, error);

				setTabState(effectiveTabId, (prev) => ({
					...prev,
					isInitializing: false,
					mode: 'new',
					error: errorMessage,
				}));
			}
		},
		[conversationSessionsMap, previousUIStateRefsMap, setCurrentTabId, setTabState]
	);

	const sendMessage = useCallback(
		async (
			content: string,
			images?: string[],
			callbacks?: ConversationCallbacks,
			explicitTabId?: string
		): Promise<void> => {
			const tabId = explicitTabId || currentTabId || 'default';
			if (tabId !== currentTabId) {
				setCurrentTabId(tabId);
			}

			const currentState = tabStatesRef.current.get(tabId);
			if (currentState?.isWaiting) {
				logger.warn('[useInlineWizard] Already waiting for response, ignoring duplicate send');
				return;
			}

			const userMessage = {
				id: generateMessageId(),
				role: 'user' as const,
				content,
				timestamp: Date.now(),
				...(images && images.length > 0 ? { images } : {}),
			};

			setTabState(tabId, (prev) => ({
				...prev,
				conversationHistory: [...prev.conversationHistory, userMessage],
				lastUserMessageContent: content,
				isWaiting: true,
				error: null,
			}));

			let session = conversationSessionsMap.current.get(tabId);
			if (!session) {
				const currentState = tabStatesRef.current.get(tabId);
				const effectiveAutoRunFolderPath = resolveAutoRunFolderPath(
					currentState?.projectPath || undefined,
					currentState?.autoRunFolderPath || undefined
				);

				if (
					currentState?.mode === 'ask' &&
					currentState.agentType &&
					hasCapabilityCached(currentState.agentType, 'supportsWizard') &&
					effectiveAutoRunFolderPath
				) {
					logger.info('[useInlineWizard] Auto-creating session for direct message in ask mode');
					session = startInlineWizardConversation({
						mode: 'new',
						agentType: currentState.agentType,
						directoryPath: currentState.projectPath || effectiveAutoRunFolderPath,
						projectName: currentState.sessionName || 'Project',
						goal: currentState.goal || undefined,
						existingDocs: undefined,
						autoRunFolderPath: effectiveAutoRunFolderPath,
						sessionSshRemoteConfig: currentState.sessionSshRemoteConfig,
						sessionCustomPath: currentState.sessionCustomPath,
						sessionCustomArgs: currentState.sessionCustomArgs,
						sessionCustomEnvVars: currentState.sessionCustomEnvVars,
						sessionCustomModel: currentState.sessionCustomModel,
						conductorProfile: currentState.conductorProfile,
						historyFilePath: currentState.historyFilePath,
					});
					conversationSessionsMap.current.set(tabId, session);
					setTabState(tabId, (prev) => ({ ...prev, mode: 'new' }));
					logger.info('[useInlineWizard] Session created:', undefined, session.sessionId);
				} else {
					logger.error(
						'[useInlineWizard] No active conversation session, currentState:',
						undefined,
						{
							mode: currentState?.mode,
							agentType: currentState?.agentType,
							projectPath: currentState?.projectPath,
							autoRunFolderPath: currentState?.autoRunFolderPath,
						}
					);
					setTabState(tabId, (prev) => ({
						...prev,
						isWaiting: false,
						error: 'No active conversation session. Please restart the wizard.',
					}));
					callbacks?.onError?.('No active conversation session');
					return;
				}
			}

			try {
				const currentState = tabStatesRef.current.get(tabId);
				const currentHistory = currentState?.conversationHistory || [];

				const result = await sendWizardMessage(session, content, currentHistory, callbacks, images);

				if (result.success && result.response) {
					const assistantMessage = {
						id: generateMessageId(),
						role: 'assistant' as const,
						content: result.response.message,
						timestamp: Date.now(),
						confidence: result.response.confidence,
						ready: result.response.ready,
					};

					const incomingProjectName = result.response.projectName?.trim();
					setTabState(tabId, (prev) => ({
						...prev,
						conversationHistory: [...prev.conversationHistory, assistantMessage],
						confidence: result.response!.confidence,
						ready: result.response!.ready,
						extractedProjectName: incomingProjectName || prev.extractedProjectName,
						isWaiting: false,
						agentSessionId: prev.agentSessionId || result.agentSessionId || null,
					}));

					logger.info(
						`Wizard response received - confidence: ${result.response.confidence}%, ready: ${result.response.ready}`,
						'[InlineWizard]',
						{
							confidence: result.response.confidence,
							ready: result.response.ready,
							agentSessionId: result.agentSessionId || null,
						}
					);
				} else {
					const errorMessage = result.error || 'Failed to get response from AI';
					logger.error('[useInlineWizard] sendWizardMessage error:', undefined, errorMessage);

					setTabState(tabId, (prev) => ({
						...prev,
						isWaiting: false,
						error: errorMessage,
					}));
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				logger.error('[useInlineWizard] sendMessage error:', undefined, error);

				setTabState(tabId, (prev) => ({
					...prev,
					isWaiting: false,
					error: errorMessage,
				}));

				callbacks?.onError?.(errorMessage);
			}
		},
		[conversationSessionsMap, currentTabId, setCurrentTabId, setTabState, tabStatesRef]
	);

	const addAssistantMessage = useCallback(
		(content: string, confidence?: number, ready?: boolean) => {
			const tabId = currentTabId || 'default';
			if (tabId !== currentTabId) {
				setCurrentTabId(tabId);
			}
			const message = {
				id: generateMessageId(),
				role: 'assistant' as const,
				content,
				timestamp: Date.now(),
				confidence,
				ready,
			};

			setTabState(tabId, (prev) => ({
				...prev,
				conversationHistory: [...prev.conversationHistory, message],
				confidence: confidence !== undefined ? confidence : prev.confidence,
				ready: ready !== undefined ? ready : prev.ready,
			}));
		},
		[currentTabId, setCurrentTabId, setTabState]
	);

	const setMode = useCallback(
		(newMode: InlineWizardMode) => {
			const tabId = getEffectiveTabId();
			const currentState = tabStatesRef.current.get(tabId);

			if (
				currentState?.mode === 'ask' &&
				(newMode === 'new' || newMode === 'iterate') &&
				!conversationSessionsMap.current.has(tabId)
			) {
				const effectiveAutoRunFolderPath = resolveAutoRunFolderPath(
					currentState.projectPath || undefined,
					currentState.autoRunFolderPath || undefined
				);

				if (
					currentState.agentType &&
					hasCapabilityCached(currentState.agentType, 'supportsWizard') &&
					effectiveAutoRunFolderPath
				) {
					const session = startInlineWizardConversation({
						mode: newMode,
						agentType: currentState.agentType,
						directoryPath: currentState.projectPath || effectiveAutoRunFolderPath,
						projectName: currentState.sessionName || 'Project',
						goal: currentState.goal || undefined,
						existingDocs: undefined,
						autoRunFolderPath: effectiveAutoRunFolderPath,
						sessionSshRemoteConfig: currentState.sessionSshRemoteConfig,
						sessionCustomPath: currentState.sessionCustomPath,
						sessionCustomArgs: currentState.sessionCustomArgs,
						sessionCustomEnvVars: currentState.sessionCustomEnvVars,
						sessionCustomModel: currentState.sessionCustomModel,
						conductorProfile: currentState.conductorProfile,
						historyFilePath: currentState.historyFilePath,
					});

					conversationSessionsMap.current.set(tabId, session);
					logger.info(
						'[useInlineWizard] Conversation session started after mode selection:',
						undefined,
						session.sessionId
					);
				}
			}

			setTabState(tabId, (prev) => ({
				...prev,
				mode: newMode,
			}));
		},
		[conversationSessionsMap, getEffectiveTabId, setTabState, tabStatesRef]
	);

	const retryLastMessage = useCallback(
		async (callbacks?: ConversationCallbacks): Promise<void> => {
			const tabId = currentTabId || 'default';
			const currentState = tabStatesRef.current.get(tabId);
			const lastContent = currentState?.lastUserMessageContent;

			if (!lastContent || !currentState?.error) {
				logger.warn('[useInlineWizard] Cannot retry: no last message or no error');
				return;
			}

			const historyWithoutLastUser = [...(currentState.conversationHistory || [])];
			for (let i = historyWithoutLastUser.length - 1; i >= 0; i--) {
				if (historyWithoutLastUser[i].role === 'user') {
					historyWithoutLastUser.splice(i, 1);
					break;
				}
			}

			setTabState(tabId, (prev) => ({
				...prev,
				conversationHistory: historyWithoutLastUser,
				error: null,
			}));

			await sendMessage(lastContent, undefined, callbacks);
		},
		[currentTabId, sendMessage, setTabState, tabStatesRef]
	);

	const clearConversation = useCallback(() => {
		const tabId = currentTabId || 'default';
		setTabState(tabId, (prev) => ({
			...prev,
			conversationHistory: [],
		}));
	}, [currentTabId, setTabState]);

	return {
		startWizard,
		sendMessage,
		addAssistantMessage,
		setMode,
		retryLastMessage,
		clearConversation,
	};
}

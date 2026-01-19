/**
 * useInlineWizard.ts
 *
 * Hook for managing inline wizard state within a session.
 * The inline wizard allows users to create new Auto Run documents or iterate
 * on existing ones through a conversational interface triggered by `/wizard`.
 *
 * Unlike the full-screen onboarding wizard (MaestroWizard.tsx), this wizard
 * runs inline within the existing AI conversation interface.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { logger } from '../utils/logger';
import { parseWizardIntent } from '../services/wizardIntentParser';
import {
	hasExistingAutoRunDocs,
	getExistingAutoRunDocs,
	getAutoRunFolderPath,
	type ExistingDocument,
} from '../utils/existingDocsDetector';
import {
	startInlineWizardConversation,
	sendWizardMessage,
	endInlineWizardConversation,
	READY_CONFIDENCE_THRESHOLD,
	type InlineWizardConversationSession,
	type ExistingDocumentWithContent,
	type ConversationCallbacks,
} from '../services/inlineWizardConversation';
import {
	generateInlineDocuments,
	extractDisplayTextFromChunk,
	type DocumentGenerationCallbacks,
} from '../services/inlineWizardDocumentGeneration';
import type { ToolType } from '../types';

/**
 * Wizard mode determines whether the user wants to create new documents
 * or iterate on existing ones.
 */
export type InlineWizardMode = 'new' | 'iterate' | 'ask' | null;

/**
 * Message in the wizard conversation.
 * Simplified version of WizardMessage from onboarding wizard.
 */
export interface InlineWizardMessage {
	id: string;
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: number;
	/** Parsed confidence from assistant responses */
	confidence?: number;
	/** Parsed ready flag from assistant responses */
	ready?: boolean;
}

/**
 * UI state to restore when wizard ends.
 * These settings are temporarily overridden during wizard mode.
 */
export interface PreviousUIState {
	readOnlyMode: boolean;
	saveToHistory: boolean;
	showThinking: boolean;
}

/**
 * Generated document from the wizard.
 */
export interface InlineGeneratedDocument {
	filename: string;
	content: string;
	taskCount: number;
	/** Absolute path after saving */
	savedPath?: string;
}

/**
 * Progress tracking for document generation.
 * Used to display "Generating Phase 1 of 3..." during generation.
 */
export interface GenerationProgress {
	/** Current document being generated (1-indexed for display) */
	current: number;
	/** Total number of documents to generate */
	total: number;
}

/**
 * State shape for the inline wizard.
 */
export interface InlineWizardState {
	/** Whether wizard is currently active */
	isActive: boolean;
	/** Whether wizard is initializing (checking for existing docs, parsing intent) */
	isInitializing: boolean;
	/** Whether waiting for AI response */
	isWaiting: boolean;
	/** Current wizard mode */
	mode: InlineWizardMode;
	/** Goal for iterate mode (what the user wants to add/change) */
	goal: string | null;
	/** Confidence level from agent responses (0-100) */
	confidence: number;
	/** Whether the AI is ready to proceed with document generation */
	ready: boolean;
	/** Conversation history for this wizard session */
	conversationHistory: InlineWizardMessage[];
	/** Whether documents are being generated */
	isGeneratingDocs: boolean;
	/** Generated documents (if any) */
	generatedDocuments: InlineGeneratedDocument[];
	/** Existing Auto Run documents loaded for iterate mode context */
	existingDocuments: ExistingDocument[];
	/** Previous UI state to restore when wizard ends */
	previousUIState: PreviousUIState | null;
	/** Error message if something goes wrong */
	error: string | null;
	/** Last user message content (for retry functionality) */
	lastUserMessageContent: string | null;
	/** Project path used for document detection */
	projectPath: string | null;
	/** Agent type for the session */
	agentType: ToolType | null;
	/** Session name/project name */
	sessionName: string | null;
	/** Tab ID the wizard was started on (for per-tab isolation) */
	tabId: string | null;
	/** Session ID for playbook creation */
	sessionId: string | null;
	/** Streaming content being generated (accumulates as AI outputs) */
	streamingContent: string;
	/** Progress tracking for document generation */
	generationProgress: GenerationProgress | null;
	/** Currently selected document index (for DocumentGenerationView) */
	currentDocumentIndex: number;
	/** The Claude agent session ID (from session_id in output) - used to switch tab after wizard completes */
	agentSessionId: string | null;
	/** Subfolder name where documents were saved (e.g., "Maestro-Marketing") - used for tab naming after wizard completes */
	subfolderName: string | null;
	/** Full path to the subfolder where documents are saved (e.g., "/path/Auto Run Docs/Maestro-Marketing") */
	subfolderPath: string | null;
	/** User-configured Auto Run folder path (overrides default projectPath/Auto Run Docs) */
	autoRunFolderPath: string | null;
}

/**
 * Return type for useInlineWizard hook.
 */
export interface UseInlineWizardReturn {
	/** Whether the wizard is currently active (for the current active tab) */
	isWizardActive: boolean;
	/** Whether the wizard is initializing (checking for existing docs, parsing intent) */
	isInitializing: boolean;
	/** Whether waiting for AI response */
	isWaiting: boolean;
	/** Current wizard mode */
	wizardMode: InlineWizardMode;
	/** Goal for iterate mode */
	wizardGoal: string | null;
	/** Current confidence level (0-100) */
	confidence: number;
	/** Whether the AI is ready to proceed with document generation */
	ready: boolean;
	/** Whether the wizard is ready to generate documents (ready=true && confidence >= threshold) */
	readyToGenerate: boolean;
	/** Conversation history */
	conversationHistory: InlineWizardMessage[];
	/** Whether documents are being generated */
	isGeneratingDocs: boolean;
	/** Generated documents */
	generatedDocuments: InlineGeneratedDocument[];
	/** Existing documents loaded for iterate mode */
	existingDocuments: ExistingDocument[];
	/** Error message if any */
	error: string | null;
	/** Streaming content being generated (accumulates as AI outputs) */
	streamingContent: string;
	/** Progress tracking for document generation (e.g., "Phase 1 of 3") */
	generationProgress: GenerationProgress | null;
	/** Tab ID the wizard was started on (for per-tab isolation) */
	wizardTabId: string | null;
	/** The Claude agent session ID (from session_id in output) - used to switch tab after wizard completes */
	agentSessionId: string | null;
	/** Full wizard state (for the current active tab) */
	state: InlineWizardState;
	/** Get wizard state for a specific tab (returns undefined if no wizard on that tab) */
	getStateForTab: (tabId: string) => InlineWizardState | undefined;
	/** Check if a specific tab has an active wizard */
	isWizardActiveForTab: (tabId: string) => boolean;
	/**
	 * Start the wizard with intent parsing flow.
	 * @param naturalLanguageInput - Optional input from `/wizard <text>` command
	 * @param currentUIState - Current UI state to restore when wizard ends
	 * @param projectPath - Project path to check for existing Auto Run documents
	 * @param agentType - The AI agent type to use for conversation
	 * @param sessionName - The session name (used as project name)
	 * @param tabId - The tab ID to associate the wizard with
	 * @param sessionId - The session ID for playbook creation
	 * @param autoRunFolderPath - User-configured Auto Run folder path (if set, overrides default projectPath/Auto Run Docs)
	 */
	startWizard: (
		naturalLanguageInput?: string,
		currentUIState?: PreviousUIState,
		projectPath?: string,
		agentType?: ToolType,
		sessionName?: string,
		tabId?: string,
		sessionId?: string,
		autoRunFolderPath?: string
	) => Promise<void>;
	/** End the wizard and restore previous UI state */
	endWizard: () => Promise<PreviousUIState | null>;
	/**
	 * Send a message to the wizard conversation.
	 * @param content - Message content
	 * @param callbacks - Optional callbacks for streaming progress
	 */
	sendMessage: (content: string, callbacks?: ConversationCallbacks) => Promise<void>;
	/**
	 * Set the confidence level.
	 * @param value - Confidence value (0-100)
	 */
	setConfidence: (value: number) => void;
	/** Set the wizard mode */
	setMode: (mode: InlineWizardMode) => void;
	/** Set the goal for iterate mode */
	setGoal: (goal: string | null) => void;
	/** Set whether documents are being generated */
	setGeneratingDocs: (generating: boolean) => void;
	/** Set generated documents */
	setGeneratedDocuments: (docs: InlineGeneratedDocument[]) => void;
	/** Set existing documents (for iterate mode context) */
	setExistingDocuments: (docs: ExistingDocument[]) => void;
	/** Set error message */
	setError: (error: string | null) => void;
	/** Clear the current error */
	clearError: () => void;
	/**
	 * Retry sending the last user message that failed.
	 * Only works if there was a previous user message and an error occurred.
	 * @param callbacks - Optional callbacks for streaming progress
	 */
	retryLastMessage: (callbacks?: ConversationCallbacks) => Promise<void>;
	/** Add an assistant response to the conversation */
	addAssistantMessage: (content: string, confidence?: number, ready?: boolean) => void;
	/** Clear conversation history */
	clearConversation: () => void;
	/** Reset the wizard to initial state */
	reset: () => void;
	/**
	 * Generate Auto Run documents based on the conversation.
	 * Sets isGeneratingDocs to true, streams AI response, parses documents,
	 * and saves them to the Auto Run folder.
	 * @param callbacks - Optional callbacks for generation progress
	 * @param tabId - Optional tab ID to generate for (defaults to currentTabId)
	 */
	generateDocuments: (callbacks?: DocumentGenerationCallbacks, tabId?: string) => Promise<void>;
}

/**
 * Generate a unique message ID.
 */
function generateMessageId(): string {
	return `iwm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Initial wizard state.
 */
const initialState: InlineWizardState = {
	isActive: false,
	isInitializing: false,
	isWaiting: false,
	mode: null,
	goal: null,
	confidence: 0,
	ready: false,
	conversationHistory: [],
	isGeneratingDocs: false,
	generatedDocuments: [],
	existingDocuments: [],
	previousUIState: null,
	error: null,
	lastUserMessageContent: null,
	projectPath: null,
	agentType: null,
	sessionName: null,
	tabId: null,
	sessionId: null,
	streamingContent: '',
	generationProgress: null,
	currentDocumentIndex: 0,
	agentSessionId: null,
	subfolderName: null,
	subfolderPath: null,
	autoRunFolderPath: null,
};

/**
 * Hook for managing inline wizard state.
 *
 * The inline wizard is triggered by the `/wizard` slash command and allows
 * users to create or iterate on Auto Run documents within their existing
 * session context.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const {
 *     isWizardActive,
 *     wizardMode,
 *     startWizard,
 *     endWizard,
 *     sendMessage,
 *   } = useInlineWizard();
 *
 *   // Start wizard when user types /wizard
 *   const handleSlashCommand = (cmd: string, args: string) => {
 *     if (cmd === '/wizard') {
 *       startWizard(args, { readOnlyMode: true, saveToHistory: false, showThinking: false });
 *     }
 *   };
 *
 *   // Render wizard UI when active
 *   if (isWizardActive) {
 *     return <WizardInterface mode={wizardMode} />;
 *   }
 * }
 * ```
 */
export function useInlineWizard(): UseInlineWizardReturn {
	// Per-tab wizard states - Map from tabId to wizard state
	// This allows multiple independent wizards to run on different tabs
	const [tabStates, setTabStates] = useState<Map<string, InlineWizardState>>(new Map());

	// Track the "current" tab for backward compatibility with existing return values
	// This gets updated whenever startWizard is called with a tabId
	const [currentTabId, setCurrentTabId] = useState<string | null>(null);

	// Derive the "current" state for backward compatibility
	// If no wizard is active on the current tab, return initialState
	const state = currentTabId ? (tabStates.get(currentTabId) ?? initialState) : initialState;

	// Use ref to hold current state map for access in callbacks without stale closures
	const tabStatesRef = useRef<Map<string, InlineWizardState>>(tabStates);
	useEffect(() => {
		tabStatesRef.current = tabStates;
	}, [tabStates]);

	// Per-tab previous UI state refs - Map from tabId to previous UI state
	const previousUIStateRefsMap = useRef<Map<string, PreviousUIState | null>>(new Map());

	// Per-tab conversation sessions - Map from tabId to conversation session
	const conversationSessionsMap = useRef<Map<string, InlineWizardConversationSession>>(new Map());

	/**
	 * Helper to update state for a specific tab
	 */
	const setTabState = useCallback(
		(tabId: string, updater: (prev: InlineWizardState) => InlineWizardState) => {
			setTabStates((prevMap) => {
				const newMap = new Map(prevMap);
				const prevState = newMap.get(tabId) ?? initialState;
				newMap.set(tabId, updater(prevState));
				return newMap;
			});
		},
		[]
	);

	/**
	 * Get state for a specific tab
	 */
	const getStateForTab = useCallback(
		(tabId: string): InlineWizardState | undefined => {
			return tabStates.get(tabId);
		},
		[tabStates]
	);

	/**
	 * Check if a specific tab has an active wizard
	 */
	const isWizardActiveForTab = useCallback(
		(tabId: string): boolean => {
			const tabState = tabStates.get(tabId);
			return tabState?.isActive ?? false;
		},
		[tabStates]
	);

	/**
	 * Load document contents for existing documents.
	 * Converts ExistingDocument[] to ExistingDocumentWithContent[].
	 */
	const loadDocumentContents = useCallback(
		async (
			docs: ExistingDocument[],
			autoRunFolderPath: string
		): Promise<ExistingDocumentWithContent[]> => {
			const docsWithContent: ExistingDocumentWithContent[] = [];

			for (const doc of docs) {
				try {
					const result = await window.maestro.autorun.readDoc(autoRunFolderPath, doc.name);
					if (result.success && result.content) {
						docsWithContent.push({
							...doc,
							content: result.content,
						});
					} else {
						// Include doc without content if read failed
						docsWithContent.push({
							...doc,
							content: '(Failed to load content)',
						});
					}
				} catch (error) {
					console.warn(`[useInlineWizard] Failed to load ${doc.filename}:`, error);
					docsWithContent.push({
						...doc,
						content: '(Failed to load content)',
					});
				}
			}

			return docsWithContent;
		},
		[]
	);

	/**
	 * Start the wizard with intent parsing flow.
	 *
	 * Flow:
	 * 1. Check if project has existing Auto Run documents
	 * 2. If no input provided and docs exist → 'ask' mode (prompt user)
	 * 3. If input provided → parse intent to determine mode
	 * 4. If mode is 'iterate' → load existing docs with content for context
	 * 5. Initialize conversation session with appropriate prompt
	 */
	const startWizard = useCallback(
		async (
			naturalLanguageInput?: string,
			currentUIState?: PreviousUIState,
			projectPath?: string,
			agentType?: ToolType,
			sessionName?: string,
			tabId?: string,
			sessionId?: string,
			configuredAutoRunFolderPath?: string
		): Promise<void> => {
			// Tab ID is required for per-tab wizard management
			const effectiveTabId = tabId || 'default';

			// Determine the Auto Run folder path to use:
			// 1. If user has configured a specific path (configuredAutoRunFolderPath), use it
			// 2. Otherwise, fall back to the default: projectPath/Auto Run Docs
			const effectiveAutoRunFolderPath =
				configuredAutoRunFolderPath || (projectPath ? getAutoRunFolderPath(projectPath) : null);

			logger.info(`Starting inline wizard on tab ${effectiveTabId}`, '[InlineWizard]', {
				projectPath,
				agentType,
				sessionName,
				hasInput: !!naturalLanguageInput,
				autoRunFolderPath: effectiveAutoRunFolderPath,
			});

			// Store current UI state for later restoration (per-tab)
			if (currentUIState) {
				previousUIStateRefsMap.current.set(effectiveTabId, currentUIState);
			}

			// Update current tab ID for backward-compatible return values
			setCurrentTabId(effectiveTabId);

			// Set initializing state immediately for this tab
			setTabState(effectiveTabId, () => ({
				...initialState,
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
			}));

			try {
				// Step 1: Check for existing Auto Run documents in the configured folder
				// Use the effective Auto Run folder path (user-configured or default)
				let hasExistingDocs = false;
				if (effectiveAutoRunFolderPath) {
					try {
						const result = await window.maestro.autorun.listDocs(effectiveAutoRunFolderPath);
						hasExistingDocs = result.success && result.files && result.files.length > 0;
					} catch {
						// Folder doesn't exist or can't be read - no existing docs
						hasExistingDocs = false;
					}
				}

				// Step 2: Determine mode based on input and existing docs
				let mode: InlineWizardMode;
				let goal: string | null = null;
				let existingDocs: ExistingDocument[] = [];

				const trimmedInput = naturalLanguageInput?.trim() || '';

				if (!trimmedInput) {
					// No input provided
					if (hasExistingDocs) {
						// Docs exist - ask user what they want to do
						mode = 'ask';
					} else {
						// No docs - default to new mode
						mode = 'new';
					}
				} else {
					// Input provided - parse intent
					const intentResult = parseWizardIntent(trimmedInput, hasExistingDocs);
					mode = intentResult.mode;
					goal = intentResult.goal || null;
				}

				// Step 3: If iterate mode, load existing docs with content for context
				let docsWithContent: ExistingDocumentWithContent[] = [];
				if (mode === 'iterate' && effectiveAutoRunFolderPath) {
					// List docs from the configured Auto Run folder
					try {
						const result = await window.maestro.autorun.listDocs(effectiveAutoRunFolderPath);
						if (result.success && result.files) {
							existingDocs = result.files.map((name: string) => ({
								name,
								filename: `${name}.md`,
								path: `${effectiveAutoRunFolderPath}/${name}.md`,
							}));
						}
					} catch {
						existingDocs = [];
					}
					docsWithContent = await loadDocumentContents(existingDocs, effectiveAutoRunFolderPath);
				}

				// Step 4: Initialize conversation session (only for 'new' or 'iterate' modes)
				if ((mode === 'new' || mode === 'iterate') && agentType && effectiveAutoRunFolderPath) {
					const session = startInlineWizardConversation({
						mode,
						agentType,
						directoryPath: projectPath || effectiveAutoRunFolderPath,
						projectName: sessionName || 'Project',
						goal: goal || undefined,
						existingDocs: docsWithContent.length > 0 ? docsWithContent : undefined,
						autoRunFolderPath: effectiveAutoRunFolderPath,
					});

					// Store conversation session per-tab
					conversationSessionsMap.current.set(effectiveTabId, session);

					logger.info(`Wizard conversation started (mode: ${mode})`, '[InlineWizard]', {
						sessionId: session.sessionId,
						tabId: effectiveTabId,
						mode,
						goal: goal || null,
						existingDocsCount: docsWithContent.length,
						autoRunFolderPath: effectiveAutoRunFolderPath,
					});
				}

				// Update state with parsed results
				setTabState(effectiveTabId, (prev) => ({
					...prev,
					isInitializing: false,
					mode,
					goal,
					existingDocuments: existingDocs,
				}));
			} catch (error) {
				// Handle any errors during initialization
				const errorMessage = error instanceof Error ? error.message : 'Failed to initialize wizard';
				console.error('[useInlineWizard] startWizard error:', error);

				setTabState(effectiveTabId, (prev) => ({
					...prev,
					isInitializing: false,
					mode: 'new', // Default to new mode on error
					error: errorMessage,
				}));
			}
		},
		[loadDocumentContents, setTabState]
	);

	/**
	 * End the wizard and return the previous UI state for restoration.
	 * Uses the current tab ID to determine which wizard to end.
	 */
	const endWizard = useCallback(async (): Promise<PreviousUIState | null> => {
		// Get the tab ID from the current state
		const tabId = currentTabId || 'default';

		// Get previous UI state for this tab
		const previousState = previousUIStateRefsMap.current.get(tabId) || null;
		previousUIStateRefsMap.current.delete(tabId);

		// Clean up conversation session for this tab
		const session = conversationSessionsMap.current.get(tabId);
		if (session) {
			try {
				await endInlineWizardConversation(session);
				logger.info(`Wizard conversation ended`, '[InlineWizard]', {
					tabId,
					sessionId: session.sessionId,
				});
			} catch (error) {
				console.warn('[useInlineWizard] Failed to end conversation session:', error);
			}
			conversationSessionsMap.current.delete(tabId);
		}

		// Remove the wizard state for this tab
		setTabStates((prevMap) => {
			const newMap = new Map(prevMap);
			newMap.delete(tabId);
			return newMap;
		});

		return previousState;
	}, [currentTabId]);

	/**
	 * Send a user message to the wizard conversation.
	 * Adds the message to history, calls the AI service, and updates state with response.
	 * Uses the current tab ID to determine which wizard to send to.
	 */
	const sendMessage = useCallback(
		async (content: string, callbacks?: ConversationCallbacks): Promise<void> => {
			// Get the tab ID from the current state, ensure currentTabId is set for visibility
			const tabId = currentTabId || 'default';
			if (tabId !== currentTabId) {
				setCurrentTabId(tabId);
			}

			// Guard against concurrent calls - prevents race conditions
			const currentState = tabStatesRef.current.get(tabId);
			if (currentState?.isWaiting) {
				console.warn('[useInlineWizard] Already waiting for response, ignoring duplicate send');
				return;
			}

			// Create user message
			const userMessage: InlineWizardMessage = {
				id: generateMessageId(),
				role: 'user',
				content,
				timestamp: Date.now(),
			};

			// Add user message to history, track it for retry, and set waiting state
			setTabState(tabId, (prev) => ({
				...prev,
				conversationHistory: [...prev.conversationHistory, userMessage],
				lastUserMessageContent: content,
				isWaiting: true,
				error: null,
			}));

			// Check if we have an active conversation session for this tab
			let session = conversationSessionsMap.current.get(tabId);
			if (!session) {
				// If we're in 'ask' mode and don't have a session, auto-create one with 'new' mode
				// This happens when user types directly instead of using the mode selection modal
				const currentState = tabStatesRef.current.get(tabId);
				// Use stored autoRunFolderPath from state (configured by user or default)
				const effectiveAutoRunFolderPath =
					currentState?.autoRunFolderPath ||
					(currentState?.projectPath ? getAutoRunFolderPath(currentState.projectPath) : null);

				if (currentState?.mode === 'ask' && currentState.agentType && effectiveAutoRunFolderPath) {
					console.log('[useInlineWizard] Auto-creating session for direct message in ask mode');
					session = startInlineWizardConversation({
						mode: 'new',
						agentType: currentState.agentType,
						directoryPath: currentState.projectPath || effectiveAutoRunFolderPath,
						projectName: currentState.sessionName || 'Project',
						goal: currentState.goal || undefined,
						existingDocs: undefined,
						autoRunFolderPath: effectiveAutoRunFolderPath,
					});
					conversationSessionsMap.current.set(tabId, session);
					// Update mode to 'new' since we're proceeding with a new plan
					setTabState(tabId, (prev) => ({ ...prev, mode: 'new' }));
					console.log('[useInlineWizard] Session created:', session.sessionId);
				} else {
					console.error('[useInlineWizard] No active conversation session, currentState:', {
						mode: currentState?.mode,
						agentType: currentState?.agentType,
						projectPath: currentState?.projectPath,
						autoRunFolderPath: currentState?.autoRunFolderPath,
					});
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
				// Get current conversation history for this tab
				const currentState = tabStatesRef.current.get(tabId);
				const currentHistory = currentState?.conversationHistory || [];

				// Call the AI service
				const result = await sendWizardMessage(session, content, currentHistory, callbacks);

				if (result.success && result.response) {
					// Create assistant message from response
					const assistantMessage: InlineWizardMessage = {
						id: generateMessageId(),
						role: 'assistant',
						content: result.response.message,
						timestamp: Date.now(),
						confidence: result.response.confidence,
						ready: result.response.ready,
					};

					// Update state with response and capture agent session ID if available
					setTabState(tabId, (prev) => ({
						...prev,
						conversationHistory: [...prev.conversationHistory, assistantMessage],
						confidence: result.response!.confidence,
						ready: result.response!.ready,
						isWaiting: false,
						// Capture the first agentSessionId we receive (subsequent messages may not have it)
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
					// Handle error response
					const errorMessage = result.error || 'Failed to get response from AI';
					console.error('[useInlineWizard] sendWizardMessage error:', errorMessage);

					setTabState(tabId, (prev) => ({
						...prev,
						isWaiting: false,
						error: errorMessage,
					}));

					callbacks?.onError?.(errorMessage);
				}
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
				console.error('[useInlineWizard] sendMessage error:', error);

				setTabState(tabId, (prev) => ({
					...prev,
					isWaiting: false,
					error: errorMessage,
				}));

				callbacks?.onError?.(errorMessage);
			}
		},
		[currentTabId, setTabState] // Depend on currentTabId and setTabState
	);

	/**
	 * Add an assistant response to the conversation.
	 * Uses the current tab ID to determine which wizard to update.
	 */
	const addAssistantMessage = useCallback(
		(content: string, confidence?: number, ready?: boolean) => {
			// Get the tab ID from the current state, ensure currentTabId is set for visibility
			const tabId = currentTabId || 'default';
			if (tabId !== currentTabId) {
				setCurrentTabId(tabId);
			}
			const message: InlineWizardMessage = {
				id: generateMessageId(),
				role: 'assistant',
				content,
				timestamp: Date.now(),
				confidence,
				ready,
			};

			setTabState(tabId, (prev) => ({
				...prev,
				conversationHistory: [...prev.conversationHistory, message],
				// Update confidence and ready if provided
				confidence: confidence !== undefined ? confidence : prev.confidence,
				ready: ready !== undefined ? ready : prev.ready,
			}));
		},
		[currentTabId, setTabState]
	);

	/**
	 * Helper to get the effective tab ID and ensure currentTabId is set.
	 * This is used by setters to ensure state changes are visible via the hook's return values.
	 */
	const getEffectiveTabId = useCallback(() => {
		const tabId = currentTabId || 'default';
		if (tabId !== currentTabId) {
			setCurrentTabId(tabId);
		}
		return tabId;
	}, [currentTabId]);

	/**
	 * Set the confidence level.
	 * Uses the current tab ID to determine which wizard to update.
	 */
	const setConfidence = useCallback(
		(value: number) => {
			const tabId = getEffectiveTabId();
			setTabState(tabId, (prev) => ({
				...prev,
				confidence: Math.max(0, Math.min(100, value)),
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	/**
	 * Set the wizard mode.
	 * If transitioning from 'ask' mode to 'new' or 'iterate', this will also
	 * initialize the conversation session (since it wasn't created during startWizard).
	 * Uses the current tab ID to determine which wizard to update.
	 */
	const setMode = useCallback(
		(newMode: InlineWizardMode) => {
			const tabId = getEffectiveTabId();
			const currentState = tabStatesRef.current.get(tabId);

			// If transitioning from 'ask' to 'new' or 'iterate', we need to create the conversation session
			if (
				currentState?.mode === 'ask' &&
				(newMode === 'new' || newMode === 'iterate') &&
				!conversationSessionsMap.current.has(tabId)
			) {
				// Create conversation session if we have the required info
				// Use the stored autoRunFolderPath from state (configured by user or default)
				const effectiveAutoRunFolderPath =
					currentState.autoRunFolderPath ||
					(currentState.projectPath ? getAutoRunFolderPath(currentState.projectPath) : null);

				if (currentState.agentType && effectiveAutoRunFolderPath) {
					const session = startInlineWizardConversation({
						mode: newMode,
						agentType: currentState.agentType,
						directoryPath: currentState.projectPath || effectiveAutoRunFolderPath,
						projectName: currentState.sessionName || 'Project',
						goal: currentState.goal || undefined,
						existingDocs: undefined, // Will be loaded separately if needed
						autoRunFolderPath: effectiveAutoRunFolderPath,
					});

					conversationSessionsMap.current.set(tabId, session);
					console.log(
						'[useInlineWizard] Conversation session started after mode selection:',
						session.sessionId
					);
				}
			}

			setTabState(tabId, (prev) => ({
				...prev,
				mode: newMode,
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	/**
	 * Set the goal for iterate mode.
	 * Uses the current tab ID to determine which wizard to update.
	 */
	const setGoal = useCallback(
		(goal: string | null) => {
			const tabId = getEffectiveTabId();
			setTabState(tabId, (prev) => ({
				...prev,
				goal,
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	/**
	 * Set whether documents are being generated.
	 * Uses the current tab ID to determine which wizard to update.
	 */
	const setGeneratingDocs = useCallback(
		(generating: boolean) => {
			const tabId = getEffectiveTabId();
			setTabState(tabId, (prev) => ({
				...prev,
				isGeneratingDocs: generating,
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	/**
	 * Set generated documents.
	 * Uses the current tab ID to determine which wizard to update.
	 */
	const setGeneratedDocuments = useCallback(
		(docs: InlineGeneratedDocument[]) => {
			const tabId = getEffectiveTabId();
			setTabState(tabId, (prev) => ({
				...prev,
				generatedDocuments: docs,
				isGeneratingDocs: false,
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	/**
	 * Set existing documents (for iterate mode context).
	 * Uses the current tab ID to determine which wizard to update.
	 */
	const setExistingDocuments = useCallback(
		(docs: ExistingDocument[]) => {
			const tabId = getEffectiveTabId();
			setTabState(tabId, (prev) => ({
				...prev,
				existingDocuments: docs,
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	/**
	 * Set error message.
	 * Uses the current tab ID to determine which wizard to update.
	 */
	const setError = useCallback(
		(error: string | null) => {
			const tabId = getEffectiveTabId();
			setTabState(tabId, (prev) => ({
				...prev,
				error,
			}));
		},
		[getEffectiveTabId, setTabState]
	);

	/**
	 * Clear the current error.
	 * Uses the current tab ID to determine which wizard to update.
	 */
	const clearError = useCallback(() => {
		const tabId = getEffectiveTabId();
		setTabState(tabId, (prev) => ({
			...prev,
			error: null,
		}));
	}, [getEffectiveTabId, setTabState]);

	/**
	 * Retry sending the last user message that failed.
	 * Removes the failed user message from history and re-sends it.
	 * Uses the current tab ID to determine which wizard to update.
	 */
	const retryLastMessage = useCallback(
		async (callbacks?: ConversationCallbacks): Promise<void> => {
			const tabId = currentTabId || 'default';
			const currentState = tabStatesRef.current.get(tabId);
			const lastContent = currentState?.lastUserMessageContent;

			// Only retry if we have a last message and there's an error
			if (!lastContent || !currentState?.error) {
				console.warn('[useInlineWizard] Cannot retry: no last message or no error');
				return;
			}

			// Remove the last user message from history (it failed, so we'll re-add it)
			// Find the last user message in history
			const historyWithoutLastUser = [...(currentState.conversationHistory || [])];
			for (let i = historyWithoutLastUser.length - 1; i >= 0; i--) {
				if (historyWithoutLastUser[i].role === 'user') {
					historyWithoutLastUser.splice(i, 1);
					break;
				}
			}

			// Clear error and update history
			setTabState(tabId, (prev) => ({
				...prev,
				conversationHistory: historyWithoutLastUser,
				error: null,
			}));

			// Re-send the message
			await sendMessage(lastContent, callbacks);
		},
		[currentTabId, setTabState, sendMessage]
	);

	/**
	 * Clear conversation history.
	 * Uses the current tab ID to determine which wizard to update.
	 */
	const clearConversation = useCallback(() => {
		const tabId = currentTabId || 'default';
		setTabState(tabId, (prev) => ({
			...prev,
			conversationHistory: [],
		}));
	}, [currentTabId, setTabState]);

	/**
	 * Reset the wizard to initial state.
	 * Uses the current tab ID to determine which wizard to reset.
	 */
	const reset = useCallback(() => {
		const tabId = currentTabId || 'default';

		// Clean up conversation session for this tab
		const session = conversationSessionsMap.current.get(tabId);
		if (session) {
			endInlineWizardConversation(session).catch(() => {
				// Ignore cleanup errors during reset
			});
			conversationSessionsMap.current.delete(tabId);
		}

		// Clean up previous UI state ref for this tab
		previousUIStateRefsMap.current.delete(tabId);

		// Remove the wizard state for this tab
		setTabStates((prevMap) => {
			const newMap = new Map(prevMap);
			newMap.delete(tabId);
			return newMap;
		});
	}, [currentTabId]);

	/**
	 * Generate Auto Run documents based on the conversation.
	 * Uses the current tab ID to determine which wizard to update.
	 *
	 * This function:
	 * 1. Sets isGeneratingDocs to true
	 * 2. Constructs prompt using wizard-document-generation.md with conversation summary
	 * 3. Streams AI response
	 * 4. Parses document markers (---BEGIN DOCUMENT--- / ---END DOCUMENT---)
	 * 5. Saves documents via window.maestro.autorun.writeDoc()
	 * 6. Updates generatedDocuments array as each completes
	 */
	const generateDocuments = useCallback(
		async (callbacks?: DocumentGenerationCallbacks, explicitTabId?: string): Promise<void> => {
			// Use explicit tabId if provided, otherwise fall back to currentTabId
			const tabId = explicitTabId || currentTabId || 'default';
			const currentState = tabStatesRef.current.get(tabId);

			logger.info('Starting Playbook document generation', '[InlineWizard]', {
				tabId,
				agentType: currentState?.agentType,
				mode: currentState?.mode,
				conversationLength: currentState?.conversationHistory?.length || 0,
			});

			// If we're using a different tabId than currentTabId, update currentTabId
			// so that errors and state changes are visible via the hook's return values
			if (tabId !== currentTabId) {
				setCurrentTabId(tabId);
			}

			// Get the effective Auto Run folder path (stored in state from startWizard)
			const effectiveAutoRunFolderPath =
				currentState?.autoRunFolderPath ||
				(currentState?.projectPath ? getAutoRunFolderPath(currentState.projectPath) : null);

			// Validate we have the required state
			if (!currentState?.agentType || !effectiveAutoRunFolderPath) {
				const errorMsg = 'Cannot generate documents: missing agent type or Auto Run folder path';
				console.error('[useInlineWizard]', errorMsg);
				setTabState(tabId, (prev) => ({ ...prev, error: errorMsg }));
				callbacks?.onError?.(errorMsg);
				return;
			}

			// Set generating state - reset streaming content and progress
			setTabState(tabId, (prev) => ({
				...prev,
				isGeneratingDocs: true,
				generatedDocuments: [],
				error: null,
				streamingContent: '',
				generationProgress: null,
				currentDocumentIndex: 0,
			}));

			try {
				// Call the document generation service with the effective Auto Run folder path
				const result = await generateInlineDocuments({
					agentType: currentState.agentType,
					directoryPath: currentState.projectPath || effectiveAutoRunFolderPath,
					projectName: currentState.sessionName || 'Project',
					conversationHistory: currentState.conversationHistory,
					existingDocuments: currentState.existingDocuments,
					mode: currentState.mode === 'iterate' ? 'iterate' : 'new',
					goal: currentState.goal || undefined,
					autoRunFolderPath: effectiveAutoRunFolderPath,
					sessionId: currentState.sessionId || undefined,
					callbacks: {
						onStart: () => {
							console.log('[useInlineWizard] Document generation started');
							callbacks?.onStart?.();
						},
						onProgress: (message) => {
							console.log('[useInlineWizard] Progress:', message);
							// Try to extract progress info from message (e.g., "Saving 1 of 3 document(s)...")
							const progressMatch = message.match(/(\d+)\s+(?:of|\/)\s+(\d+)/);
							if (progressMatch) {
								const current = parseInt(progressMatch[1], 10);
								const total = parseInt(progressMatch[2], 10);
								setTabState(tabId, (prev) => ({
									...prev,
									generationProgress: { current, total },
								}));
							}
							callbacks?.onProgress?.(message);
						},
						onChunk: (chunk) => {
							// Parse the chunk to extract displayable text from JSON
							// (Claude outputs stream-json format with content_block_delta events)
							const displayText = extractDisplayTextFromChunk(
								chunk,
								currentState.agentType as ToolType
							);

							// Accumulate parsed streaming content for display
							if (displayText) {
								setTabState(tabId, (prev) => ({
									...prev,
									streamingContent: prev.streamingContent + displayText,
								}));
							}
							callbacks?.onChunk?.(chunk);
						},
						onDocumentComplete: (doc) => {
							console.log('[useInlineWizard] Document saved:', doc.filename);
							// Add document to the list as it completes
							// Update progress and select the newly created document
							setTabState(tabId, (prev) => {
								const newDocs = [...prev.generatedDocuments, doc];
								const newTotal = prev.generationProgress?.total || newDocs.length;
								return {
									...prev,
									generatedDocuments: newDocs,
									// Select the newly created document in the UI
									currentDocumentIndex: newDocs.length - 1,
									// Update generationProgress - this syncs to SessionWizardState UI fields
									generationProgress: {
										current: newDocs.length,
										total: newTotal,
									},
								};
							});
							callbacks?.onDocumentComplete?.(doc);
						},
						onComplete: (allDocs) => {
							console.log('[useInlineWizard] All documents complete:', allDocs.length);
							// Set final state - mark generation as complete so UI shows Continue button
							// Don't wait for the service function to return (it may be doing cleanup)
							setTabState(tabId, (prev) => ({
								...prev,
								isGeneratingDocs: false,
								generatedDocuments: allDocs,
								generationProgress: {
									current: allDocs.length,
									total: allDocs.length,
								},
							}));
							callbacks?.onComplete?.(allDocs);
						},
						onError: (error) => {
							console.error('[useInlineWizard] Generation error:', error);
							callbacks?.onError?.(error);
						},
					},
				});

				if (result.success) {
					// Update state with final documents - streaming content preserved for review
					// Also capture subfolderName and subfolderPath for tab naming after wizard completes
					const finalDocs = result.documents || [];
					setTabState(tabId, (prev) => ({
						...prev,
						isGeneratingDocs: false,
						generatedDocuments: finalDocs,
						generationProgress: {
							current: finalDocs.length,
							total: finalDocs.length,
						},
						// Store the subfolder name for tab naming (e.g., "Maestro-Marketing")
						subfolderName: result.subfolderName || null,
						// Store the full subfolder path for document loading (e.g., "/path/Auto Run Docs/Maestro-Marketing")
						subfolderPath: result.subfolderPath || null,
					}));

					logger.info(
						`Playbook generation complete - ${finalDocs.length} document(s) created`,
						'[InlineWizard]',
						{
							documentCount: finalDocs.length,
							subfolderName: result.subfolderName,
							filenames: finalDocs.map((d) => d.filename),
						}
					);
				} else {
					// Handle error - clear streaming state
					setTabState(tabId, (prev) => ({
						...prev,
						isGeneratingDocs: false,
						error: result.error || 'Document generation failed',
						streamingContent: '',
						generationProgress: null,
					}));
				}
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : 'Unknown error during document generation';
				console.error('[useInlineWizard] generateDocuments error:', error);

				// Clear streaming state on error
				setTabState(tabId, (prev) => ({
					...prev,
					isGeneratingDocs: false,
					error: errorMessage,
					streamingContent: '',
					generationProgress: null,
				}));

				callbacks?.onError?.(errorMessage);
			}
		},
		[currentTabId, setTabState]
	);

	// Compute readyToGenerate based on ready flag and confidence threshold
	const readyToGenerate = state.ready && state.confidence >= READY_CONFIDENCE_THRESHOLD;

	// NOTE: We intentionally do NOT auto-send an initial greeting anymore.
	// The user should always see the static welcome screen first and choose
	// to start the conversation by typing their first message.
	// This was previously auto-sending "Hello! I want to create a new Playbook."
	// which was confusing when users expected to see the welcome screen.

	return {
		// Convenience accessors (for current/active tab)
		isWizardActive: state.isActive,
		isInitializing: state.isInitializing,
		isWaiting: state.isWaiting,
		wizardMode: state.mode,
		wizardGoal: state.goal,
		confidence: state.confidence,
		ready: state.ready,
		readyToGenerate,
		conversationHistory: state.conversationHistory,
		isGeneratingDocs: state.isGeneratingDocs,
		generatedDocuments: state.generatedDocuments,
		existingDocuments: state.existingDocuments,
		error: state.error,
		streamingContent: state.streamingContent,
		generationProgress: state.generationProgress,
		wizardTabId: state.tabId,
		agentSessionId: state.agentSessionId,

		// Full state (for current/active tab)
		state,

		// Per-tab state accessors
		getStateForTab,
		isWizardActiveForTab,

		// Actions
		startWizard,
		endWizard,
		sendMessage,
		setConfidence,
		setMode,
		setGoal,
		setGeneratingDocs,
		setGeneratedDocuments,
		setExistingDocuments,
		setError,
		clearError,
		retryLastMessage,
		addAssistantMessage,
		clearConversation,
		reset,
		generateDocuments,
	};
}

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

import { useState, useCallback, useRef } from 'react';
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
  /** Streaming content being generated (accumulates as AI outputs) */
  streamingContent: string;
  /** Progress tracking for document generation */
  generationProgress: GenerationProgress | null;
}

/**
 * Return type for useInlineWizard hook.
 */
export interface UseInlineWizardReturn {
  /** Whether the wizard is currently active */
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
  /** Full wizard state */
  state: InlineWizardState;
  /**
   * Start the wizard with intent parsing flow.
   * @param naturalLanguageInput - Optional input from `/wizard <text>` command
   * @param currentUIState - Current UI state to restore when wizard ends
   * @param projectPath - Project path to check for existing Auto Run documents
   * @param agentType - The AI agent type to use for conversation
   * @param sessionName - The session name (used as project name)
   */
  startWizard: (
    naturalLanguageInput?: string,
    currentUIState?: PreviousUIState,
    projectPath?: string,
    agentType?: ToolType,
    sessionName?: string
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
   */
  generateDocuments: (callbacks?: DocumentGenerationCallbacks) => Promise<void>;
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
  streamingContent: '',
  generationProgress: null,
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
  const [state, setState] = useState<InlineWizardState>(initialState);

  // Use ref to hold the previous UI state for restoration
  const previousUIStateRef = useRef<PreviousUIState | null>(null);

  // Use ref to hold the conversation session (persists across re-renders)
  const conversationSessionRef = useRef<InlineWizardConversationSession | null>(null);

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
      sessionName?: string
    ): Promise<void> => {
      // Store current UI state for later restoration
      if (currentUIState) {
        previousUIStateRef.current = currentUIState;
      }

      // Set initializing state immediately
      setState((prev) => ({
        ...prev,
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
      }));

      try {
        // Step 1: Check for existing Auto Run documents
        const hasExistingDocs = projectPath
          ? await hasExistingAutoRunDocs(projectPath)
          : false;

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
        if (mode === 'iterate' && projectPath) {
          existingDocs = await getExistingAutoRunDocs(projectPath);
          const autoRunFolderPath = getAutoRunFolderPath(projectPath);
          docsWithContent = await loadDocumentContents(existingDocs, autoRunFolderPath);
        }

        // Step 4: Initialize conversation session (only for 'new' or 'iterate' modes)
        if ((mode === 'new' || mode === 'iterate') && agentType && projectPath) {
          const autoRunFolderPath = getAutoRunFolderPath(projectPath);
          const session = startInlineWizardConversation({
            mode,
            agentType,
            directoryPath: projectPath,
            projectName: sessionName || 'Project',
            goal: goal || undefined,
            existingDocs: docsWithContent.length > 0 ? docsWithContent : undefined,
            autoRunFolderPath,
          });

          conversationSessionRef.current = session;
          console.log('[useInlineWizard] Conversation session started:', session.sessionId);
        }

        // Update state with parsed results
        setState((prev) => ({
          ...prev,
          isInitializing: false,
          mode,
          goal,
          existingDocuments: existingDocs,
        }));
      } catch (error) {
        // Handle any errors during initialization
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to initialize wizard';
        console.error('[useInlineWizard] startWizard error:', error);

        setState((prev) => ({
          ...prev,
          isInitializing: false,
          mode: 'new', // Default to new mode on error
          error: errorMessage,
        }));
      }
    },
    [loadDocumentContents]
  );

  /**
   * End the wizard and return the previous UI state for restoration.
   */
  const endWizard = useCallback(async (): Promise<PreviousUIState | null> => {
    const previousState = previousUIStateRef.current;
    previousUIStateRef.current = null;

    // Clean up conversation session
    if (conversationSessionRef.current) {
      try {
        await endInlineWizardConversation(conversationSessionRef.current);
        console.log('[useInlineWizard] Conversation session ended');
      } catch (error) {
        console.warn('[useInlineWizard] Failed to end conversation session:', error);
      }
      conversationSessionRef.current = null;
    }

    setState(initialState);

    return previousState;
  }, []);

  /**
   * Send a user message to the wizard conversation.
   * Adds the message to history, calls the AI service, and updates state with response.
   */
  const sendMessage = useCallback(
    async (content: string, callbacks?: ConversationCallbacks): Promise<void> => {
      // Create user message
      const userMessage: InlineWizardMessage = {
        id: generateMessageId(),
        role: 'user',
        content,
        timestamp: Date.now(),
      };

      // Add user message to history, track it for retry, and set waiting state
      setState((prev) => ({
        ...prev,
        conversationHistory: [...prev.conversationHistory, userMessage],
        lastUserMessageContent: content,
        isWaiting: true,
        error: null,
      }));

      // Check if we have an active conversation session
      const session = conversationSessionRef.current;
      if (!session) {
        console.error('[useInlineWizard] No active conversation session');
        setState((prev) => ({
          ...prev,
          isWaiting: false,
          error: 'No active conversation session. Please restart the wizard.',
        }));
        callbacks?.onError?.('No active conversation session');
        return;
      }

      try {
        // Get current conversation history (excluding the message we just added)
        const currentHistory = state.conversationHistory;

        // Call the AI service
        const result = await sendWizardMessage(
          session,
          content,
          currentHistory,
          callbacks
        );

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

          // Update state with response
          setState((prev) => ({
            ...prev,
            conversationHistory: [...prev.conversationHistory, assistantMessage],
            confidence: result.response!.confidence,
            ready: result.response!.ready,
            isWaiting: false,
          }));

          console.log(
            `[useInlineWizard] Response received - confidence: ${result.response.confidence}, ready: ${result.response.ready}`
          );
        } else {
          // Handle error response
          const errorMessage = result.error || 'Failed to get response from AI';
          console.error('[useInlineWizard] sendWizardMessage error:', errorMessage);

          setState((prev) => ({
            ...prev,
            isWaiting: false,
            error: errorMessage,
          }));

          callbacks?.onError?.(errorMessage);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error occurred';
        console.error('[useInlineWizard] sendMessage error:', error);

        setState((prev) => ({
          ...prev,
          isWaiting: false,
          error: errorMessage,
        }));

        callbacks?.onError?.(errorMessage);
      }
    },
    [state.conversationHistory]
  );

  /**
   * Add an assistant response to the conversation.
   */
  const addAssistantMessage = useCallback(
    (content: string, confidence?: number, ready?: boolean) => {
      const message: InlineWizardMessage = {
        id: generateMessageId(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
        confidence,
        ready,
      };

      setState((prev) => ({
        ...prev,
        conversationHistory: [...prev.conversationHistory, message],
        // Update confidence and ready if provided
        confidence: confidence !== undefined ? confidence : prev.confidence,
        ready: ready !== undefined ? ready : prev.ready,
      }));
    },
    []
  );

  /**
   * Set the confidence level.
   */
  const setConfidence = useCallback((value: number) => {
    setState((prev) => ({
      ...prev,
      confidence: Math.max(0, Math.min(100, value)),
    }));
  }, []);

  /**
   * Set the wizard mode.
   */
  const setMode = useCallback((mode: InlineWizardMode) => {
    setState((prev) => ({
      ...prev,
      mode,
    }));
  }, []);

  /**
   * Set the goal for iterate mode.
   */
  const setGoal = useCallback((goal: string | null) => {
    setState((prev) => ({
      ...prev,
      goal,
    }));
  }, []);

  /**
   * Set whether documents are being generated.
   */
  const setGeneratingDocs = useCallback((generating: boolean) => {
    setState((prev) => ({
      ...prev,
      isGeneratingDocs: generating,
    }));
  }, []);

  /**
   * Set generated documents.
   */
  const setGeneratedDocuments = useCallback((docs: InlineGeneratedDocument[]) => {
    setState((prev) => ({
      ...prev,
      generatedDocuments: docs,
      isGeneratingDocs: false,
    }));
  }, []);

  /**
   * Set existing documents (for iterate mode context).
   */
  const setExistingDocuments = useCallback((docs: ExistingDocument[]) => {
    setState((prev) => ({
      ...prev,
      existingDocuments: docs,
    }));
  }, []);

  /**
   * Set error message.
   */
  const setError = useCallback((error: string | null) => {
    setState((prev) => ({
      ...prev,
      error,
    }));
  }, []);

  /**
   * Clear the current error.
   */
  const clearError = useCallback(() => {
    setState((prev) => ({
      ...prev,
      error: null,
    }));
  }, []);

  /**
   * Retry sending the last user message that failed.
   * Removes the failed user message from history and re-sends it.
   */
  const retryLastMessage = useCallback(
    async (callbacks?: ConversationCallbacks): Promise<void> => {
      const lastContent = state.lastUserMessageContent;

      // Only retry if we have a last message and there's an error
      if (!lastContent || !state.error) {
        console.warn('[useInlineWizard] Cannot retry: no last message or no error');
        return;
      }

      // Remove the last user message from history (it failed, so we'll re-add it)
      // Find the last user message in history
      const historyWithoutLastUser = [...state.conversationHistory];
      for (let i = historyWithoutLastUser.length - 1; i >= 0; i--) {
        if (historyWithoutLastUser[i].role === 'user') {
          historyWithoutLastUser.splice(i, 1);
          break;
        }
      }

      // Clear error and update history
      setState((prev) => ({
        ...prev,
        conversationHistory: historyWithoutLastUser,
        error: null,
      }));

      // Re-send the message
      await sendMessage(lastContent, callbacks);
    },
    [state.lastUserMessageContent, state.error, state.conversationHistory, sendMessage]
  );

  /**
   * Clear conversation history.
   */
  const clearConversation = useCallback(() => {
    setState((prev) => ({
      ...prev,
      conversationHistory: [],
    }));
  }, []);

  /**
   * Reset the wizard to initial state.
   */
  const reset = useCallback(() => {
    // Clean up conversation session
    if (conversationSessionRef.current) {
      endInlineWizardConversation(conversationSessionRef.current).catch(() => {
        // Ignore cleanup errors during reset
      });
      conversationSessionRef.current = null;
    }
    previousUIStateRef.current = null;
    setState(initialState);
  }, []);

  /**
   * Generate Auto Run documents based on the conversation.
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
    async (callbacks?: DocumentGenerationCallbacks): Promise<void> => {
      // Validate we have the required state
      if (!state.agentType || !state.projectPath) {
        const errorMsg = 'Cannot generate documents: missing agent type or project path';
        console.error('[useInlineWizard]', errorMsg);
        setState((prev) => ({ ...prev, error: errorMsg }));
        callbacks?.onError?.(errorMsg);
        return;
      }

      // Set generating state - reset streaming content and progress
      setState((prev) => ({
        ...prev,
        isGeneratingDocs: true,
        generatedDocuments: [],
        error: null,
        streamingContent: '',
        generationProgress: null,
      }));

      try {
        // Get the Auto Run folder path
        const autoRunFolderPath = getAutoRunFolderPath(state.projectPath);

        // Call the document generation service
        const result = await generateInlineDocuments({
          agentType: state.agentType,
          directoryPath: state.projectPath,
          projectName: state.sessionName || 'Project',
          conversationHistory: state.conversationHistory,
          existingDocuments: state.existingDocuments,
          mode: state.mode === 'iterate' ? 'iterate' : 'new',
          goal: state.goal || undefined,
          autoRunFolderPath,
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
                setState((prev) => ({
                  ...prev,
                  generationProgress: {
                    current: parseInt(progressMatch[1], 10),
                    total: parseInt(progressMatch[2], 10),
                  },
                }));
              }
              callbacks?.onProgress?.(message);
            },
            onChunk: (chunk) => {
              // Accumulate streaming content for display
              setState((prev) => ({
                ...prev,
                streamingContent: prev.streamingContent + chunk,
              }));
              callbacks?.onChunk?.(chunk);
            },
            onDocumentComplete: (doc) => {
              console.log('[useInlineWizard] Document saved:', doc.filename);
              // Add document to the list as it completes
              // Update progress to show completion of this document
              setState((prev) => {
                const newDocs = [...prev.generatedDocuments, doc];
                return {
                  ...prev,
                  generatedDocuments: newDocs,
                  generationProgress: prev.generationProgress
                    ? { ...prev.generationProgress, current: newDocs.length }
                    : { current: newDocs.length, total: newDocs.length },
                };
              });
              callbacks?.onDocumentComplete?.(doc);
            },
            onComplete: (allDocs) => {
              console.log('[useInlineWizard] All documents complete:', allDocs.length);
              // Set final progress state
              setState((prev) => ({
                ...prev,
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
          const finalDocs = result.documents || [];
          setState((prev) => ({
            ...prev,
            isGeneratingDocs: false,
            generatedDocuments: finalDocs,
            generationProgress: {
              current: finalDocs.length,
              total: finalDocs.length,
            },
          }));
        } else {
          // Handle error - clear streaming state
          setState((prev) => ({
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
        setState((prev) => ({
          ...prev,
          isGeneratingDocs: false,
          error: errorMessage,
          streamingContent: '',
          generationProgress: null,
        }));

        callbacks?.onError?.(errorMessage);
      }
    },
    [
      state.agentType,
      state.projectPath,
      state.sessionName,
      state.conversationHistory,
      state.existingDocuments,
      state.mode,
      state.goal,
    ]
  );

  // Compute readyToGenerate based on ready flag and confidence threshold
  const readyToGenerate = state.ready && state.confidence >= READY_CONFIDENCE_THRESHOLD;

  return {
    // Convenience accessors
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

    // Full state
    state,

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

/**
 * Centralized prompt initialization for renderer process
 *
 * Loads all prompts via IPC once at app startup. Call this early in App.tsx
 * before any components that need prompts are rendered.
 *
 * Also provides refreshRendererPrompts() for the Settings UI to call
 * after save/reset, so edits take effect immediately without restart.
 */

import { captureException } from '../utils/sentry';

// Stores
import { loadSettingsStorePrompts } from '../stores/settingsStore';

// Hooks
import { loadInputProcessingPrompts } from '../hooks/input/useInputProcessing';
import { loadWizardHandlersPrompts } from '../hooks/wizard/useWizardHandlers';
import { loadAgentListenersPrompts } from '../hooks/agent/useAgentListeners';
import { loadBatchUtilsPrompts } from '../hooks/batch/batchUtils';

// Services
import { loadContextGroomerPrompts } from './contextGroomer';
import { loadContextSummarizerPrompts } from './contextSummarizer';
import { loadInlineWizardConversationPrompts } from './inlineWizardConversation';
import { loadInlineWizardDocGenPrompts } from './inlineWizardDocumentGeneration';
import { loadWizardPrompts } from '../components/Wizard/services/wizardPrompts';
import { loadPhaseGeneratorPrompts } from '../components/Wizard/services/phaseGenerator';

let initialized = false;
let initPromise: Promise<void> | null = null;

async function loadAll(force = false): Promise<void> {
	await Promise.all([
		// Stores
		loadSettingsStorePrompts(force),
		// Hooks
		loadInputProcessingPrompts(force),
		loadWizardHandlersPrompts(force),
		loadAgentListenersPrompts(force),
		loadBatchUtilsPrompts(force),
		// Services
		loadContextGroomerPrompts(force),
		loadContextSummarizerPrompts(force),
		loadInlineWizardConversationPrompts(force),
		loadInlineWizardDocGenPrompts(force),
		loadWizardPrompts(force),
		loadPhaseGeneratorPrompts(force),
	]);
}

/**
 * Initialize all renderer prompts. Safe to call multiple times (idempotent).
 * Must complete before the app renders components that use prompts.
 */
export async function initializeRendererPrompts(): Promise<void> {
	// If already initialized, return immediately
	if (initialized) return;

	// If initialization is in progress, wait for it
	if (initPromise) return initPromise;

	// Start initialization
	initPromise = (async () => {
		try {
			await loadAll();
			initialized = true;
		} catch (error) {
			// Clear the promise so a subsequent call can retry instead of
			// returning the same rejected promise forever
			initPromise = null;
			captureException(error instanceof Error ? error : new Error(String(error)), {
				extra: { context: 'initializeRendererPrompts' },
			});
			throw error;
		}
	})();

	return initPromise;
}

/**
 * Refresh all renderer prompt caches. Call after saving or resetting
 * a prompt via the Settings UI so the new content takes effect
 * immediately in all renderer consumers.
 */
export async function refreshRendererPrompts(): Promise<void> {
	await loadAll(true);
}

/**
 * Check if renderer prompts have been initialized.
 */
export function areRendererPromptsInitialized(): boolean {
	return initialized;
}

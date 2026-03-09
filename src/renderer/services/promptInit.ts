// ABOUTME: Centralized prompt initialization for renderer process.
// ABOUTME: Loads all prompts via IPC once at app startup before components need them.

import { loadInputProcessingPrompts } from '../hooks/input/useInputProcessing';
import { loadContextGroomerPrompts } from './contextGroomer';
import { loadContextSummarizerPrompts } from './contextSummarizer';
import { loadWizardPrompts } from '../components/Wizard/services/wizardPrompts';
import { loadPhaseGeneratorPrompts } from '../components/Wizard/services/phaseGenerator';
import { loadSettingsStorePrompts } from '../stores/settingsStore';
import { loadInlineWizardConversationPrompts } from './inlineWizardConversation';
import { loadInlineWizardDocGenPrompts } from './inlineWizardDocumentGeneration';
import { loadBatchPrompts } from '../hooks/batch/batchUtils';

let initialized = false;
let initPromise: Promise<void> | null = null;

/**
 * Initialize all renderer prompts. Safe to call multiple times (idempotent).
 */
export async function initializeRendererPrompts(): Promise<void> {
	// If already initialized, return immediately
	if (initialized) return;

	// If initialization is in progress, wait for it
	if (initPromise) return initPromise;

	// Start initialization
	initPromise = (async () => {
		console.log('[PromptInit] Loading renderer prompts...');

		try {
			await Promise.all([
				loadInputProcessingPrompts(),
				loadContextGroomerPrompts(),
				loadContextSummarizerPrompts(),
				loadWizardPrompts(),
				loadPhaseGeneratorPrompts(),
				loadSettingsStorePrompts(),
				loadInlineWizardConversationPrompts(),
				loadInlineWizardDocGenPrompts(),
				loadBatchPrompts(),
			]);

			initialized = true;
			console.log('[PromptInit] Renderer prompts loaded successfully');
		} catch (error) {
			console.error('[PromptInit] Failed to load renderer prompts:', error);
			throw error;
		}
	})();

	return initPromise;
}

/**
 * Check if renderer prompts have been initialized.
 */
export function areRendererPromptsInitialized(): boolean {
	return initialized;
}

/**
 * Core Prompts Module
 *
 * Prompts are loaded from disk at runtime via the prompt-manager.
 * This file re-exports shared definitions for convenience.
 * The single source of truth is src/shared/promptDefinitions.ts.
 */

export {
	CORE_PROMPTS,
	PROMPT_IDS,
	getPromptFilename,
	type PromptDefinition,
	type PromptId,
} from '../shared/promptDefinitions';

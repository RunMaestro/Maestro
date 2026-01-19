/**
 * Centralized prompts module
 *
 * All prompts are stored as .md files in this directory and compiled
 * to TypeScript at build time by scripts/generate-prompts.mjs.
 *
 * The generated file is at src/generated/prompts.ts
 */

export {
	// Wizard
	wizardSystemPrompt,
	wizardSystemContinuationPrompt,
	wizardDocumentGenerationPrompt,

	// Inline Wizard
	wizardInlineSystemPrompt,
	wizardInlineIteratePrompt,
	wizardInlineNewPrompt,
	wizardInlineIterateGenerationPrompt,

	// AutoRun
	autorunDefaultPrompt,
	autorunSynopsisPrompt,

	// Input processing
	imageOnlyDefaultPrompt,

	// Commands
	commitCommandPrompt,

	// Maestro system prompt
	maestroSystemPrompt,

	// Group chat prompts
	groupChatModeratorSystemPrompt,
	groupChatModeratorSynthesisPrompt,
	groupChatParticipantPrompt,
	groupChatParticipantRequestPrompt,

	// Context management
	contextGroomingPrompt,
	contextTransferPrompt,
	contextSummarizePrompt,
} from '../generated/prompts';

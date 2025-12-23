/**
 * Centralized prompts module
 *
 * All built-in prompts are stored as .md files in this directory
 * and imported at build time using Vite's ?raw suffix.
 */

// Wizard prompts
import wizardSystemPrompt from './wizard-system.md?raw';
import wizardSystemContinuationPrompt from './wizard-system-continuation.md?raw';
import wizardDocumentGenerationPrompt from './wizard-document-generation.md?raw';

// AutoRun prompts
import autorunDefaultPrompt from './autorun-default.md?raw';
import autorunSynopsisPrompt from './autorun-synopsis.md?raw';

// Input processing prompts
import imageOnlyDefaultPrompt from './image-only-default.md?raw';

// Built-in command prompts
import commitCommandPrompt from './commit-command.md?raw';

// Maestro system prompt (injected at agent startup)
import maestroSystemPrompt from './maestro-system-prompt.md?raw';

export {
  // Wizard
  wizardSystemPrompt,
  wizardSystemContinuationPrompt,
  wizardDocumentGenerationPrompt,

  // AutoRun
  autorunDefaultPrompt,
  autorunSynopsisPrompt,

  // Input processing
  imageOnlyDefaultPrompt,

  // Commands
  commitCommandPrompt,

  // Maestro system prompt
  maestroSystemPrompt,
};

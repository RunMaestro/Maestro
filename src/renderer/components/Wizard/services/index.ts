/**
 * Wizard Services
 *
 * Business logic and utilities for the onboarding wizard.
 */

export { wizardPrompts, parseStructuredOutput } from './wizardPrompts';
export {
	conversationManager,
	createUserMessage,
	createAssistantMessage,
	shouldAutoProceed,
	convertWizardMessagesToLogEntries,
	createProjectDiscoveryLogs,
	PROJECT_DISCOVERY_TAB_NAME,
} from './conversationManager';

export {
	phaseGenerator,
	phaseGeneratorUtils,
	type GenerationConfig,
	type GenerationResult,
	type GenerationCallbacks,
} from './phaseGenerator';

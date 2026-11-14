/** Node translation API. Renderer clients import types/session/support directly, never this barrel. */
export * from './types';
export type { TranslationFs, TranslationFsStat, TranslationFsWriteOptions } from './fs-port';
export { localTranslationFs } from './local-fs';
export { limitationsNeedingAcceptance, translationWarningsAccepted } from './limitations';
export {
	prepareTabForSend,
	pendingTranslationSource,
	TranslationSendHeldError,
	type TranslationSendHost,
} from './send';
export {
	NativeTranslationService,
	type TranslationServiceHost,
	type TranslationServiceSession,
} from './service';
export {
	TRANSLATION_DIRECTIONS,
	TRANSLATION_PROVIDER_VERSIONS,
	getDeclaredTranslationDirection,
	translationVersionLimitation,
} from './support';
export { TranslationRegistry, planTranslation, planTabTranslation } from './registry';
export {
	createTranslationRegistry,
	claudeTranslationAdapter,
	codexTranslationAdapter,
	projectConversation,
} from './adapters';
export { extractNativeConversation, parseNativeLines } from './native-records';
export { TranslationArchive, type TranslationJournal } from './archive';
export {
	applyTranslation,
	applyTabTranslation,
	recoverTranslation,
	verifyTranslationWrites,
	type TranslationTransactionHost,
} from './transaction';
export { reconcileConversation, reconcileResource } from './reconcile';
export {
	collectTranslationResources,
	projectResourceDefinition,
	translationKnowledgePrompt,
} from './resources';
export { planResourceProjections } from './resource-projections';
export { discoverClaudeMemoryPath, resolveClaudeMemoryPath, analyzeMemoryLinks } from './memory';
export {
	importSelectedCodexResources,
	readCodexThreadItems,
	extractCodexItemHistory,
} from './codex-import';

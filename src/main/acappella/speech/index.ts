/**
 * The speech half of A Cappella: what an agent wrote, turned into what a person
 * hears.
 *
 * The pieces compose in one direction and each is useful alone, which is why
 * they are separate modules rather than one "speech manager":
 *
 *   tap -> translator -> scheduler -> audio
 *            ^              |
 *            +-- barge-in --+   (cancels both, keeps the floor)
 *
 * `drill-down.ts` sits beside the tap holding the untranslated output, and
 * `background-announcer.ts` sits outside the turn entirely, waiting for a pause.
 */

export {
	AgentOutputTap,
	createAgentOutputTap,
	type AgentOutputChunk,
	type AgentOutputChunkKind,
	type AgentOutputSource,
	type AgentOutputTapOptions,
} from './agent-output-tap';
export {
	BackgroundAnnouncer,
	announcementText,
	createBackgroundAnnouncer,
	type BackgroundAnnouncement,
	type BackgroundAnnouncerOptions,
	type BackgroundCompletion,
} from './background-announcer';
export {
	BargeInController,
	createBargeInController,
	type BargeInControllerOptions,
	type BargeInOutcome,
	type BargeInStep,
} from './barge-in';
export {
	ConversationalTranslator,
	createConversationalTranslator,
	type ConversationalTranslatorOptions,
	type TranslationRequest,
} from './conversational-translator';
export {
	DetailBuffer,
	createDetailBuffer,
	detectDrillDownIntent,
	firstPath,
	speakPath,
	type DetailBufferOptions,
	type DrillDownIntent,
	type DrillDownResponse,
	type DrillDownTurn,
} from './drill-down';
export {
	SpeechScheduler,
	createSpeechScheduler,
	type SpeechRunEndReason,
	type SpeechRunResult,
	type SpeechSchedulerEvents,
	type SpeechSchedulerOptions,
} from './speech-scheduler';

/**
 * A Cappella renderer surfaces.
 *
 * The HUD is the only thing outside this folder should mount: it owns the event
 * subscription (one subscriber, or every event applies twice) and renders the
 * controls, the transcript, and the dev harness itself.
 */

export { VoiceHud, type VoiceHudProps } from './VoiceHud';
export { VoiceHudControls, type VoiceHudControlsProps } from './VoiceHudControls';
export { VoiceIndicator, type VoiceIndicatorProps, meterFill } from './VoiceIndicator';
export { VoiceTranscript, type VoiceTranscriptProps } from './VoiceTranscript';
export { VoiceDevHarness, type VoiceDevHarnessProps } from './VoiceDevHarness';
export { useVoiceScope, type VoiceScopeDisplay } from './useVoiceScope';
export { useVoiceSession, type VoiceSessionActions } from './useVoiceSession';

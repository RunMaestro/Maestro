/**
 * A Cappella renderer surfaces.
 *
 * The HUD is the only thing outside this folder should mount that TALKS to the
 * service: it owns the event subscription (one subscriber, or every event
 * applies twice) and renders the controls, the transcript, and the dev harness
 * itself. `VoiceStatusIndicator` is the one exception, and only reads store
 * state - it is the minimized HUD's home in the Left Bar header.
 */

export { VoiceHud, DEV_HARNESS_STORAGE_KEY, type VoiceHudProps } from './VoiceHud';
export { VoiceStatusIndicator } from './VoiceStatusIndicator';
export { VoiceHudControls, type VoiceHudControlsProps } from './VoiceHudControls';
export { VoiceIndicator, type VoiceIndicatorProps, meterFill } from './VoiceIndicator';
export { VoiceTranscript, type VoiceTranscriptProps } from './VoiceTranscript';
export { VoiceDevHarness, type VoiceDevHarnessProps } from './VoiceDevHarness';
export { useVoiceScope, type VoiceScopeDisplay } from './useVoiceScope';
export { useVoiceSession, type VoiceSessionActions } from './useVoiceSession';

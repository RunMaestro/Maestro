/**
 * A Cappella renderer surfaces.
 *
 * The HUD is the only thing outside this folder should mount: it owns the event
 * subscription (one subscriber, or every event applies twice) and renders the
 * dev harness itself.
 */

export { VoiceHud, type VoiceHudProps } from './VoiceHud';
export { VoiceDevHarness, type VoiceDevHarnessProps } from './VoiceDevHarness';
export { useVoiceSession, type VoiceSessionActions } from './useVoiceSession';

/**
 * A Cappella audio host - the renderer half of the audio pipeline.
 *
 * Loaded only by the hidden `?acappellaAudio` window. See
 * `src/main/acappella/audio-host-window.ts` for why it exists and
 * `src/shared/acappella/audio-host.ts` for the wire contract.
 */

export { AudioHostRoot, createAudioHostController } from './AudioHostRoot';
export type { AudioHostController, CreateAudioHostControllerOptions } from './AudioHostRoot';
export { createAudioHostBridge } from './bridge';
export type { AudioHostBridge } from './bridge';
export { classifyCaptureError, MicCapture, ACAPPELLA_MIC_CONSTRAINTS } from './capture';
export type { MicCaptureOptions } from './capture';
export { pcm16ToFloat32, TtsPlayback } from './playback';
export type { PlaybackChunk, TtsPlaybackOptions } from './playback';

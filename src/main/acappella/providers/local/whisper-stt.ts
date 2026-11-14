/**
 * Local speech-to-text on Whisper, running on ONNX Runtime.
 *
 * Selectable, but no longer the local default: Parakeet (`parakeet-stt.ts`) is,
 * because Whisper Base mangles names and casing on exactly the short dictated
 * commands this feature exists for. Whisper stays for anyone who already
 * downloaded it or wants the smaller model.
 *
 * The streaming policy (cadence, stability, endpointing, silence) is shared with
 * every local recogniser and lives in `chunked-stt.ts`. The inference is the
 * core's (`src/main/local-models/stt/whisper/engine.ts`), leased from the shared
 * speech-to-text pool. This file only binds the two to the catalog model.
 */

import { WHISPER_BASE_EN_ID } from '../../../../shared/local-models/model-catalog';
import { WHISPER_STT_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { WHISPER_MAX_SAMPLES } from '../../../local-models/stt/whisper/engine';
import { ChunkedLocalSttProvider } from './chunked-stt';

// Re-exported so existing importers keep their one import site.
export { sanitizeTranscript } from './chunked-stt';

export class WhisperSttProvider extends ChunkedLocalSttProvider {
	readonly id = WHISPER_STT_PROVIDER_ID;
	readonly label = 'Whisper (local)';
	protected readonly engineName = 'Whisper';
	protected readonly modelId = WHISPER_BASE_EN_ID;
	// One encoder pass covers a fixed 30 s window.
	protected readonly maxSamples = WHISPER_MAX_SAMPLES;
}

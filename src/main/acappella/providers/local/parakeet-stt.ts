/**
 * Local speech-to-text on Parakeet TDT, running on ONNX Runtime. The local
 * default.
 *
 * The streaming policy (cadence, stability, endpointing, silence) is shared with
 * every local recogniser and lives in `chunked-stt.ts`. The inference is the
 * core's (`src/main/local-models/stt/parakeet/engine.ts`), leased from the
 * shared speech-to-text pool. This file only binds the two to the catalog model.
 */

import { PARAKEET_TDT_V2_ID } from '../../../../shared/local-models/model-catalog';
import { LOCAL_STT_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { PARAKEET_MAX_SAMPLES } from '../../../local-models/stt/parakeet/engine';
import { ChunkedLocalSttProvider } from './chunked-stt';

export class ParakeetSttProvider extends ChunkedLocalSttProvider {
	readonly id = LOCAL_STT_PROVIDER_ID;
	readonly label = 'Parakeet (local)';
	protected readonly engineName = 'Parakeet';
	protected readonly modelId = PARAKEET_TDT_V2_ID;
	protected readonly maxSamples = PARAKEET_MAX_SAMPLES;
}

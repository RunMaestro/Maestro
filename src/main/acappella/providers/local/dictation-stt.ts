/** Live streaming policy over exactly the same core Dictation assignment as file clips. */
import { DICTATION_STT_PROVIDER_ID } from '../../../../shared/acappella/provider-catalog';
import { resolveLocalClipTranscriber } from '../../../local-models/dictation';
import { LocalModelError } from '../../../local-models/errors';
import { WHISPER_MAX_SAMPLES } from '../../../local-models/stt/whisper/engine';
import { ChunkedLocalSttProvider, type ChunkedLocalSttOptions } from './chunked-stt';

export class DictationSttProvider extends ChunkedLocalSttProvider {
	readonly id = DICTATION_STT_PROVIDER_ID;
	readonly label = 'Local Models Dictation';
	protected readonly engineName = 'Dictation';
	// Production always resolves the explicit core source below; there is no default model.
	protected readonly modelId = '';
	protected readonly maxSamples = WHISPER_MAX_SAMPLES;
	constructor(options: Omit<ChunkedLocalSttOptions, 'resolveSource'> = {}) {
		super({
			...options,
			resolveSource: async () => {
				const snapshot = await resolveLocalClipTranscriber();
				if (snapshot.reason || !snapshot.modelId)
					throw new LocalModelError('Local Dictation is unavailable.', {
						code: 'model-unsupported',
						consumerId: DICTATION_STT_PROVIDER_ID,
						recovery:
							'Choose a compatible local Dictation model and language in Settings > Models > System One.',
					});
				return { modelId: snapshot.modelId, language: snapshot.language };
			},
		});
	}
}

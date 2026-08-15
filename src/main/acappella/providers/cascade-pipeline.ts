/**
 * The cascade pipeline: three independent engines, speech to text to speech.
 *
 * One of exactly two `VoicePipeline` implementations, and the DEFAULT one,
 * because it is the only shape that a fully local install or an ElevenLabs voice
 * can take. Realtime is a latency optimisation available to one provider; this is
 * the pipeline the feature is actually built on.
 *
 * It is a thin wrapper by design. All the interesting decisions - which provider
 * fills which slot, and what happens when one is unavailable - belong to the
 * registry; all this adds is the lifetime. That lifetime is the reason the class
 * exists at all: a Whisper model, an ONNX session, and a llama.cpp context are
 * each hundreds of megabytes, and a hot-swap that dropped the reference without
 * calling `dispose()` would leak every one of them for the life of the process.
 */

import type { VoicePipeline, VoiceProviderTrio } from '../../../shared/acappella/providers';

/** A provider that holds something worth releasing. Duck-typed on purpose. */
interface Disposable {
	dispose?: () => Promise<void> | void;
	/** The local Brain's name for the same thing. */
	unload?: () => Promise<void> | void;
	/** Every STT provider has this, and it is the right teardown for one. */
	stop?: () => Promise<void> | void;
	/** Every TTS provider has this: stop speaking before going away. */
	cancel?: () => void;
}

export class CascadePipeline implements VoicePipeline {
	readonly shape = 'cascade' as const;

	constructor(readonly providers: VoiceProviderTrio) {}

	/**
	 * Release all three slots.
	 *
	 * Every teardown is attempted even when an earlier one throws: a provider that
	 * fails to close is not a reason to leak the other two, and the swap that
	 * called this has already decided the pipeline is going away.
	 */
	async dispose(): Promise<void> {
		// TTS first: it is the one that might still be making noise, and the user
		// should stop hearing the old voice before anything else is torn down.
		await release(this.providers.tts);
		await release(this.providers.stt);
		await release(this.providers.brain);
	}
}

async function release(provider: unknown): Promise<void> {
	const target = provider as Disposable;
	try {
		target.cancel?.();
		await target.stop?.();
		await target.unload?.();
		await target.dispose?.();
	} catch {
		// Best effort. Teardown runs from a swap and from app quit, and neither has
		// anywhere useful to send a failure to close a model file.
	}
}

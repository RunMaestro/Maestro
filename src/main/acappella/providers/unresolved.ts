/**
 * The provider a slot gets when the one it was configured with cannot be built.
 *
 * There is no fallback engine in A Cappella. Not to the cloud (that spends the
 * user's money and ships their microphone somewhere they did not choose), and not
 * to the mock either (a "working" session that transcribes nothing and speaks
 * nothing is indistinguishable from a broken feature, and it hides the reason).
 * A slot whose provider is unknown or unbuildable therefore resolves to one of
 * these: an object that satisfies the interface and refuses, by name, the first
 * time anything asks it to work.
 *
 * The refusal is a classified `VoiceProviderError`, so the session service turns
 * it into a `session-error` with the provider id attached rather than a crash,
 * and the HUD can say which slot is broken and what was asked for.
 */

import { ACAPPELLA_AUDIO_SAMPLE_RATE } from '../../../shared/acappella/audio-host';
import { VoiceProviderError } from '../../../shared/acappella/provider-errors';
import type {
	BrainProvider,
	SttCallbacks,
	SttProvider,
	TtsChunk,
	TtsProvider,
	TtsSpeakOptions,
	VoiceProviderRole,
	VoiceProviderTier,
} from '../../../shared/acappella/providers';
import type { RouteDecision } from '../../../shared/acappella/route-decision';

/** Why a slot could not be built. */
export type UnresolvedReason = 'unknown-provider' | 'unavailable';

const ROLE_LABELS: Record<VoiceProviderRole, string> = {
	stt: 'Speech-to-Text',
	tts: 'Text-to-Speech',
	brain: 'Conductor Brain',
};

/** The id an unresolved slot reports. Distinct per role so a log names the slot. */
export function unresolvedProviderId(role: VoiceProviderRole): string {
	return `unresolved-${role}`;
}

export function unresolvedMessage(
	role: VoiceProviderRole,
	requestedId: string,
	reason: UnresolvedReason
): string {
	const label = ROLE_LABELS[role];
	return reason === 'unknown-provider'
		? `${label}: '${requestedId}' is not a provider Maestro knows about. Pick one in Settings > Plugins > A Cappella > Voice Providers.`
		: `${label}: '${requestedId}' cannot run in this build. Pick another in Settings > Plugins > A Cappella > Voice Providers.`;
}

/** Shared identity for the three refusing providers. */
abstract class UnresolvedProvider {
	readonly id: string;
	readonly label: string;
	readonly tier: VoiceProviderTier;

	constructor(
		protected readonly role: VoiceProviderRole,
		protected readonly requestedId: string,
		protected readonly reason: UnresolvedReason
	) {
		this.id = unresolvedProviderId(role);
		this.label = `Unavailable (${requestedId})`;
		// Its own tier, never the tier of what was asked for and never `mock`: this
		// slot does not run anything, and a client that renders tiers has to be able
		// to say "nothing is filling this" rather than "the mock is".
		this.tier = 'unresolved';
	}

	protected refuse(): VoiceProviderError {
		return new VoiceProviderError(unresolvedMessage(this.role, this.requestedId, this.reason), {
			kind: 'unavailable',
			providerId: this.requestedId,
		});
	}
}

export class UnresolvedSttProvider extends UnresolvedProvider implements SttProvider {
	readonly sampleRate = ACAPPELLA_AUDIO_SAMPLE_RATE;
	/** False, so no microphone is opened for a recogniser that will never run. */
	readonly acceptsAudio = false;

	constructor(requestedId: string, reason: UnresolvedReason) {
		super('stt', requestedId, reason);
	}

	async start(_callbacks: SttCallbacks): Promise<void> {
		// Thrown from `start()` rather than reported through the callbacks: the
		// session service refuses to open the floor at all, which is the correct
		// outcome for a recogniser that cannot exist.
		throw this.refuse();
	}

	feed(_pcm: Int16Array): void {}

	async flush(): Promise<void> {}

	async stop(): Promise<void> {}
}

export class UnresolvedTtsProvider extends UnresolvedProvider implements TtsProvider {
	constructor(requestedId: string, reason: UnresolvedReason) {
		super('tts', requestedId, reason);
	}

	speak(_text: string, _options: TtsSpeakOptions): AsyncIterable<TtsChunk> {
		const error = this.refuse();
		// Hand-rolled rather than an async generator: a generator whose body only
		// throws has no `yield` in it, which is a lint error and a fair one. The
		// refusal has to arrive on the FIRST `next()`, which is what the session
		// service awaits.
		return {
			[Symbol.asyncIterator]: () => ({
				next: () => Promise.reject(error),
			}),
		};
	}

	cancel(): void {}
}

export class UnresolvedBrainProvider extends UnresolvedProvider implements BrainProvider {
	constructor(requestedId: string, reason: UnresolvedReason) {
		super('brain', requestedId, reason);
	}

	async route(_input: string, _context: unknown): Promise<RouteDecision> {
		throw this.refuse();
	}

	async converse(_agentText: string, _context: unknown): Promise<string> {
		throw this.refuse();
	}
}

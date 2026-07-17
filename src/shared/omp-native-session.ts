import type { AgentRuntimeFeatureState } from './agent-runtime-features';

/**
 * Composer-only delivery operations supported by the pinned first-party OMP RPC
 * process while an active turn is running.
 */
export type OmpDeliveryIntent = 'steer' | 'follow_up' | 'abort_and_prompt';
export type OmpTurnLifecyclePhase = 'turn_end' | 'agent_start' | 'continuation_failed';
export interface OmpTurnLifecycleEvent {
	phase: OmpTurnLifecyclePhase;
	continuation?: boolean;
	deliveryIntent?: 'follow_up' | 'abort_and_prompt';
	deliveryId?: string;
}
export interface OmpNativeTurnCompletion {
	readonly kind: 'omp-native-turn';
}

export const OMP_NATIVE_TURN_COMPLETION: OmpNativeTurnCompletion = Object.freeze({
	kind: 'omp-native-turn',
});

export function isOmpNativeTurnCompletion(value: unknown): value is OmpNativeTurnCompletion {
	return (
		typeof value === 'object' &&
		value !== null &&
		'kind' in value &&
		value.kind === OMP_NATIVE_TURN_COMPLETION.kind
	);
}

/**
 * Visible but disconnected OMP native surface for an idle/restored session.
 *
 * OMP starts its RPC process on the first message. Runtime controls are held
 * back until that adapter reports its live state, preventing dead UI actions.
 */
export function createDormantOmpRuntimeFeatures(): AgentRuntimeFeatureState {
	return {
		controls: [],
		tree: null,
		todos: null,
		subagents: null,
		stats: null,
		loginProviders: null,
		readiness: {
			state: 'dormant',
			message: 'OMP Native ready — starts on first message.',
		},
	};
}

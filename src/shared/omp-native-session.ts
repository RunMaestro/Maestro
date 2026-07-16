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

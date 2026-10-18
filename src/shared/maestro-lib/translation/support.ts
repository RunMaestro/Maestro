import type { TranslationDirection } from './types';

/** Renderer-safe declarations shared by the native adapters and provider picker. */
export const TRANSLATION_PROVIDER_VERSIONS = {
	'claude-code': ['2.1.296', '2.1.302'],
	codex: ['0.162.1', '0.163.0'],
} as const;

export const TRANSLATION_DIRECTIONS: readonly TranslationDirection[] = [
	{
		source: 'claude-code',
		destination: 'codex',
		sourceVersions: TRANSLATION_PROVIDER_VERSIONS['claude-code'],
		destinationVersions: TRANSLATION_PROVIDER_VERSIONS.codex,
		verification: 'unverified',
	},
	{
		source: 'codex',
		destination: 'claude-code',
		sourceVersions: TRANSLATION_PROVIDER_VERSIONS.codex,
		destinationVersions: TRANSLATION_PROVIDER_VERSIONS['claude-code'],
		verification: 'unverified',
	},
];

/** A discovery hint only; native preflight still checks versions, scope and payload. */
export function getDeclaredTranslationDirection(
	source: string,
	destination: string
): TranslationDirection | undefined {
	return TRANSLATION_DIRECTIONS.find(
		(direction) => direction.source === source && direction.destination === destination
	);
}

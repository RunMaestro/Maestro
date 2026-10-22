import semver from 'semver';
import type {
	TranslationDirection,
	TranslationLimitation,
	TranslationVersionSupport,
} from './types';

/** Renderer-safe declarations shared by the native adapters and provider picker. */
export const TRANSLATION_PROVIDER_VERSIONS = {
	'claude-code': { minVersion: '2.1.296', testedVersions: ['2.1.296', '2.1.302'] },
	codex: { minVersion: '0.162.1', testedVersions: ['0.162.1', '0.163.0'] },
} as const satisfies Record<string, TranslationVersionSupport>;

/** Share strict schema compatibility and test coverage rules across every entry point. */
export function translationVersionLimitation(
	provider: string,
	version: string,
	support: TranslationVersionSupport
): TranslationLimitation | undefined {
	if (!semver.valid(version) || !semver.gte(version, support.minVersion))
		return {
			code: 'unknown-version',
			severity: 'block',
			message: `${provider} ${version || 'unknown'} has no declared schema mapping; requires a valid version at or above ${support.minVersion}.`,
		};
	if (!support.testedVersions.includes(version))
		return {
			code: 'untested-version',
			severity: 'warning',
			message: `${provider} ${version} is untested; tested versions: ${support.testedVersions.join(', ')}.`,
		};
	return undefined;
}

export const TRANSLATION_DIRECTIONS: readonly TranslationDirection[] = [
	{
		source: 'claude-code',
		destination: 'codex',
		sourceMinVersion: TRANSLATION_PROVIDER_VERSIONS['claude-code'].minVersion,
		destinationMinVersion: TRANSLATION_PROVIDER_VERSIONS.codex.minVersion,
		sourceTestedVersions: TRANSLATION_PROVIDER_VERSIONS['claude-code'].testedVersions,
		destinationTestedVersions: TRANSLATION_PROVIDER_VERSIONS.codex.testedVersions,
		verification: 'unverified',
	},
	{
		source: 'codex',
		destination: 'claude-code',
		sourceMinVersion: TRANSLATION_PROVIDER_VERSIONS.codex.minVersion,
		destinationMinVersion: TRANSLATION_PROVIDER_VERSIONS['claude-code'].minVersion,
		sourceTestedVersions: TRANSLATION_PROVIDER_VERSIONS.codex.testedVersions,
		destinationTestedVersions: TRANSLATION_PROVIDER_VERSIONS['claude-code'].testedVersions,
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

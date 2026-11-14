import { canonicalJson } from '../../canonicalJson';
import type { ProviderMigrationState, TranslationPlan, TranslationLimitation } from './types';

/** Only warnings need consent; info is advisory and blocks cannot be accepted. */
export function limitationsNeedingAcceptance(
	limitations: readonly TranslationLimitation[]
): TranslationLimitation[] {
	return limitations.filter((limitation) => limitation.severity === 'warning');
}

/** Consent never carries to a different direction, CLI version or changed warning. */
export function translationWarningsAccepted(
	plan: TranslationPlan,
	state?: ProviderMigrationState
): boolean {
	const accepted = state?.acceptedDirections?.find(
		(entry) =>
			entry.source === plan.source.provider &&
			entry.destination === plan.destination.provider &&
			entry.sourceVersion === plan.source.version &&
			entry.destinationVersion === plan.destination.version
	);
	return limitationsNeedingAcceptance(plan.limitations).every((warning) =>
		accepted?.warnings.includes(canonicalJson(warning))
	);
}

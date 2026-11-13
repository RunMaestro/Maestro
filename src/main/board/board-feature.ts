import {
	isEncoreFeatureEnabled,
	requireEncoreFeature,
	type EncoreSettingsReader,
} from '../../shared/encoreFeatureDefaults';

// The desktop supplies its live settings; explicit isolated hosts supply theirs.
// Importing Board modules alone never enables a host or reads machine settings.
let settings: EncoreSettingsReader = { get: () => ({ board: false, maestroCue: false }) };

/** Bind the desktop live settings or an explicit isolated host reader. */
export function configureBoardFeatures(reader: EncoreSettingsReader): void {
	settings = reader;
}

/** Board activation requires both canonical Encore gates. */
export function isBoardEnabled(): boolean {
	return (
		isEncoreFeatureEnabled(settings, 'board') && isEncoreFeatureEnabled(settings, 'maestroCue')
	);
}

/** Entry-point admission, before source IO, opening storage or acquiring an owner. */
export function requireBoardEnabled(): void {
	requireEncoreFeature(settings, 'board', 'BoardDisabled');
	requireEncoreFeature(settings, 'maestroCue', 'CueDisabled');
}

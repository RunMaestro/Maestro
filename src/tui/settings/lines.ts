/**
 * What the settings view prints (ST-1), as plain lines. One list, built from a
 * `SettingsSnapshot`, so the view only has to window it and a test can read it
 * without drawing anything. Read-only: there is no line you can act on.
 */

import {
	ENCORE_FEATURE_LABELS,
	getAgentDisplayName,
	type EncoreFlag,
	type SettingsSnapshot,
} from '../../shared/maestro-lib';

export type SettingsLineKind = 'heading' | 'row' | 'dim' | 'warn';

export interface SettingsLine {
	/** Unique in the list; `windowRows` keys on it. */
	key: string;
	kind: SettingsLineKind;
	/** The left column of a row; empty for a heading or a note. */
	label: string;
	text: string;
}

/** The conductor profile can run to pages; the view shows the start of it. */
export const PROFILE_PREVIEW_LINES = 6;

export function settingsLines(snapshot: SettingsSnapshot): SettingsLine[] {
	const lines: SettingsLine[] = [];
	const add = (kind: SettingsLineKind, text: string, label = '') =>
		lines.push({ key: `${lines.length}`, kind, label, text });

	add(
		'heading',
		snapshot.source === 'host' ? 'Source: the desktop (live)' : 'Source: settings files on disk'
	);
	if (snapshot.note) add('warn', snapshot.note);
	for (const problem of snapshot.problems) add('warn', problem);

	add('heading', 'Provider defaults');
	add('row', snapshot.defaults.shell ?? '(not set)', 'Shell');
	add('row', snapshot.defaults.saveToHistory ? 'on' : 'off', 'Save to history');
	add('row', snapshot.defaults.thinkingMode, 'Thinking mode');
	if (snapshot.defaults.envVars.length === 0) add('row', '(none)', 'Environment');
	for (const [index, entry] of snapshot.defaults.envVars.entries()) {
		add('row', `${entry.key}=${entry.value}`, index === 0 ? 'Environment' : '');
	}

	add('heading', 'Agent configs by provider');
	if (snapshot.providers.length === 0) add('dim', 'No provider has a stored config.');
	for (const provider of snapshot.providers) {
		add('row', '', getAgentDisplayName(provider.providerId));
		if (provider.entries.length === 0) add('dim', '  (defaults)');
		for (const entry of provider.entries) add('row', entry.value, `  ${entry.key}`);
	}

	add('heading', 'SSH remotes');
	if (snapshot.sshRemotes.length === 0) add('dim', 'None configured.');
	for (const remote of snapshot.sshRemotes) {
		add('row', `${remote.target}${remote.enabled ? '' : '  (disabled)'}`, remote.name);
	}

	add('heading', 'Conductor profile');
	const profile = snapshot.conductorProfile.trim();
	if (profile === '') add('dim', 'Not set.');
	else {
		const profileLines = profile.split('\n');
		for (const line of profileLines.slice(0, PROFILE_PREVIEW_LINES)) add('row', line.trimEnd());
		if (profileLines.length > PROFILE_PREVIEW_LINES) {
			add('dim', `... ${profileLines.length - PROFILE_PREVIEW_LINES} more lines`);
		}
	}

	add('heading', 'Prompt customizations');
	const modified = snapshot.prompts.filter((prompt) => prompt.modified);
	if (modified.length === 0) add('dim', 'No prompt has been edited.');
	for (const prompt of modified) add('row', 'edited', prompt.id);

	add('heading', 'Encore features');
	const flags = Object.keys(ENCORE_FEATURE_LABELS) as EncoreFlag[];
	for (const flag of flags) {
		add('row', snapshot.encore[flag] ? 'on' : 'off', ENCORE_FEATURE_LABELS[flag]);
	}
	return lines;
}

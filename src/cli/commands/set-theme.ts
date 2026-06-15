// Set theme command - switch the active Maestro theme in the running desktop
// app. Routes through the set_setting WS message (activeThemeId), so the change
// applies live. Accepts a theme ID or display name (case-insensitive). Use
// `--list` to see the available themes.

import { THEMES } from '../../shared/themes';
import { sendSimpleCommand, reportResult, failCommand } from '../services/session-command';

interface SetThemeOptions {
	list?: boolean;
	json?: boolean;
}

export async function setTheme(
	nameOrId: string | undefined,
	options: SetThemeOptions
): Promise<void> {
	const allThemes = Object.values(THEMES);

	if (options.list || !nameOrId) {
		if (options.json) {
			console.log(JSON.stringify(allThemes.map((t) => ({ id: t.id, name: t.name }))));
		} else {
			console.log('Available themes:');
			for (const t of allThemes) {
				console.log(`  ${t.id}${' '.repeat(Math.max(1, 22 - t.id.length))}${t.name}`);
			}
			if (!nameOrId) {
				console.log('\nUsage: maestro-cli set-theme <id|name>');
			}
		}
		return;
	}

	const query = nameOrId.trim().toLowerCase();
	const match = allThemes.find(
		(t) => t.id.toLowerCase() === query || t.name.toLowerCase() === query
	);
	if (!match) {
		failCommand(
			`Unknown theme "${nameOrId}". Run "maestro-cli set-theme --list" to see the options.`,
			options.json
		);
	}

	try {
		const result = await sendSimpleCommand(
			{ type: 'set_setting', key: 'activeThemeId', value: match.id },
			'set_setting_result'
		);
		reportResult(result, {
			json: options.json,
			successMessage: `Theme set to ${match.name} (${match.id})`,
			jsonExtra: { themeId: match.id, name: match.name },
		});
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}

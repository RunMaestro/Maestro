// Surface gloss command - read or set how much light the app chrome catches.
//
// The point-and-click equivalent is Settings -> Themes -> Surface Gloss, and
// both ends go through the same `themeGloss` setting and the same vocabulary in
// `src/shared/themeGloss.ts`, so a slider drag and a CLI call cannot disagree
// about the levels or their order.
//
// Reads come off the on-disk settings store, so `maestro-cli gloss` answers
// even with the app closed. Writes route through the running app's `set_setting`
// WS bridge so the change applies live and persists, the same way `set-theme`
// works. `maestro-cli settings set themeGloss <level>` also works and is picked
// up by the settings watcher, but it skips the validation below, so a typo
// lands as a value that matches no CSS rule and silently renders as off.

import {
	GLOSS_LEVELS,
	GLOSS_LEVEL_META,
	asGlossLevel,
	type GlossLevel,
} from '../../shared/themeGloss';
import { readSettingValue } from '../services/storage';
import { sendSimpleCommand, reportResult, failCommand } from '../services/session-command';

interface GlossOptions {
	list?: boolean;
	json?: boolean;
}

/** Current level as stored on disk, narrowed. */
function readCurrentGloss(): GlossLevel {
	return asGlossLevel(readSettingValue('themeGloss'));
}

function printLevels(current: GlossLevel): void {
	console.log('Gloss levels (least to most):');
	for (const level of GLOSS_LEVELS) {
		const marker = level === current ? '*' : ' ';
		const pad = ' '.repeat(Math.max(1, 10 - level.length));
		console.log(`  ${marker} ${level}${pad}${GLOSS_LEVEL_META[level].description}`);
	}
	console.log('\nUsage: maestro-cli gloss <off|sheen|strong|max>');
	console.log('Note: gloss has no effect on light themes.');
}

export async function gloss(level: string | undefined, options: GlossOptions): Promise<void> {
	const current = readCurrentGloss();

	// No level given, or --list: report rather than change anything.
	if (options.list || !level) {
		if (options.json) {
			console.log(
				JSON.stringify({
					success: true,
					level: current,
					levels: GLOSS_LEVELS.map((value) => ({ value, ...GLOSS_LEVEL_META[value] })),
				})
			);
		} else {
			printLevels(current);
		}
		return;
	}

	const requested = level.trim().toLowerCase();
	if (!(GLOSS_LEVELS as readonly string[]).includes(requested)) {
		failCommand(
			`Unknown gloss level "${level}". Valid levels: ${GLOSS_LEVELS.join(', ')}.`,
			options.json
		);
	}
	const next = requested as GlossLevel;

	try {
		const result = await sendSimpleCommand(
			{ type: 'set_setting', key: 'themeGloss', value: next },
			'set_setting_result'
		);
		reportResult(result, {
			json: options.json,
			successMessage: `Surface gloss set to ${GLOSS_LEVEL_META[next].label} (${next})`,
			jsonExtra: { level: next, previousLevel: current },
		});
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}

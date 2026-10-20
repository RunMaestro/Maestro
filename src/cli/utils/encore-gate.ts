/**
 * The Encore Feature gate for maestro-cli.
 *
 * A switched-off feature leaves no footprint in the CLI: its verbs are hidden
 * from `--help`, `reference` and `completions`, and running one anyway refuses
 * with the one line that turns it back on. Every per-feature check routes
 * through here, so the flag resolution (`resolveEncoreFeatures`, never a raw
 * `=== true`), the message, and the JSON error code are the same everywhere.
 */

import type { Command } from 'commander';
import {
	encoreDisabledMessage,
	encoreFeatureCliName,
	encoreFeatureName,
	resolveEncoreFeatures,
	type EncoreFeatureDefaults,
} from '../../shared/encoreFeatureDefaults';
import { readSettingValue } from '../services/storage';
import { applyDataDirOption } from '../services/data-dir-option';

export type EncoreFlag = keyof EncoreFeatureDefaults;

/** The user's Encore flags, merged onto the shipped defaults. */
export function readEncoreFlags(): EncoreFeatureDefaults {
	return resolveEncoreFeatures(readSettingValue('encoreFeatures'));
}

export function isEncoreEnabled(flag: EncoreFlag): boolean {
	return readEncoreFlags()[flag];
}

/**
 * The flags that decide what `--help` lists, read once while the command tree
 * is built. An unreadable settings file shows the defaults instead of taking
 * every verb down with it, `encore` and `settings` included (the verbs that
 * repair it). Running a gated verb still reads the file strictly.
 */
export function readEncoreFlagsForHelp(): EncoreFeatureDefaults {
	try {
		return readEncoreFlags();
	} catch {
		return resolveEncoreFeatures(undefined);
	}
}

// The names and the turned-off message live in the shared module, so a
// main-process service refuses with the same text a gated verb prints.
export { encoreDisabledMessage, encoreFeatureCliName, encoreFeatureName };

/** `computerHistory` -> `COMPUTER_HISTORY_DISABLED`, the `--json` error code. */
export function encoreDisabledCode(flag: EncoreFlag): string {
	return `${encoreFeatureCliName(flag).replace(/-/g, '_').toUpperCase()}_DISABLED`;
}

/** Exit 1 with the turned-off message unless `flag` is on. */
export function requireEncore(flag: EncoreFlag, json?: boolean): void {
	if (isEncoreEnabled(flag)) return;
	const message = encoreDisabledMessage(flag);
	if (json) {
		console.log(JSON.stringify({ success: false, error: message, code: encoreDisabledCode(flag) }));
	} else {
		console.error(message);
	}
	process.exit(1);
}

/** Verbs under a gated command that still run while the feature is off. */
const ungated = new WeakSet<Command>();

/**
 * Let one verb under a gated command run while the feature is off. Reserved for
 * verbs that only take a footprint away, such as stopping a runner the user
 * started before switching the feature off.
 */
export function allowWhileEncoreOff(command: Command): Command {
	ungated.add(command);
	return command;
}

/**
 * Register a feature's command under `parent`: hidden while `flag` is off in
 * `flags` (the startup read), and refused at run time for every verb beneath
 * it. The refusal is a preAction hook, so it covers each subcommand and reads
 * the flags fresh. A verb's own `--data-dir` is applied first, so a headless
 * data directory is judged by its own settings rather than the default one.
 */
export function encoreCommand(
	parent: Command,
	nameAndArgs: string,
	flag: EncoreFlag,
	flags: EncoreFeatureDefaults
): Command {
	const command = parent.command(nameAndArgs, { hidden: !flags[flag] });
	command.hook('preAction', (_hooked, action) => {
		if (ungated.has(action)) return;
		const options = action.opts();
		if (typeof options.dataDir === 'string') applyDataDirOption(options.dataDir);
		requireEncore(flag, options.json === true);
	});
	return command;
}

/**
 * Refuse a verb when it was handed any of `owned` (option keys, as commander
 * names them) while `flag` is off. For a core verb that only some of its
 * options belong to a feature, e.g. `create-group --parent` and Groups+.
 */
export function requireEncoreForOptions(
	flag: EncoreFlag,
	options: Record<string, unknown>,
	owned: readonly string[]
): void {
	if (!owned.some((key) => options[key] !== undefined && options[key] !== false)) return;
	requireEncore(flag, options.json === true);
}

/** Whether `--help` leaves a command out. Commander keeps the flag private. */
function isHiddenCommand(command: Command): boolean {
	return (command as unknown as { _hidden?: boolean })._hidden === true;
}

/**
 * The subcommands `reference` and `completions` describe: the ones `--help`
 * lists, or every one when `includeHidden` (the docs generator wants the
 * whole surface whatever this machine has switched on).
 */
export function listedSubcommands(command: Command, includeHidden = false): Command[] {
	const all = command.commands as Command[];
	return includeHidden ? all : all.filter((sub) => !isHiddenCommand(sub));
}

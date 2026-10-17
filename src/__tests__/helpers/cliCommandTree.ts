/**
 * Reading the live `maestro-cli` Commander tree from a test.
 *
 * The tree is the one `src/cli/index.ts` registers (the entry point does not
 * parse when it is imported under a test runner), so a test that checks a doc,
 * a prompt or an example against it has no second list of verbs to keep.
 */

import type { Command } from 'commander';

import { program } from '../../cli/index';

/** A subcommand of `command` by its name or one of its aliases. */
export function findSubcommand(command: Command, word: string): Command | undefined {
	return (command.commands as Command[]).find(
		(sub) => sub.name() === word || sub.aliases().includes(word)
	);
}

/**
 * Descend the live tree one subcommand per word, stopping at the first word
 * that is not one. What is left are the arguments and flags of the command.
 */
export function descendCommandTree(words: string[]): { command: Command; rest: string[] } {
	let command: Command = program;
	let index = 0;
	while (index < words.length) {
		const next = findSubcommand(command, words[index]);
		if (!next) break;
		command = next;
		index += 1;
	}
	return { command, rest: words.slice(index) };
}

/** Every flag a command declares, long (`--json`) and short (`-a`), hidden ones included. */
export function declaredFlags(command: Command): Set<string> {
	const flags = new Set<string>();
	for (const option of command.options) {
		if (option.long) flags.add(option.long);
		if (option.short) flags.add(option.short);
	}
	return flags;
}

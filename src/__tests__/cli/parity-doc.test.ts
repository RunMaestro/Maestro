/**
 * @file parity-doc.test.ts
 * @description Holds the Covered tables of docs/agent-guides/CLI-UI-PARITY.md
 * to the live `maestro-cli` command tree.
 *
 * A Covered row is a promise: this point-and-click action has that verb. The
 * table is prose, so a verb that is renamed, a flag that is dropped, or a row
 * written from memory leaves the promise standing with nothing behind it. Here
 * every code span of the CLI column that starts with a registered command is
 * walked down the tree (`a|b|c` fans out to each alternative), and every
 * `--flag` it names has to be declared by a command of that row.
 *
 * What this cannot check is the other half of parity, that the verb reaches
 * the same main-process function as the control. That is a review question.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import type { Command } from 'commander';

import { program } from '../../cli/index';
import { commandPath } from '../../cli/command-examples';
import { declaredFlags, findSubcommand } from '../helpers/cliCommandTree';

const doc = readFileSync(
	path.join(__dirname, '../../../docs/agent-guides/CLI-UI-PARITY.md'),
	'utf-8'
);

interface CoveredRow {
	action: string;
	cli: string;
}

/** A pipe inside a table cell is written `\|`; this stands in for it while the row is split. */
const ESCAPED_PIPE = '\u0000';

/** The rows of every `## Covered...` table: the action, and its CLI cell with `\|` read as `|`. */
function coveredRows(markdown: string): CoveredRow[] {
	const rows: CoveredRow[] = [];
	let inCovered = false;
	for (const line of markdown.split('\n')) {
		if (line.startsWith('## ')) inCovered = line.startsWith('## Covered');
		if (!inCovered || !line.startsWith('|')) continue;
		const cells = line
			.replace(/\\\|/g, ESCAPED_PIPE)
			.split('|')
			.map((cell) => cell.split(ESCAPED_PIPE).join('|').trim());
		const [, action, cli] = cells;
		// The header row and the `| --- |` rule under it are not actions.
		if (!cli || /^-+$/.test(action) || action === 'Point-and-click action') continue;
		rows.push({ action, cli });
	}
	return rows;
}

/** A word that can name a subcommand, or several as `a|b|c`. */
const SUBCOMMAND_WORD = /^[a-z0-9][a-z0-9|-]*$/;

interface ResolvedSpan {
	/** Every command the span names. Empty when it does not start with one. */
	commands: Command[];
	/** What follows the command path: arguments and flags. */
	rest: string[];
	/** A subcommand the span names that its group does not register. */
	unknown: string[];
}

/**
 * Walk a span down the tree one word at a time. A word `a|b` moves to each
 * alternative, so `voice devices list|rename` resolves both verbs. The walk
 * stops at the first word that is not a subcommand: a leaf's argument, a
 * placeholder, or a flag.
 */
function resolveSpan(words: string[]): ResolvedSpan {
	let frontier: Command[] = [program];
	let index = 0;
	const unknown: string[] = [];
	while (index < words.length && SUBCOMMAND_WORD.test(words[index])) {
		const groups = frontier.filter((command) => command.commands.length > 0);
		const next: Command[] = [];
		for (const group of groups) {
			for (const alternative of words[index].split('|')) {
				const sub = findSubcommand(group, alternative);
				if (sub) next.push(sub);
				// A first word that is no command is prose (`off`, `effectiveEnv`), not a typo.
				else if (group !== program) unknown.push(`${commandPath(group)} has no "${alternative}"`);
			}
		}
		if (next.length === 0) break;
		frontier = next;
		index += 1;
	}
	return {
		commands: frontier.filter((command) => command !== program),
		rest: words.slice(index),
		unknown,
	};
}

/** The `--flags` in a run of words, with `<placeholders>` (which may hold a `--`) taken out. */
function longFlags(text: string): string[] {
	return text.replace(/<[^>]*>/g, ' ').match(/--[a-z][a-z0-9-]*/g) ?? [];
}

interface RowReport {
	action: string;
	commands: Command[];
	problems: string[];
}

function checkRow(row: CoveredRow): RowReport {
	const spans = [...row.cli.matchAll(/`([^`]+)`/g)].map((match) => match[1].trim());
	const commands: Command[] = [];
	const problems: string[] = [];
	/** Flags in a span of their own (`--peer-note`): any command of the row may declare them. */
	const looseFlags: string[] = [];

	for (const span of spans) {
		if (span.startsWith('-')) {
			looseFlags.push(...longFlags(span));
			continue;
		}
		const resolved = resolveSpan(span.split(/\s+/));
		if (resolved.commands.length === 0) continue;
		commands.push(...resolved.commands);
		problems.push(...resolved.unknown.map((problem) => `\`${span}\`: ${problem}`));
		for (const flag of longFlags(resolved.rest.join(' '))) {
			if (!resolved.commands.some((command) => declaredFlags(command).has(flag))) {
				const names = resolved.commands.map((command) => commandPath(command)).join(' / ');
				problems.push(`\`${span}\`: ${flag} is not declared by ${names}`);
			}
		}
	}
	for (const flag of looseFlags) {
		if (!commands.some((command) => declaredFlags(command).has(flag))) {
			problems.push(`${flag}: no command in the row declares it`);
		}
	}
	return { action: row.action, commands, problems };
}

const rows = coveredRows(doc);
const reports = rows.map(checkRow);

describe('CLI-UI-PARITY.md Covered tables', () => {
	it('reads the rows of the tables', () => {
		expect(rows.length).toBeGreaterThan(150);
		expect(rows.some((row) => row.action.startsWith('Model server card: Start / Stop'))).toBe(true);
	});

	it('names a registered command in every row', () => {
		const empty = reports
			.filter((report) => report.commands.length === 0)
			.map((report) => report.action);

		expect(empty).toEqual([]);
	});

	it('names only subcommands and flags the live tree declares', () => {
		const problems = reports.flatMap((report) =>
			report.problems.map((problem) => `${report.action}: ${problem}`)
		);

		expect(problems).toEqual([]);
	});

	it('walks an `a|b` word to each alternative, and catches a verb that is gone', () => {
		const both = resolveSpan(['models', 'server', 'start|stop']);
		expect(both.commands.map((command) => commandPath(command))).toEqual([
			'models server start',
			'models server stop',
		]);
		expect(resolveSpan(['models', 'server', 'begin']).unknown).toEqual([
			'models server has no "begin"',
		]);
		expect(
			checkRow({ action: 'x', cli: '`models server set --rotate-keys`' }).problems
		).toHaveLength(1);
		expect(checkRow({ action: 'x', cli: '`opn settings`' }).commands).toEqual([]);
	});

	it('covers the surfaces this branch added', () => {
		const cli = rows.map((row) => row.cli).join('\n');
		for (const verb of [
			'open agent-settings --agent',
			'open group-settings --group',
			'open delegation-graph',
			'open settings --tab models --sub-tab',
			'open usage-dashboard --tab models',
		]) {
			expect(cli, `no Covered row names ${verb}`).toContain(verb);
		}
	});
});

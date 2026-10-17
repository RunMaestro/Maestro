/**
 * Content checks for src/prompts/_maestro-cli.md, the CLI reference agents read
 * at runtime (and what `maestro-cli prompts get _maestro-cli` serves).
 *
 * The peer paragraph points an agent at the roster block in its own system
 * prompt. If the heading or the rules it names drift from
 * src/shared/peerAgents.ts, the agent is told to look for a section that is not
 * there, so the words it relies on are pinned here.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { program } from '../../cli/index';
import { ExitCode } from '../../cli/exit-codes';
import { LOCAL_MODEL_TASK_IDS } from '../../shared/local-models/tasks';
import { declaredFlags, descendCommandTree, findSubcommand } from '../helpers/cliCommandTree';

const prompt = readFileSync(path.join(__dirname, '../../prompts/_maestro-cli.md'), 'utf-8');
const peerParagraph = prompt.split('\n').find((line) => line.startsWith('**Peer agents.**'));

describe('_maestro-cli.md peer agents', () => {
	test('has a peer paragraph beside the ask / dispatch guidance', () => {
		expect(peerParagraph).toBeDefined();
		const askAt = prompt.indexOf('**Asking another agent vs handing it work.**');
		expect(askAt).toBeGreaterThanOrEqual(0);
		expect(prompt.indexOf('**Peer agents.**')).toBeGreaterThan(askAt);
	});

	test('names the roster section, the two grants, the budget and the out-of-bounds rule', () => {
		expect(peerParagraph).toContain('`## Peer Agents`');
		expect(peerParagraph).toContain('`ask`');
		expect(peerParagraph).toContain('`dispatch`');
		expect(peerParagraph).toContain('`Consult only`');
		expect(peerParagraph).toMatch(/Notes column/);
		expect(peerParagraph).toMatch(/budget/);
		expect(peerParagraph).toMatch(/out of bounds/);
	});

	test('lists the two group verbs with the agent management verbs', () => {
		const line = prompt.split('\n').find((l) => l.startsWith('- **create-agent / update-agent'));
		expect(line).toBeDefined();
		expect(line).toContain('group-settings');
		expect(line).toContain('update-group-settings');
	});

	// An agent cannot use a verb it was never told about.
	test('lists the read verb for the whole graph, and says it does not write', () => {
		const line = prompt.split('\n').find((l) => l.startsWith('- **delegation graph**'));
		expect(line).toBeDefined();
		expect(line).toContain('`--group <id>`');
		expect(line).toContain('`--json`');
		expect(line).toMatch(/Read only/);
		expect(line).toContain('`update-agent --peer`');
	});

	test('uses no em or en dash', () => {
		const dashes = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
		expect(dashes.test(prompt)).toBe(false);
	});
});

// The map is the only place an agent learns a verb exists, so every verb it
// names has to be one the live tree registers (src/cli/index.ts, the same tree
// command-tree.test.ts walks).
describe('_maestro-cli.md names the verbs of this branch', () => {
	const spans = [...prompt.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);

	test('has an intent row for every group the Models branch added', () => {
		for (const verb of [
			'voice',
			'models',
			's1',
			'stats models',
			'search',
			'delegation graph',
			'agent test-run-on',
			'group-settings',
		]) {
			const named = prompt.includes(`**${verb}**`) || prompt.includes(`\`${verb}`);
			expect(named, `no row or span for ${verb}`).toBe(true);
		}
	});

	test('every verb path in a code span resolves to a registered subcommand', () => {
		const unresolved: string[] = [];
		for (const span of spans) {
			const words = span.trim().split(/\s+/);
			const { command, rest } = descendCommandTree(words);
			if (command === program || command.commands.length === 0) continue;
			// A group followed by a bare word: that word must be one of its subcommands.
			const next = rest[0];
			if (!next || !/^[a-z][a-z0-9|-]*$/.test(next)) continue;
			for (const alternative of next.split('|')) {
				if (!findSubcommand(command, alternative)) unresolved.push(`${span} -> ${alternative}`);
			}
		}
		expect(unresolved).toEqual([]);
	});

	test('every model and peer flag it names is declared where the map says', () => {
		const both = [
			'--run-on',
			'--run-on-context',
			'--gateway-url',
			'--model',
			'--peer',
			'--peer-note',
			'--group-peers',
			'--worktree-peers',
		];
		const updateOnly = [
			'--tier',
			'--background-requests',
			'--system-one',
			'--proxy-mode',
			'--remove-peer',
		];
		const create = declaredFlags(descendCommandTree(['create-agent']).command);
		const update = declaredFlags(descendCommandTree(['update-agent']).command);
		for (const flag of both) {
			expect(create.has(flag), `create-agent does not declare ${flag}`).toBe(true);
			expect(update.has(flag), `update-agent does not declare ${flag}`).toBe(true);
		}
		for (const flag of updateOnly) {
			expect(update.has(flag), `update-agent does not declare ${flag}`).toBe(true);
			expect(create.has(flag), `create-agent now declares ${flag}: say so in the map`).toBe(false);
		}
		for (const flag of [...both, ...updateOnly]) {
			expect(prompt, `the map does not name ${flag}`).toContain(flag);
		}
	});

	test('lists every Local Models task id the assign verb takes', () => {
		for (const task of LOCAL_MODEL_TASK_IDS) {
			expect(prompt, `task ${task} is missing`).toContain(task);
		}
	});

	test('names every exit code the CLI can return', () => {
		const line = prompt.split('\n').find((l) => l.startsWith('**Conventions.**')) ?? '';
		for (const code of Object.values(ExitCode).filter((v): v is number => typeof v === 'number')) {
			if (code === ExitCode.Success) continue;
			expect(line, `exit code ${code} is not named`).toMatch(new RegExp(`\\b${code}\\b`));
		}
	});
});

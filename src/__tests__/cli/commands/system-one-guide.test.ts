/**
 * @file system-one-guide.test.ts
 * @description `maestro-cli s1 guide` and `maestro-cli s1 examples`, through the
 * real option parser and the real prompt loader, against the prompt files in
 * `src/prompts/`.
 *
 * Properties worth protecting:
 *
 *   - **Every topic in `--list` resolves**, and so does every recipe: a name
 *     the CLI prints is a name it can print the text of.
 *   - **The guide teaches the CLI that exists.** Every `maestro-cli s1` command
 *     in a code fence names a registered verb and only flags that verb takes.
 *     Nothing type-checks a prompt, and a guide that teaches a flag that is not
 *     there is pasted straight into a shell.
 *   - **The measured rules survive an edit**: never index into a long list, a
 *     local judge's number is not a calibrated probability, an unjudged item is
 *     unknown, a screen is not a permission, a refusal is not routed around.
 *   - **An agent reads what the user edited** in Settings, Maestro Prompts.
 *   - **Nothing here needs the desktop app**, so the guide can be read while
 *     System One is off.
 *   - **The three levels agree.** The section in the system prompt, the guide,
 *     and the `_system-one` reference are checked by the same parser, and the
 *     reference names every flag of every verb an agent asks with.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { Command } from 'commander';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const config = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../cli/services/storage', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/storage')>()),
	// The loader reads the user's prompt edits from here. Never the real folder.
	getConfigDirectory: () => config.dir,
}));

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { registerSystemOneAgentCommands } from '../../../cli/commands/system-one-ask';
import { ExitCode } from '../../../cli/exit-codes';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { _resetCliPromptCacheForTests } from '../../../cli/services/prompt-loader';
import {
	SYSTEM_ONE_EXAMPLES,
	SYSTEM_ONE_GUIDE_TOPICS,
	systemOneExamplePromptId,
	systemOneGuidePromptId,
} from '../../../shared/local-models/system-one-guide';
import {
	SYSTEM_ONE_REFERENCE_PROMPT_ID,
	SYSTEM_ONE_SYSTEM_PROMPT_ID,
} from '../../../shared/local-models/system-one-prompt';
import { CORE_PROMPTS, PROMPT_IDS } from '../../../shared/promptDefinitions';

const PROMPTS_DIR = path.resolve(__dirname, '../../../prompts');
// Built from code points so no formatter can turn the escapes into the characters.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

const GUIDE_FILES = [
	...SYSTEM_ONE_GUIDE_TOPICS.map((entry) => systemOneGuidePromptId(entry.name)),
	...SYSTEM_ONE_EXAMPLES.map((entry) => systemOneExamplePromptId(entry.name)),
];

const read = (promptId: string) =>
	fs.readFileSync(path.join(PROMPTS_DIR, `${promptId}.md`), 'utf-8');
const topic = (name: string) => read(systemOneGuidePromptId(name));
const recipe = (name: string) => read(systemOneExamplePromptId(name));

let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

const out = () => logSpy.mock.calls.map((call) => String(call[0])).join('\n');
const err = () => errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
const jsonOut = () => JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));

/** `maestro-cli s1`, with every verb `registerSystemOneAgentCommands` adds. */
function s1Command(): { program: Command; s1: Command } {
	const program = new Command();
	program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
	program.option('-q, --quiet');
	const s1 = program.command('s1');
	registerSystemOneAgentCommands(s1);
	return { program, s1 };
}

/** Run `maestro-cli s1 <words>` through the real option parser. */
async function s1(...words: string[]): Promise<void> {
	logSpy.mockClear();
	await s1Command().program.parseAsync(['node', 'maestro-cli', 's1', ...words]);
}

/** Run a command that is expected to exit, and answer with the code it exited with. */
async function exitCode(...words: string[]): Promise<number> {
	await expect(s1(...words)).rejects.toThrow(/^exit:/);
	return Number(exitSpy.mock.calls.at(-1)?.[0]);
}

beforeEach(() => {
	vi.clearAllMocks();
	_resetCliPromptCacheForTests();
	config.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-one-guide-'));
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
		throw new Error(`exit:${code}`);
	}) as never);
});

afterEach(() => {
	fs.rmSync(config.dir, { recursive: true, force: true });
});

describe('s1 guide', () => {
	it('prints the playbook when no topic is named', async () => {
		await s1('guide');
		expect(out()).toBe(topic('when').trimEnd());
		expect(out().startsWith('# System One: the playbook')).toBe(true);
	});

	it('lists every topic with its title, and says how to read one', async () => {
		await s1('guide', '--list');
		const listed = out();
		for (const entry of SYSTEM_ONE_GUIDE_TOPICS) {
			expect(listed, entry.name).toContain(`  ${entry.name.padEnd(10)}  ${entry.title}`);
		}
		expect(listed).toContain('maestro-cli s1 guide <topic>');
		expect(listed).toContain('maestro-cli s1 examples');
	});

	it('resolves every topic in the list to its own text', async () => {
		await s1('guide', '--list', '--json');
		const { topics } = jsonOut() as { topics: Array<{ name: string; promptId: string }> };
		expect(topics.map((entry) => entry.name)).toEqual(
			SYSTEM_ONE_GUIDE_TOPICS.map((entry) => entry.name)
		);
		const seen = new Set<string>();
		for (const entry of topics) {
			await s1('guide', entry.name);
			const text = out();
			expect(text, entry.name).toBe(read(entry.promptId).trimEnd());
			expect(text, entry.name).toMatch(/^# System One: /);
			expect(text.length, entry.name).toBeGreaterThan(1500);
			seen.add(text);
		}
		expect(seen.size).toBe(topics.length);
	});

	it('forgives the case of a topic', async () => {
		await s1('guide', 'Pitfalls');
		expect(out()).toBe(topic('pitfalls').trimEnd());
	});

	it('prints a topic as JSON with its name, title and prompt id', async () => {
		await s1('guide', 'limits', '--json');
		expect(jsonOut()).toEqual({
			success: true,
			name: 'limits',
			title: SYSTEM_ONE_GUIDE_TOPICS.find((entry) => entry.name === 'limits')?.title,
			promptId: 'system-one-guide-limits',
			content: topic('limits').trimEnd(),
		});
	});

	it('refuses a topic it does not have as a usage error, and names the topics', async () => {
		expect(await exitCode('guide', 'gutcheck')).toBe(ExitCode.InvalidUsage);
		expect(err()).toContain('Unknown guide topic "gutcheck"');
		for (const entry of SYSTEM_ONE_GUIDE_TOPICS) expect(err()).toContain(entry.name);

		expect(await exitCode('guide', 'nope', '--json')).toBe(ExitCode.InvalidUsage);
		expect(jsonOut()).toMatchObject({ success: false });
	});

	it('prints what the user edited in Settings, not the bundled text', async () => {
		fs.writeFileSync(
			path.join(config.dir, 'core-prompts-customizations.json'),
			JSON.stringify({
				prompts: {
					'system-one-guide-when': {
						isModified: true,
						content: '# Our house rules\n\nAsk less.\n',
					},
				},
			})
		);
		await s1('guide');
		expect(out()).toBe('# Our house rules\n\nAsk less.');
		await s1('guide', 'noul');
		expect(out()).toBe(topic('noul').trimEnd());
	});

	it('never talks to the desktop app', async () => {
		await s1('guide');
		await s1('guide', '--list');
		await s1('examples', 'all');
		expect(withMaestroClient).not.toHaveBeenCalled();
	});
});

describe('s1 examples', () => {
	it('lists the recipes when no name is given', async () => {
		await s1('examples');
		for (const entry of SYSTEM_ONE_EXAMPLES) {
			expect(out(), entry.name).toContain(`  ${entry.name.padEnd(8)}  ${entry.title}`);
		}
		expect(out()).toContain('maestro-cli s1 examples <name>');
	});

	it('resolves every recipe in the list to its own text', async () => {
		await s1('examples', '--json');
		const { examples } = jsonOut() as { examples: Array<{ name: string; promptId: string }> };
		expect(examples.map((entry) => entry.name)).toEqual(
			SYSTEM_ONE_EXAMPLES.map((entry) => entry.name)
		);
		for (const entry of examples) {
			await s1('examples', entry.name);
			expect(out(), entry.name).toBe(read(entry.promptId).trimEnd());
			expect(out(), entry.name).toMatch(/^# Recipe: /);
			expect(out(), entry.name).toContain('maestro-cli s1 ');
		}
	});

	it('prints every recipe for "all", in the order of the list', async () => {
		await s1('examples', 'all');
		expect(out()).toBe(
			SYSTEM_ONE_EXAMPLES.map((entry) => recipe(entry.name).trimEnd()).join('\n\n')
		);
	});

	it('prints recipes as JSON', async () => {
		await s1('examples', 'screen', '--json');
		expect(jsonOut()).toEqual({
			success: true,
			examples: [
				{
					name: 'screen',
					title: SYSTEM_ONE_EXAMPLES.find((entry) => entry.name === 'screen')?.title,
					promptId: 'system-one-example-screen',
					content: recipe('screen').trimEnd(),
				},
			],
		});
		await s1('examples', 'all', '--json');
		expect(jsonOut().examples).toHaveLength(SYSTEM_ONE_EXAMPLES.length);
	});

	it('refuses a recipe it does not have as a usage error, and names the recipes', async () => {
		expect(await exitCode('examples', 'pitfalls')).toBe(ExitCode.InvalidUsage);
		expect(err()).toContain('Unknown recipe "pitfalls"');
		for (const entry of SYSTEM_ONE_EXAMPLES) expect(err()).toContain(entry.name);
	});

	it('names every recipe in its own help line', () => {
		const description = s1Command()
			.s1.commands.find((command) => command.name() === 'examples')
			?.description();
		for (const entry of SYSTEM_ONE_EXAMPLES) expect(description, entry.name).toContain(entry.name);
	});
});

// ---------------------------------------------------------------------------
// The text itself
// ---------------------------------------------------------------------------

/** The lines of a markdown text that sit inside a ```bash fence, with `\` continuations joined. */
function shellCommands(markdown: string): string[] {
	const commands: string[] = [];
	let inShell = false;
	let open = '';
	for (const line of markdown.split('\n')) {
		const fence = line.trim().match(/^```(\w*)$/);
		if (fence) {
			inShell = !inShell && fence[1] === 'bash';
			open = '';
			continue;
		}
		if (!inShell) continue;
		const joined = open + line.trim();
		if (joined.endsWith('\\')) {
			open = `${joined.slice(0, -1)} `;
		} else {
			commands.push(joined);
			open = '';
		}
	}
	return commands;
}

/** Every `maestro-cli s1 <verb> ...` of a shell line: the verb, and the flags typed after it. */
function s1Calls(command: string): Array<{ verb: string; flags: string[] }> {
	// What is inside quotes is a question or a description, not the command line.
	const bare = command.replace(/'[^']*'|"[^"]*"/g, '""').replace(/(^|\s)#.*$/, '');
	return bare
		.split(/[|;>]/)
		.filter((part) => part.includes('maestro-cli s1 '))
		.map((part) => {
			const words = part
				.slice(part.indexOf('maestro-cli s1 ') + 'maestro-cli s1 '.length)
				.split(/\s+/);
			return {
				verb: words[0],
				flags: words
					.slice(1)
					.filter((word) => /^--?[a-zA-Z]/.test(word))
					.map((word) => word.split('=')[0]),
			};
		});
}

describe('the guide text', () => {
	it('holds no long dash, no template variable and no escaped shell character', () => {
		for (const id of GUIDE_FILES) {
			const text = read(id);
			expect(DASHES.test(text), id).toBe(false);
			// The CLI prints these as written: a variable would reach the agent unfilled.
			expect(text, id).not.toContain('{{');
			// What a markdown formatter does to a glob or an underscore outside a fence.
			expect(text, id).not.toMatch(/\\[*_]/);
		}
	});

	it('keeps the playbook near the size an agent is told to expect', () => {
		// About 1,500 tokens. It is read once per session by every agent that asks.
		expect(topic('when').length).toBeLessThan(7500);
	});

	it('teaches only verbs and flags the CLI has', () => {
		const { s1: registered } = s1Command();
		const verbs = new Map(registered.commands.map((command) => [command.name(), command]));
		let checked = 0;
		for (const id of GUIDE_FILES) {
			for (const command of shellCommands(read(id))) {
				for (const call of s1Calls(command)) {
					const verb = verbs.get(call.verb);
					expect(verb, `${id}: maestro-cli s1 ${call.verb}`).toBeDefined();
					const known = new Set(
						verb!.options.flatMap((option) => [option.long, option.short]).filter(Boolean)
					);
					for (const flag of call.flags) {
						expect(known.has(flag), `${id}: s1 ${call.verb} ${flag}`).toBe(true);
					}
					checked += 1;
				}
			}
		}
		// The parser above found the commands: a guide with none would pass by default.
		expect(checked).toBeGreaterThan(30);
	});

	it('single-quotes every question that holds backticks', () => {
		for (const id of GUIDE_FILES) {
			for (const command of shellCommands(read(id))) {
				if (!command.includes('maestro-cli s1 ')) continue;
				const doubleQuoted = command.replace(/'[^']*'/g, '').match(/"[^"]*"/g) ?? [];
				for (const quoted of doubleQuoted) {
					expect(quoted.includes('`'), `${id}: ${quoted}`).toBe(false);
				}
			}
		}
	});

	it('says in every recipe which of its commands a paste would run', () => {
		for (const entry of SYSTEM_ONE_EXAMPLES) {
			const calls = shellCommands(recipe(entry.name)).flatMap(s1Calls);
			expect(calls.length, entry.name).toBeGreaterThan(0);
		}
		expect(shellCommands(recipe('rank')).flatMap(s1Calls)[0].verb).toBe('rank');
		expect(shellCommands(recipe('gutcheck')).flatMap(s1Calls)[0].verb).toBe('yes');
	});

	it('keeps the measured rule about indexing into a long list wherever items are named', () => {
		for (const name of ['when', 'questions', 'state', 'pitfalls']) {
			const text = topic(name);
			expect(text, name).toContain('items[137]');
			expect(text, name).toContain('27%');
			expect(text, name).toContain('9% at 25');
			expect(text, name).toMatch(/0 wrong of 320/);
			expect(text, name).toContain('2026-09-18');
		}
		expect(topic('noul')).toContain('never `items[7]` in a long list');
		expect(recipe('dedupe')).toContain('27% wrong at 150 items');
	});

	it('never lets a local judge number pass for a calibrated probability', () => {
		for (const name of ['when', 'confidence', 'limits', 'pitfalls', 'noul', 'choice', 'score']) {
			expect(topic(name), name).toMatch(/not calibrated|local judge/i);
		}
		expect(topic('when')).toMatch(/`local-judge`: \*\*not calibrated\.\*\*/);
		expect(topic('limits')).toMatch(/`local-judge`.*\*\*No\*\*/);
	});

	it('says an unjudged item is unknown, and that no marker means the output was cut', () => {
		for (const text of [topic('when'), topic('limits'), topic('pitfalls'), recipe('rank')]) {
			expect(text).toContain('UNKNOWN');
			expect(text).toMatch(/End s1 rank:/);
			expect(text).toMatch(/INCOMPLETE s1 rank:/);
			expect(text).toMatch(/cut off|was cut/);
		}
	});

	it('says a screen is not a permission, and a refusal is not routed around', () => {
		expect(topic('when')).toContain('never to authorize');
		expect(topic('confidence')).toContain('does not grant permission');
		expect(recipe('screen')).toContain('never to authorize');
		for (const text of [topic('when'), topic('limits'), topic('pitfalls')]) {
			expect(text).toMatch(/without System One/);
			expect(text).toMatch(/Do not retry/);
		}
	});

	it('says the key stays in Maestro and how it lives beside a jev install', () => {
		expect(topic('when')).toContain('If the `jev` CLI is also installed, prefer `maestro-cli s1`');
		expect(topic('limits')).toContain('The key stays in Maestro');
	});

	it('points the playbook at every topic and every recipe', () => {
		const playbook = topic('when');
		for (const entry of SYSTEM_ONE_GUIDE_TOPICS) {
			if (entry.name !== 'when') expect(playbook, entry.name).toContain(entry.name);
		}
		for (const entry of SYSTEM_ONE_EXAMPLES) expect(playbook, entry.name).toContain(entry.name);
	});

	it('gives the exit codes the verbs exit with', () => {
		const limits = topic('limits');
		for (const row of ['| 0 ', '| 1 ', '| 2 ', '| 3, 4, 5 ', '| 6 ', '| 7 ']) {
			expect(limits, row).toContain(row);
		}
		expect(ExitCode.Refused).toBe(6);
		expect(ExitCode.NoAnswer).toBe(7);
	});
});

// ---------------------------------------------------------------------------
// The other two levels: the system prompt section, and the full reference
// ---------------------------------------------------------------------------

describe('the System One section of the system prompt', () => {
	const section = () => read(SYSTEM_ONE_SYSTEM_PROMPT_ID);

	it('is a registered core prompt a user can edit', () => {
		const def = CORE_PROMPTS.find((prompt) => prompt.id === SYSTEM_ONE_SYSTEM_PROMPT_ID);
		expect(def?.filename).toBe('system-one-system.md');
		expect(PROMPT_IDS.SYSTEM_ONE_SYSTEM).toBe(SYSTEM_ONE_SYSTEM_PROMPT_ID);
		expect(fs.existsSync(path.join(PROMPTS_DIR, def!.filename))).toBe(true);
	});

	it('stays a mention: it rides on every spawn of every local agent', () => {
		expect(section().length).toBeLessThan(2500);
		expect(section().trim().split('\n').length).toBeLessThanOrEqual(20);
	});

	it('names the engine, its calibration and the budget through the variables a builder fills', () => {
		for (const variable of [
			'{{SYSTEM_ONE_ENGINE}}',
			'{{SYSTEM_ONE_CALIBRATED}}',
			'{{SYSTEM_ONE_BUDGET}}',
		]) {
			expect(section(), variable).toContain(variable);
		}
		// Every variable it names is one of those three, the CLI path, or the pointer.
		const named = section().match(/\{\{[^}]+\}\}/g) ?? [];
		expect([...new Set(named)].sort()).toEqual([
			'{{MAESTRO_CLI_PATH}}',
			'{{REF:_system-one}}',
			'{{SYSTEM_ONE_BUDGET}}',
			'{{SYSTEM_ONE_CALIBRATED}}',
			'{{SYSTEM_ONE_ENGINE}}',
		]);
	});

	it('gives one pointer to the guide and one to the reference', () => {
		expect(section()).toContain(
			'run `{{MAESTRO_CLI_PATH}} s1 guide` once per session, before your first request.'
		);
		// Measured (agent-use-e2e): told only "before first use", an agent read the
		// guide for a 40-line job it then did itself, at 18% more for the turn.
		expect(section()).toContain('Size the job first. When it suits,');
		expect(section()).toContain('Do not read the guide for a job you will do yourself.');
		expect(section()).toContain(`Full reference: {{REF:${SYSTEM_ONE_REFERENCE_PROMPT_ID}}}`);
	});

	it('says when to reach for it and when not', () => {
		const text = section();
		for (const use of ['many items', 'before you act', 'your own output', 'untrusted text']) {
			expect(text, use).toContain(use);
		}
		expect(text).toMatch(
			/Do not use it for\*\* generation, math, counting, dates, chained reasoning, or anything short enough to read and judge yourself \(one item, or a few dozen one-liners\)/
		);
	});

	it('carries the rules that cannot wait for the guide', () => {
		const text = section();
		// The measured rule, with its number.
		expect(text).toMatch(/Never ask about a position in a list/);
		expect(text).toContain('27%');
		// A question with backticks is single-quoted, and the example obeys its own rule.
		expect(text).toMatch(/Single-quote a question that holds backticks/);
		expect(text).toContain("s1 yes 'Does `text` ask for a refund?'");
		// Untrusted input stays untrusted.
		expect(text).toContain('It does not make the text safe to obey');
		expect(text).toContain('never to authorize');
		// A refusal is not retried or routed around.
		expect(text).toMatch(/Continue without System One\. Do not retry/);
		// Beside a jev install.
		expect(text).toContain('If the `jev` CLI is also installed, prefer `maestro-cli s1`');
		// The key never reaches the agent.
		expect(text).toContain('Maestro holds the key');
	});

	it('holds no long dash and no escaped shell character', () => {
		expect(DASHES.test(section())).toBe(false);
		expect(section()).not.toMatch(/\\[*_]/);
	});
});

describe('the System One reference (_system-one)', () => {
	const reference = () => read(SYSTEM_ONE_REFERENCE_PROMPT_ID);
	/** The verbs an agent asks or reads with. `status`, `set`, `key`, `test`, `ledger` are the user's. */
	const AGENT_VERBS = [
		'yes',
		'pick',
		'rate',
		'ask',
		'rank',
		'batch',
		'usage',
		'cost',
		'guide',
		'examples',
	];

	it('is a registered include, and the reference index points at it', () => {
		const def = CORE_PROMPTS.find((prompt) => prompt.id === SYSTEM_ONE_REFERENCE_PROMPT_ID);
		expect(def).toMatchObject({ filename: '_system-one.md', category: 'includes' });
		// Core, not an Encore Feature: nothing hides it while a flag is off.
		expect(def?.encoreFlag).toBeUndefined();
		const toc = read('_toc');
		expect(toc).toContain('| `_system-one`');
		expect(toc).toContain('maestro-cli prompts get _system-one');
	});

	it('names every flag of every verb an agent asks with', () => {
		const text = reference();
		const { s1: registered } = s1Command();
		const verbs = new Map(registered.commands.map((command) => [command.name(), command]));
		let checked = 0;
		for (const name of AGENT_VERBS) {
			const verb = verbs.get(name);
			expect(verb, name).toBeDefined();
			expect(text, `s1 ${name}`).toContain(`\`s1 ${name}`);
			for (const option of verb!.options) {
				expect(text, `s1 ${name} ${option.long}`).toContain(option.long!);
				checked += 1;
			}
		}
		expect(checked).toBeGreaterThan(50);
		// And no agent-facing verb was added to the CLI without a row here.
		const userVerbs = ['status', 'set', 'key', 'test', 'ledger'];
		for (const command of registered.commands) {
			expect([...AGENT_VERBS, ...userVerbs], command.name()).toContain(command.name());
		}
	});

	it('teaches only verbs and flags the CLI has, and single-quotes backticked questions', () => {
		const { s1: registered } = s1Command();
		const verbs = new Map(registered.commands.map((command) => [command.name(), command]));
		let checked = 0;
		for (const command of shellCommands(reference())) {
			for (const call of s1Calls(command)) {
				const verb = verbs.get(call.verb);
				expect(verb, `maestro-cli s1 ${call.verb}`).toBeDefined();
				const known = new Set(
					verb!.options.flatMap((option) => [option.long, option.short]).filter(Boolean)
				);
				for (const flag of call.flags) {
					expect(known.has(flag), `s1 ${call.verb} ${flag}`).toBe(true);
				}
				checked += 1;
			}
			if (!command.includes('maestro-cli s1 ')) continue;
			const doubleQuoted = command.replace(/'[^']*'/g, '').match(/"[^"]*"/g) ?? [];
			for (const quoted of doubleQuoted) expect(quoted.includes('`'), quoted).toBe(false);
		}
		expect(checked).toBeGreaterThan(8);
	});

	it('is read from disk as written: no template variable, no long dash, no escaped character', () => {
		// The header comment says which directive points here; the body names none.
		const body = reference().replace(/^<!--[\s\S]*?-->/, '');
		expect(body).not.toContain('{{');
		expect(DASHES.test(reference())).toBe(false);
		expect(body).not.toMatch(/\\[*_]/);
	});

	it('carries the detail the section and the playbook leave out', () => {
		const text = reference();
		expect(text.length).toBeGreaterThan(read(SYSTEM_ONE_SYSTEM_PROMPT_ID).length * 4);
		// Output shapes, by the names the CLI prints them under.
		for (const field of [
			'`probability`',
			'`verdict`',
			'`probabilities`',
			'`minConfidence`',
			'`nearestLevel`',
			'`unjudged`',
			'`completeness`',
			'`cachedRequests`',
			'`engineLabel`',
			'`calibrated`',
			'`costUsd`',
			'`redacted`',
			'`remainingTodayUsd`',
		]) {
			expect(text, field).toContain(field);
		}
		// Exit codes, as the verbs exit.
		for (const row of ['| 0 ', '| 1 ', '| 2 ', '| 3, 4, 5 ', '| 6 ', '| 7 ']) {
			expect(text, row).toContain(row);
		}
		// Every topic and every recipe of the level below.
		for (const entry of SYSTEM_ONE_GUIDE_TOPICS)
			expect(text, entry.name).toContain(`\`${entry.name}\``);
		for (const entry of SYSTEM_ONE_EXAMPLES)
			expect(text, entry.name).toContain(`\`${entry.name}\``);
	});

	it('keeps the measured rules and the three things an agent must not do', () => {
		const text = reference();
		expect(text).toContain('items[137]');
		expect(text).toContain('27%');
		expect(text).toContain('9% at 25');
		expect(text).toMatch(/0 wrong of 320/);
		expect(text).toContain('2026-09-18');
		expect(text).toMatch(/`local-judge`.*\*\*No\*\*/);
		expect(text).toContain('never gate a destructive action on it');
		expect(text).toContain('UNKNOWN');
		expect(text).toMatch(/No marker means the output was cut off/);
		expect(text).toContain('it is not a permission');
		expect(text).toMatch(/Do not retry, do not change a setting/);
		expect(text).toContain('It stays in Maestro');
		expect(text).toContain('prefer `maestro-cli s1`');
	});
});

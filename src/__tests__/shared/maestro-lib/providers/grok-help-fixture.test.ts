/**
 * Pin Grok's launch surface against the real help text.
 *
 * The fixture under fixtures/grok/help-<version>/ is captured from an installed
 * binary by scripts/refresh-grok-help-fixture.mjs. These cases fail when a flag
 * Maestro emits is no longer in the help, and when the help lists an option the
 * decided-flags ledger (GROK_FLAG_LEDGER) has not decided, so a new release
 * cannot slip a flag change past the suite without a live run.
 */
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { getAgentDefinition } from '../../../../shared/maestro-lib/providers/definitions';
import { GROK_CAPABILITY_EVIDENCE } from '../../../../shared/maestro-lib/providers/capabilities';
import {
	GROK_FLAG_LEDGER,
	type GrokHelpCommand,
} from '../../../../shared/maestro-lib/providers/grok-flag-ledger';
import { GROK_ACP_ARGS, parseGrokNativeArgs } from '../../../../shared/maestro-lib/grok/route';
import {
	grokLaunchArgsProblem,
	resolveGrokModelEffortArgs,
} from '../../../../shared/maestro-lib/launch/agent-args';
import {
	GROK_WIZARD_DISCOVERY_ARGS,
	GROK_WIZARD_GENERATION_ARGS,
} from '../../../../renderer/utils/grokWizard';

const FIXTURE_DIR = path.join(__dirname, `../../../fixtures/grok/help-${GROK_FLAG_LEDGER.version}`);

function readFixture(name: string): string {
	return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

interface HelpOption {
	long: string;
	short?: string;
	aliases: string[];
	values: string[];
}

interface ParsedHelp {
	options: Map<string, HelpOption>;
	commands: Set<string>;
}

/** Read clap help output: option headers, aliases, possible values and subcommands. */
function parseHelp(text: string): ParsedHelp {
	const options = new Map<string, HelpOption>();
	const commands = new Set<string>();
	let section: 'options' | 'commands' | undefined;
	let current: HelpOption | undefined;
	let inValueList = false;
	for (const line of text.split('\n')) {
		if (/^\S/.test(line)) {
			section = line.startsWith('Options:')
				? 'options'
				: line.startsWith('Commands:')
					? 'commands'
					: undefined;
			current = undefined;
			continue;
		}
		if (section === 'commands') {
			const command = line.match(/^ {2}([a-z][\w-]*)\s/);
			if (command) commands.add(command[1]);
			continue;
		}
		if (section !== 'options') continue;
		const header = line.match(/^ {2}(?:(-[A-Za-z]), )?(--[A-Za-z][\w-]*)|^ {6}(--[A-Za-z][\w-]*)/);
		if (header) {
			current = { long: header[2] ?? header[3], short: header[1], aliases: [], values: [] };
			options.set(current.long, current);
			inValueList = false;
		}
		if (!current) continue;
		for (const group of line.matchAll(
			/(?:\[aliases: ([^\]]+)\]|compat alias(?:es)?: ([^)]+)\))/g
		)) {
			for (const alias of (group[1] ?? group[2]).matchAll(/-{2,}[\w-]+/g)) {
				current.aliases.push(alias[0]);
			}
		}
		const inline = line.match(/\[possible values: ([^\]]+)\]/);
		if (inline) current.values.push(...inline[1].split(',').map((v) => v.trim()));
		if (/^\s+Possible values:\s*$/.test(line)) inValueList = true;
		else if (inValueList) {
			const item = line.match(/^\s+- ([\w-]+)/);
			if (item) current.values.push(item[1]);
			else if (line.trim()) inValueList = false;
		}
	}
	return { options, commands };
}

/** The option a token on argv selects: its long name, short form or an alias. */
function resolveOption(parsed: ParsedHelp, token: string): HelpOption | undefined {
	const flag = token.split('=', 1)[0];
	for (const option of parsed.options.values()) {
		if (option.long === flag || option.short === flag || option.aliases.includes(flag)) {
			return option;
		}
	}
	return undefined;
}

function missingFlags(parsed: ParsedHelp, tokens: readonly string[]): string[] {
	return tokens.filter((token) => !resolveOption(parsed, token));
}

const grok = getAgentDefinition('grok')!;

/** Every native flag a Grok launch builder emits on the native (non-ACP) route. */
function emittedNativeArgv(): string[] {
	return [
		...grok.batchModeArgs!,
		...grok.jsonOutputArgs!,
		...grok.promptArgs!('prompt'),
		...grok.promptFileArgs!('/tmp/prompt.json'),
		...grok.resumeArgs!('00000000-0000-4000-8000-000000000000'),
		...grok.readOnlyArgs!,
		...grok.yoloModeArgs!,
		...grok.workingDirArgs!('/tmp/project'),
		...grok.modelArgs!('grok-4.7'),
		...(grok.configOptions ?? []).flatMap((option) =>
			'argBuilder' in option && option.argBuilder ? option.argBuilder('high' as never) : []
		),
		...GROK_WIZARD_DISCOVERY_ARGS,
		...GROK_WIZARD_GENERATION_ARGS,
	];
}

const flagsOf = (argv: readonly string[]) => [
	...new Set(argv.filter((token) => token.startsWith('-'))),
];

const EMITTED_FLAGS = flagsOf(emittedNativeArgv());
/** Flags the definition names without emitting them on every turn. */
const NAMED_DEFINITION_FLAGS = [...(grok.promptFile?.exclusivePromptFlags ?? [])];
/**
 * Flags agent-args.ts reads by name: the selection aliases (resolveGrokModelEffortArgs)
 * and the selectors grokLaunchArgsProblem refuses. Each is proven against the module
 * below, so the list cannot drift from the code silently.
 */
const AGENT_ARGS_SELECTION_FLAGS = ['-m', '--model', '--effort', '--reasoning-effort'];
const AGENT_ARGS_REFUSED_FLAGS = [
	'--continue',
	'-c',
	'--fork-session',
	'--session-id',
	'--worktree',
	'-w',
	'-r',
];

const HELP_FILES: Record<GrokHelpCommand, string[]> = {
	grok: ['grok--help.txt', 'grok-help.txt'],
	'grok agent': ['grok-agent--help.txt'],
	'grok agent stdio': ['grok-agent-stdio--help.txt'],
};

describe('Grok help fixture', () => {
	const shortHelp = parseHelp(readFixture('grok--help.txt'));
	const longHelp = parseHelp(readFixture('grok-help.txt'));
	const agentHelp = parseHelp(readFixture('grok-agent--help.txt'));
	const stdioHelp = parseHelp(readFixture('grok-agent-stdio--help.txt'));

	it('is stamped with the version the ledger and capability evidence name', () => {
		const versionLine = readFixture('version.txt').trim();
		expect(versionLine).toMatch(
			new RegExp(`^grok ${GROK_FLAG_LEDGER.version.replace(/\./g, '\\.')} `)
		);
		expect(GROK_CAPABILITY_EVIDENCE.candidateVersion).toBe(GROK_FLAG_LEDGER.version);
	});

	it('parses the same option set from the short and long top-level help', () => {
		expect(shortHelp.options.size).toBeGreaterThan(40);
		expect([...longHelp.options.keys()].sort()).toEqual([...shortHelp.options.keys()].sort());
		expect(agentHelp.options.size).toBeGreaterThan(10);
		expect(stdioHelp.options.has('--leader-socket')).toBe(true);
	});

	it('lists every flag the definition, the wizard bounds and the prompt-file plan emit', () => {
		expect(EMITTED_FLAGS.length).toBeGreaterThan(10);
		for (const help of [shortHelp, longHelp]) {
			expect(missingFlags(help, EMITTED_FLAGS)).toEqual([]);
			expect(missingFlags(help, NAMED_DEFINITION_FLAGS)).toEqual([]);
		}
	});

	it('accepts the values the definition passes to enumerated flags', () => {
		for (const help of [shortHelp, longHelp]) {
			expect(resolveOption(help, '--output-format')!.values).toContain(grok.jsonOutputArgs![1]);
			const readOnly = grok.readOnlyArgs!;
			expect(resolveOption(help, '--permission-mode')!.values).toContain(
				readOnly[readOnly.indexOf('--permission-mode') + 1]
			);
		}
	});

	it('lists the agent-args.ts selection aliases and refused selectors', () => {
		expect(() => resolveGrokModelEffortArgs(['--model', 'a', '-m', 'b'])).toThrow(/Conflicting/);
		expect(() =>
			resolveGrokModelEffortArgs(['--effort', 'low', '--reasoning-effort', 'high'])
		).toThrow(/Conflicting/);
		for (const flag of AGENT_ARGS_REFUSED_FLAGS) {
			expect(grokLaunchArgsProblem([flag, 'x']), flag).toMatch(/cannot supply/);
		}
		for (const help of [shortHelp, longHelp]) {
			expect(missingFlags(help, AGENT_ARGS_SELECTION_FLAGS)).toEqual([]);
			expect(missingFlags(help, AGENT_ARGS_REFUSED_FLAGS)).toEqual([]);
		}
	});

	it('carries the route subcommand and reads every generated native flag as generated', () => {
		const [subcommand, transport] = GROK_ACP_ARGS;
		expect(shortHelp.commands.has(subcommand)).toBe(true);
		expect(agentHelp.commands.has(transport)).toBe(true);
		// The route's generated set and the definition must agree: a definition flag the
		// route reads as custom argv would refuse every Standard turn (acp-custom-args).
		const routeArgv = [
			...grok.batchModeArgs!,
			...grok.jsonOutputArgs!,
			...grok.promptFileArgs!('/tmp/prompt.json'),
			...grok.resumeArgs!('id'),
			...grok.workingDirArgs!('/tmp/project'),
			...grok.modelArgs!('grok-4.7'),
			'--reasoning-effort',
			'high',
		];
		expect(parseGrokNativeArgs(routeArgv).customArgs).toBe(false);
		expect(missingFlags(shortHelp, flagsOf(routeArgv))).toEqual([]);
	});

	describe('decided-flags ledger', () => {
		it('decides every option of every captured command, and nothing the help lacks', () => {
			for (const [command, files] of Object.entries(HELP_FILES) as [GrokHelpCommand, string[]][]) {
				const decided = Object.keys(GROK_FLAG_LEDGER.commands[command]).sort();
				for (const file of files) {
					expect([...parseHelp(readFixture(file)).options.keys()].sort(), file).toEqual(decided);
				}
			}
		});

		it('gives every decision a one-line reason', () => {
			for (const decisions of Object.values(GROK_FLAG_LEDGER.commands)) {
				for (const [flag, decision] of Object.entries(decisions)) {
					expect(['used', 'unused'], flag).toContain(decision.status);
					expect(decision.reason.trim().length, flag).toBeGreaterThan(10);
					expect(decision.reason, flag).not.toMatch(/\n/);
				}
			}
		});

		it('marks exactly the emitted top-level flags as used', () => {
			const emitted = new Set(EMITTED_FLAGS.map((token) => resolveOption(shortHelp, token)!.long));
			const used = Object.entries(GROK_FLAG_LEDGER.commands.grok)
				.filter(([, decision]) => decision.status === 'used')
				.map(([flag]) => flag);
			expect(used.sort()).toEqual([...emitted].sort());
		});

		it('marks every agent and stdio option unused, because the ACP route passes none', () => {
			expect(GROK_ACP_ARGS).toEqual(['agent', 'stdio']);
			for (const command of ['grok agent', 'grok agent stdio'] as const) {
				for (const [flag, decision] of Object.entries(GROK_FLAG_LEDGER.commands[command])) {
					expect(decision.status, `${command} ${flag}`).toBe('unused');
				}
			}
		});

		it('records every evidence flag decision as unused in the ledger', () => {
			for (const flag of Object.keys(GROK_CAPABILITY_EVIDENCE.flagDecisions)) {
				expect(GROK_FLAG_LEDGER.commands.grok[flag]?.status, flag).toBe('unused');
			}
		});
	});

	it('fails when any emitted flag is removed from the fixture', () => {
		const text = readFixture('grok--help.txt');
		for (const token of [...EMITTED_FLAGS, ...NAMED_DEFINITION_FLAGS]) {
			const option = resolveOption(shortHelp, token)!;
			const header = new RegExp(`^ {2}(?:-[A-Za-z], )?${option.long}\\b|^ {6}${option.long}\\b`);
			const mutated = text
				.split('\n')
				.filter((line) => !header.test(line))
				.join('\n');
			expect(missingFlags(parseHelp(mutated), [token]), token).toEqual([token]);
		}
	});
});

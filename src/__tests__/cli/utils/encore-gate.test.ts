/**
 * @file encore-gate.test.ts
 * @description A switched-off Encore Feature leaves no footprint in maestro-cli:
 * its verbs are hidden from help, `reference` and `completions`, running one
 * refuses with the line that turns it back on, and its options on a core verb
 * are refused too.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { Command } from 'commander';

vi.mock('../../../cli/services/storage', () => ({ readSettingValue: vi.fn() }));

import {
	allowWhileEncoreOff,
	encoreCommand,
	encoreDisabledCode,
	encoreDisabledMessage,
	encoreFeatureCliName,
	encoreFeatureName,
	listedSubcommands,
	readEncoreFlagsForHelp,
	requireEncore,
	requireEncoreForOptions,
} from '../../../cli/utils/encore-gate';
import { readSettingValue } from '../../../cli/services/storage';
import { ENCORE_FEATURE_DEFAULTS } from '../../../shared/encoreFeatureDefaults';

let logSpy: MockInstance;
let errSpy: MockInstance;

beforeEach(() => {
	vi.clearAllMocks();
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => vi.restoreAllMocks());

describe('naming', () => {
	it('names every flag the app knows', () => {
		for (const flag of Object.keys(ENCORE_FEATURE_DEFAULTS) as Array<
			keyof typeof ENCORE_FEATURE_DEFAULTS
		>) {
			expect(encoreFeatureName(flag), flag).toBeTruthy();
		}
		expect(encoreFeatureName('maestroCue')).toBe('Maestro Cue');
	});

	it('spells a flag the way `encore enable` and the JSON code expect', () => {
		expect(encoreFeatureCliName('computerHistory')).toBe('computer-history');
		expect(encoreDisabledCode('computerHistory')).toBe('COMPUTER_HISTORY_DISABLED');
		expect(encoreDisabledCode('pianola')).toBe('PIANOLA_DISABLED');
		expect(encoreDisabledMessage('groupsPlus')).toBe(
			'Groups+ is turned off. Turn it on in Settings > Plugins, or run: maestro-cli encore enable groups-plus'
		);
	});
});

describe('requireEncore', () => {
	it('passes when the flag is on, and reads a never-saved flag at its default', () => {
		vi.mocked(readSettingValue).mockReturnValue(undefined);
		expect(() => requireEncore('maestroCue')).not.toThrow();
		vi.mocked(readSettingValue).mockReturnValue({ concerto: true });
		expect(() => requireEncore('concerto')).not.toThrow();
	});

	it('refuses with the turn-it-on line when the flag is off', () => {
		vi.mocked(readSettingValue).mockReturnValue({ maestroCue: false });
		expect(() => requireEncore('maestroCue')).toThrow('__exit__');
		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Settings > Plugins'));
	});

	it('answers --json with a code', () => {
		vi.mocked(readSettingValue).mockReturnValue(undefined);
		expect(() => requireEncore('concerto', true)).toThrow('__exit__');
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
			success: false,
			code: 'CONCERTO_DISABLED',
		});
	});
});

describe('readEncoreFlagsForHelp', () => {
	it('shows the defaults when the settings file cannot be read', () => {
		vi.mocked(readSettingValue).mockImplementation(() => {
			throw new SyntaxError('Unexpected token');
		});
		expect(readEncoreFlagsForHelp()).toEqual(ENCORE_FEATURE_DEFAULTS);
	});
});

describe('encoreCommand', () => {
	function build(flags: Partial<typeof ENCORE_FEATURE_DEFAULTS>) {
		const program = new Command().exitOverride();
		const ran: string[] = [];
		const cue = encoreCommand(program, 'cue', 'maestroCue', {
			...ENCORE_FEATURE_DEFAULTS,
			...flags,
		});
		cue
			.command('list')
			.option('--json')
			.action(() => {
				ran.push('list');
			});
		allowWhileEncoreOff(
			cue.command('stop').action(() => {
				ran.push('stop');
			})
		);
		program.command('send').action(() => {
			ran.push('send');
		});
		return { program, ran };
	}

	it('is listed while the feature is on and hidden while it is off', () => {
		const names = (program: Command) => listedSubcommands(program).map((c) => c.name());
		expect(names(build({ maestroCue: true }).program)).toEqual(['cue', 'send']);
		expect(names(build({ maestroCue: false }).program)).toEqual(['send']);
		expect(
			listedSubcommands(build({ maestroCue: false }).program, true).map((c) => c.name())
		).toEqual(['cue', 'send']);
	});

	it('refuses every verb beneath it while the flag is off, even invoked directly', async () => {
		vi.mocked(readSettingValue).mockReturnValue({ maestroCue: false });
		const { program, ran } = build({ maestroCue: false });
		await expect(program.parseAsync(['node', 'cli', 'cue', 'list', '--json'])).rejects.toThrow(
			'__exit__'
		);
		expect(ran).toEqual([]);
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
			code: 'MAESTRO_CUE_DISABLED',
		});
	});

	it('runs once the flag is on, and never gates a core verb', async () => {
		vi.mocked(readSettingValue).mockReturnValue({ maestroCue: true });
		const { program, ran } = build({ maestroCue: true });
		await program.parseAsync(['node', 'cli', 'cue', 'list']);
		await program.parseAsync(['node', 'cli', 'send']);
		expect(ran).toEqual(['list', 'send']);
	});

	it('lets a verb that only takes a footprint away run while the flag is off', async () => {
		vi.mocked(readSettingValue).mockReturnValue({ maestroCue: false });
		const { program, ran } = build({ maestroCue: false });
		await program.parseAsync(['node', 'cli', 'cue', 'stop']);
		expect(ran).toEqual(['stop']);
	});
});

describe('requireEncoreForOptions', () => {
	const OWNED = ['icon', 'parent', 'clearParent'] as const;

	it('ignores a call that uses none of the feature options', () => {
		vi.mocked(readSettingValue).mockReturnValue({ groupsPlus: false });
		expect(() => requireEncoreForOptions('groupsPlus', { emoji: 'x' }, OWNED)).not.toThrow();
	});

	it('refuses a feature option while the feature is off', () => {
		vi.mocked(readSettingValue).mockReturnValue({ groupsPlus: false });
		expect(() =>
			requireEncoreForOptions('groupsPlus', { clearParent: true, json: true }, OWNED)
		).toThrow('__exit__');
		expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
			code: 'GROUPS_PLUS_DISABLED',
		});
	});

	it('accepts it once the feature is on', () => {
		vi.mocked(readSettingValue).mockReturnValue({ groupsPlus: true });
		expect(() => requireEncoreForOptions('groupsPlus', { parent: 'g1' }, OWNED)).not.toThrow();
	});
});

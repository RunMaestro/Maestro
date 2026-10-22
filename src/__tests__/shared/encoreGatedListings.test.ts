/**
 * @file encoreGatedListings.test.ts
 * @description A switched-off Encore Feature leaves no entry in the lists the
 * user browses: its prompts in Settings -> Maestro Prompts and its template
 * variables in the pickers.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CORE_PROMPTS, isPromptAvailable } from '../../shared/promptDefinitions';
import { TEMPLATE_VARIABLES, availableTemplateVariables } from '../../shared/templateVariables';
import { ENCORE_FEATURE_DEFAULTS } from '../../shared/encoreFeatureDefaults';
import { MAESTRO_CUE_FIRST_PARTY_PLUGIN } from '../../shared/plugins/first-party';

const allFlags = (value: boolean) =>
	Object.fromEntries(Object.keys(ENCORE_FEATURE_DEFAULTS).map((key) => [key, value]));

describe('isPromptAvailable', () => {
	it('hides every Encore-owned prompt while its feature is off', () => {
		const owned = CORE_PROMPTS.filter((def) => def.encoreFlag);
		expect(owned.map((def) => def.id)).toEqual(
			expect.arrayContaining([
				'pianola-system',
				'computer-history-system',
				'concerto-system',
				'maestro-run-system',
				'director-notes',
				'_maestro-cue',
				'cue-system',
				'_concerto',
			])
		);
		for (const def of owned) {
			expect(isPromptAvailable(def.id, allFlags(false)), def.id).toBe(false);
			expect(isPromptAvailable(def.id, allFlags(true)), def.id).toBe(true);
			expect(ENCORE_FEATURE_DEFAULTS, def.id).toHaveProperty(def.encoreFlag!);
		}
	});

	it('always lists core prompts and unknown (plugin) ids', () => {
		expect(isPromptAvailable('maestro-system-prompt', allFlags(false))).toBe(true);
		expect(isPromptAvailable('some.plugin/prompt', allFlags(false))).toBe(true);
	});

	it('reads a missing flag map as the defaults', () => {
		// Maestro Cue defaults on, Computer History defaults off.
		expect(isPromptAvailable('_maestro-cue', undefined)).toBe(true);
		expect(isPromptAvailable('computer-history-system', undefined)).toBe(false);
	});
});

describe('availableTemplateVariables', () => {
	const names = (flags: unknown) =>
		availableTemplateVariables(TEMPLATE_VARIABLES, flags).map((v) => v.variable);

	it('drops the variables of switched-off features and nothing else', () => {
		const off = names(allFlags(false));
		expect(off).not.toContain('{{COMPUTER_HISTORY_DIR}}');
		expect(off).not.toContain('{{MAESTRO_RUN_PATH}}');
		expect(off.some((name) => name.startsWith('{{CUE_'))).toBe(false);
		expect(off).toContain('{{AGENT_NAME}}');
		expect(off).toContain('{{AUTORUN_FOLDER}}');
	});

	it('lists everything when every feature is on', () => {
		expect(names(allFlags(true))).toEqual(TEMPLATE_VARIABLES.map((v) => v.variable));
	});
});

describe('the base system prompt', () => {
	const prompts = join(__dirname, '..', '..', 'prompts');
	const read = (file: string) => readFileSync(join(prompts, file), 'utf8').replace(/\r\n/g, '\n');
	// What every agent reads, whatever the user has switched on.
	const ALWAYS_ON = [
		'maestro-system-prompt.md',
		'_maestro-cli.md',
		'_interface-primitives.md',
		'_documentation-index.md',
		'_toc.md',
		'_autorun-playbooks.md',
	];

	it('does not tell every agent to use Concerto', () => {
		const base = read('maestro-system-prompt.md');
		const section = read('concerto-system.md');
		expect(base).not.toMatch(/use Concerto proactively/i);
		expect(section).toMatch(/use Concerto proactively/i);
	});

	it('says nothing about Cue, Concerto, or the stats verbs outside their gated prompts', () => {
		for (const file of ALWAYS_ON) {
			const text = read(file);
			expect(text, file).not.toMatch(/\bcue\b/i);
			expect(text, file).not.toMatch(/cadenza|movement add|concerto/i);
			expect(text, file).not.toMatch(/stats-query|director-notes/);
			// No upsell: an agent is never told to offer switching a feature back on.
			expect(text, file).not.toMatch(/offer to (flip|re-enable|enable)/i);
		}
	});

	it('moves Cue duties, scheduling, and routing into the gated Cue section', () => {
		expect(MAESTRO_CUE_FIRST_PARTY_PLUGIN.systemPromptSection?.promptId).toBe('cue-system');
		expect(CORE_PROMPTS.find((def) => def.id === 'cue-system')?.encoreFlag).toBe('maestroCue');
		const section = read('cue-system.md');
		expect(section).toContain('**Identity & responsibilities:**');
		expect(section).toContain('{{MAESTRO_CLI_PATH}} cue list --json');
		expect(section).toContain('cue schedule');
		expect(section).toContain('{{REF:_maestro-cue}}');
		// With Cue off, the base prompt's duty answer stands on its own.
		expect(read('maestro-system-prompt.md')).toMatch(/no scheduled or automated duties/);
	});

	it('keeps the Concerto workflow in a gated include the Concerto section points at', () => {
		expect(CORE_PROMPTS.find((def) => def.id === '_concerto')?.encoreFlag).toBe('concerto');
		expect(read('concerto-system.md')).toContain('{{REF:_concerto}}');
		const guide = read('_concerto.md');
		expect(guide).toContain('#### Required designer feedback loop');
		expect(guide).toContain('maestro-cli cadenza open');
		expect(guide).toContain('maestro-cli movement add');
	});
});

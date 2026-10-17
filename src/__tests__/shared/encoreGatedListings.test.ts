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

const allFlags = (value: boolean) =>
	Object.fromEntries(Object.keys(ENCORE_FEATURE_DEFAULTS).map((key) => [key, value]));

describe('isPromptAvailable', () => {
	it('hides every Encore-owned prompt while its feature is off', () => {
		const owned = CORE_PROMPTS.filter((def) => def.encoreFlag);
		expect(owned.map((def) => def.id)).toEqual(
			expect.arrayContaining([
				'pianola-system',
				'computer-history-system',
				'computer-history-digest-local',
				'concerto-system',
				'maestro-run-system',
				'director-notes',
				'_maestro-cue',
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
	it('does not tell every agent to use Concerto', () => {
		const prompts = join(__dirname, '..', '..', 'prompts');
		const base = readFileSync(join(prompts, 'maestro-system-prompt.md'), 'utf8');
		const section = readFileSync(join(prompts, 'concerto-system.md'), 'utf8');
		expect(base).not.toMatch(/use Concerto proactively/i);
		expect(section).toMatch(/use Concerto proactively/i);
	});
});

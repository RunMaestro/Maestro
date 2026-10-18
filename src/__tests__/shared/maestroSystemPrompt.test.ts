/**
 * @file maestroSystemPrompt.test.ts
 * @description The one Maestro system prompt assembler shared by the renderer,
 * CLI, and main-process builders: which plugin sections apply, and how the
 * base template and sections are substituted and joined.
 */

import { describe, it, expect } from 'vitest';
import {
	assembleMaestroSystemPrompt,
	systemPromptSectionsFor,
	MAESTRO_SYSTEM_PROMPT_SECTION_SEPARATOR,
} from '../../shared/maestroSystemPrompt';
import {
	FIRST_PARTY_PLUGIN_DEFINITIONS,
	COMPUTER_HISTORY_FIRST_PARTY_PLUGIN,
	MAESTRO_CUE_FIRST_PARTY_PLUGIN,
	MAESTRO_RUN_FIRST_PARTY_PLUGIN,
} from '../../shared/plugins/first-party';
import type { TemplateContext } from '../../shared/templateVariables';

// Maestro Cue ships on and carries a section; the cases about other plugins
// switch it off so each asserts only the section it is about.
const CUE_OFF = { maestroCue: false };

const context: TemplateContext = {
	session: { id: 'agent-1', name: 'Alice', toolType: 'claude-code', cwd: '/proj' },
	computerHistoryDir: '/data/computer-history',
};

describe('systemPromptSectionsFor', () => {
	it('returns the Computer History section when its flag is on (local agent)', () => {
		expect(
			systemPromptSectionsFor({ ...CUE_OFF, computerHistory: true }, { isSsh: false })
		).toEqual([
			{ pluginId: COMPUTER_HISTORY_FIRST_PARTY_PLUGIN.id, promptId: 'computer-history-system' },
		]);
	});

	// Concerto ships OFF. Its routing section used to sit in the base prompt, so
	// every agent was told to answer on a stage that dropped the payload.
	it('carries the Concerto routing section only while Concerto is on, SSH included', () => {
		const ids = (flags: unknown, isSsh: boolean) =>
			systemPromptSectionsFor(flags, { isSsh }).map((ref) => ref.promptId);
		expect(ids({ ...CUE_OFF, concerto: true }, false)).toEqual(['concerto-system']);
		expect(ids({ ...CUE_OFF, concerto: true }, true)).toEqual(['concerto-system']);
		expect(ids({ ...CUE_OFF, concerto: false }, false)).toEqual([]);
		expect(ids(CUE_OFF, false)).toEqual([]);
	});

	// Scheduling and the "what are my duties?" lookup used to sit in the base
	// prompt, so an agent with Cue off still answered in terms of Cue.
	it('carries the Maestro Cue section only while Cue is on, SSH included', () => {
		const ids = (flags: unknown, isSsh: boolean) =>
			systemPromptSectionsFor(flags, { isSsh }).map((ref) => ref.promptId);
		expect(ids({ maestroCue: true }, false)).toEqual(['cue-system']);
		expect(ids({ maestroCue: true }, true)).toEqual(['cue-system']);
		expect(ids(CUE_OFF, false)).toEqual([]);
	});

	// The Cue section is about an agent's own duties; a moderator has none.
	it('leaves agent-only sections out of a sections-only spawn', () => {
		const ids = (sectionsOnly: boolean) =>
			systemPromptSectionsFor(
				{ maestroCue: true, concerto: true },
				{ isSsh: false, sectionsOnly }
			).map((ref) => ref.promptId);
		expect(ids(false)).toEqual(expect.arrayContaining(['cue-system', 'concerto-system']));
		expect(ids(true)).toContain('concerto-system');
		expect(ids(true)).not.toContain('cue-system');
	});

	it('returns nothing when the flag is off', () => {
		expect(
			systemPromptSectionsFor({ ...CUE_OFF, computerHistory: false }, { isSsh: false })
		).toEqual([]);
	});

	it('falls back to defaults for missing keys and junk input (Cue on, Computer History off)', () => {
		const defaults = [{ pluginId: MAESTRO_CUE_FIRST_PARTY_PLUGIN.id, promptId: 'cue-system' }];
		expect(systemPromptSectionsFor({}, { isSsh: false })).toEqual(defaults);
		expect(systemPromptSectionsFor(undefined, { isSsh: false })).toEqual(defaults);
		expect(systemPromptSectionsFor('nonsense', { isSsh: false })).toEqual(defaults);
		// A non-boolean value never turns a feature on.
		expect(systemPromptSectionsFor({ computerHistory: 'yes' }, { isSsh: false })).toEqual(defaults);
	});

	it('skips localOnly sections for SSH agents', () => {
		expect(COMPUTER_HISTORY_FIRST_PARTY_PLUGIN.systemPromptSection?.localOnly).toBe(true);
		expect(systemPromptSectionsFor({ ...CUE_OFF, computerHistory: true }, { isSsh: true })).toEqual(
			[]
		);
	});

	it('only ever yields plugins that declare a section, in registry order', () => {
		const allOn = Object.fromEntries(
			FIRST_PARTY_PLUGIN_DEFINITIONS.map((def) => [def.encoreFlag, true])
		);
		const allReady = FIRST_PARTY_PLUGIN_DEFINITIONS.map((def) => def.encoreFlag);
		const expected = FIRST_PARTY_PLUGIN_DEFINITIONS.filter((def) => def.systemPromptSection).map(
			(def) => def.systemPromptSection!.promptId
		);
		expect(
			systemPromptSectionsFor(allOn, { isSsh: false, readyFlags: allReady }).map(
				(ref) => ref.promptId
			)
		).toEqual(expected);
	});

	describe('a section that requires its feature to be ready (MaestroRun)', () => {
		const section = { pluginId: MAESTRO_RUN_FIRST_PARTY_PLUGIN.id, promptId: 'maestro-run-system' };

		it('declares the gate', () => {
			expect(MAESTRO_RUN_FIRST_PARTY_PLUGIN.systemPromptSection).toEqual({
				promptId: 'maestro-run-system',
				localOnly: true,
				requiresReady: true,
			});
		});

		it('is left out when the flag is on but the builder did not vouch for it', () => {
			// Enabling the tile is not enough: the launcher is not installed or not granted yet.
			expect(systemPromptSectionsFor({ ...CUE_OFF, maestroRun: true }, { isSsh: false })).toEqual(
				[]
			);
			expect(
				systemPromptSectionsFor({ ...CUE_OFF, maestroRun: true }, { isSsh: false, readyFlags: [] })
			).toEqual([]);
		});

		it('is included once the builder names it ready', () => {
			expect(
				systemPromptSectionsFor(
					{ ...CUE_OFF, maestroRun: true },
					{ isSsh: false, readyFlags: ['maestroRun'] }
				)
			).toEqual([section]);
		});

		it('stays out when ready but the flag is off, or the agent is on an SSH remote', () => {
			expect(
				systemPromptSectionsFor(
					{ ...CUE_OFF, maestroRun: false },
					{ isSsh: false, readyFlags: ['maestroRun'] }
				)
			).toEqual([]);
			expect(
				systemPromptSectionsFor(
					{ ...CUE_OFF, maestroRun: true },
					{ isSsh: true, readyFlags: ['maestroRun'] }
				)
			).toEqual([]);
		});

		it('does not gate a section that never asked for it', () => {
			expect(
				systemPromptSectionsFor({ ...CUE_OFF, computerHistory: true }, { isSsh: false })
			).toHaveLength(1);
		});
	});
});

describe('assembleMaestroSystemPrompt', () => {
	it('substitutes the base template alone when there are no sections', () => {
		expect(assembleMaestroSystemPrompt({ template: 'Hi {{AGENT_NAME}}', context })).toBe(
			'Hi Alice'
		);
	});

	it('appends role sections before plugin sections with the shared separator', () => {
		const result = assembleMaestroSystemPrompt({
			template: 'BASE',
			context,
			roleSections: ['ROLE'],
			pluginSections: ['PLUGIN'],
		});
		const sep = MAESTRO_SYSTEM_PROMPT_SECTION_SEPARATOR;
		expect(sep).toBe('\n\n---\n\n');
		expect(result).toBe(`BASE${sep}ROLE${sep}PLUGIN`);
	});

	it('substitutes every section with the same context, including COMPUTER_HISTORY_DIR', () => {
		const result = assembleMaestroSystemPrompt({
			template: 'BASE {{AGENT_ID}}',
			context,
			pluginSections: ['Store: {{COMPUTER_HISTORY_DIR}} for {{AGENT_NAME}}'],
		});
		expect(result).toBe('BASE agent-1\n\n---\n\nStore: /data/computer-history for Alice');
	});

	it('renders COMPUTER_HISTORY_DIR empty when the builder did not supply it (SSH)', () => {
		const result = assembleMaestroSystemPrompt({
			template: '[{{COMPUTER_HISTORY_DIR}}]',
			context: { ...context, computerHistoryDir: undefined },
		});
		expect(result).toBe('[]');
	});

	it('skips missing, empty, and whitespace-only sections without stray separators', () => {
		const result = assembleMaestroSystemPrompt({
			template: 'BASE',
			context,
			roleSections: [undefined, null],
			pluginSections: ['', '   \n', 'KEEP'],
		});
		expect(result).toBe('BASE\n\n---\n\nKEEP');
	});

	it('skips a section that substitutes to blank', () => {
		const result = assembleMaestroSystemPrompt({
			template: 'BASE',
			context: { ...context, computerHistoryDir: undefined },
			pluginSections: ['{{COMPUTER_HISTORY_DIR}}'],
		});
		expect(result).toBe('BASE');
	});
});

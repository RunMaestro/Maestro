/**
 * @file maestroSystemPrompt.test.ts
 * @description The one Maestro system prompt assembler shared by the renderer,
 * CLI, and main-process builders: which plugin sections and which core
 * sections apply, and how the base template and sections are substituted and
 * joined.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
	assembleMaestroSystemPrompt,
	coreSystemPromptContext,
	coreSystemPromptSectionsFor,
	systemPromptSectionsFor,
	MAESTRO_SYSTEM_PROMPT_SECTION_SEPARATOR,
} from '../../shared/maestroSystemPrompt';
import {
	SYSTEM_ONE_CALIBRATED_NOTE,
	SYSTEM_ONE_UNCALIBRATED_NOTE,
} from '../../shared/local-models/system-one-prompt';
import { PROMPT_IDS } from '../../shared/promptDefinitions';
import {
	SYSTEM_ONE_GATES,
	refusedSystemOneAccess,
	systemOneAccess,
} from '../helpers/systemOneAccess';
import {
	FIRST_PARTY_PLUGIN_DEFINITIONS,
	COMPUTER_HISTORY_FIRST_PARTY_PLUGIN,
	MAESTRO_RUN_FIRST_PARTY_PLUGIN,
} from '../../shared/plugins/first-party';
import type { TemplateContext } from '../../shared/templateVariables';

const context: TemplateContext = {
	session: { id: 'agent-1', name: 'Alice', toolType: 'claude-code', cwd: '/proj' },
	computerHistoryDir: '/data/computer-history',
};

describe('systemPromptSectionsFor', () => {
	it('returns the Computer History section when its flag is on (local agent)', () => {
		expect(systemPromptSectionsFor({ computerHistory: true }, { isSsh: false })).toEqual([
			{ pluginId: COMPUTER_HISTORY_FIRST_PARTY_PLUGIN.id, promptId: 'computer-history-system' },
		]);
	});

	// Concerto ships OFF. Its routing section used to sit in the base prompt, so
	// every agent was told to answer on a stage that dropped the payload.
	it('carries the Concerto routing section only while Concerto is on, SSH included', () => {
		const ids = (flags: unknown, isSsh: boolean) =>
			systemPromptSectionsFor(flags, { isSsh }).map((ref) => ref.promptId);
		expect(ids({ concerto: true }, false)).toEqual(['concerto-system']);
		expect(ids({ concerto: true }, true)).toEqual(['concerto-system']);
		expect(ids({ concerto: false }, false)).toEqual([]);
		expect(ids({}, false)).toEqual([]);
	});

	it('returns nothing when the flag is off', () => {
		expect(systemPromptSectionsFor({ computerHistory: false }, { isSsh: false })).toEqual([]);
	});

	it('falls back to defaults for missing keys and junk input (Computer History defaults off)', () => {
		expect(systemPromptSectionsFor({}, { isSsh: false })).toEqual([]);
		expect(systemPromptSectionsFor(undefined, { isSsh: false })).toEqual([]);
		expect(systemPromptSectionsFor('nonsense', { isSsh: false })).toEqual([]);
		// A non-boolean value never turns a feature on.
		expect(systemPromptSectionsFor({ computerHistory: 'yes' }, { isSsh: false })).toEqual([]);
	});

	it('skips localOnly sections for SSH agents', () => {
		expect(COMPUTER_HISTORY_FIRST_PARTY_PLUGIN.systemPromptSection?.localOnly).toBe(true);
		expect(systemPromptSectionsFor({ computerHistory: true }, { isSsh: true })).toEqual([]);
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
			expect(systemPromptSectionsFor({ maestroRun: true }, { isSsh: false })).toEqual([]);
			expect(
				systemPromptSectionsFor({ maestroRun: true }, { isSsh: false, readyFlags: [] })
			).toEqual([]);
		});

		it('is included once the builder names it ready', () => {
			expect(
				systemPromptSectionsFor({ maestroRun: true }, { isSsh: false, readyFlags: ['maestroRun'] })
			).toEqual([section]);
		});

		it('stays out when ready but the flag is off, or the agent is on an SSH remote', () => {
			expect(
				systemPromptSectionsFor({ maestroRun: false }, { isSsh: false, readyFlags: ['maestroRun'] })
			).toEqual([]);
			expect(
				systemPromptSectionsFor({ maestroRun: true }, { isSsh: true, readyFlags: ['maestroRun'] })
			).toEqual([]);
		});

		it('does not gate a section that never asked for it', () => {
			expect(systemPromptSectionsFor({ computerHistory: true }, { isSsh: false })).toHaveLength(1);
		});
	});
});

describe('coreSystemPromptSectionsFor', () => {
	const systemOneSection = { featureId: 'system-one', promptId: 'system-one-system' };

	it('carries the System One section when every gate passes for a local agent', () => {
		expect(coreSystemPromptSectionsFor({ isSsh: false, systemOne: systemOneAccess() })).toEqual([
			systemOneSection,
		]);
		expect(PROMPT_IDS.SYSTEM_ONE_SYSTEM).toBe(systemOneSection.promptId);
	});

	it('carries it on an engine that is not calibrated too: the section says so', () => {
		const access = systemOneAccess({
			engine: 'local-judge',
			engineLabel: 'Local judge, not calibrated',
			calibrated: false,
		});
		expect(coreSystemPromptSectionsFor({ isSsh: false, systemOne: access })).toEqual([
			systemOneSection,
		]);
	});

	it('leaves it out behind each gate that refuses the agent', () => {
		for (const gate of SYSTEM_ONE_GATES) {
			const input = { isSsh: false, systemOne: refusedSystemOneAccess(gate) };
			expect(coreSystemPromptSectionsFor(input), gate).toEqual([]);
			expect(coreSystemPromptContext(input), gate).toEqual({});
		}
	});

	it('leaves it out for an SSH remote agent even when every gate passes', () => {
		const input = { isSsh: true, systemOne: systemOneAccess() };
		expect(coreSystemPromptSectionsFor(input)).toEqual([]);
		expect(coreSystemPromptContext(input)).toEqual({});
	});

	it('leaves it out when the builder could not ask', () => {
		expect(coreSystemPromptSectionsFor({ isSsh: false })).toEqual([]);
		expect(coreSystemPromptSectionsFor({ isSsh: false, systemOne: null })).toEqual([]);
		expect(coreSystemPromptContext({ isSsh: false })).toEqual({});
	});

	it('fills the context from the same answer the section was decided on', () => {
		const input = { isSsh: false, systemOne: systemOneAccess() };
		expect(coreSystemPromptContext(input)).toEqual({
			systemOne: {
				engine: 'Jev (TypeSafe cloud)',
				calibrated: SYSTEM_ONE_CALIBRATED_NOTE,
				budget: '$1.00 a day across all agents; more than half is left today',
			},
		});
	});
});

describe('the System One section, assembled from the real prompt', () => {
	const section = fs.readFileSync(
		path.resolve(__dirname, '../../prompts/system-one-system.md'),
		'utf-8'
	);
	const assemble = (systemOne: ReturnType<typeof systemOneAccess>, isSsh = false) => {
		const core = { isSsh, systemOne };
		return assembleMaestroSystemPrompt({
			template: 'BASE',
			context: {
				...context,
				maestroCliPath: '/app/maestro-cli.js',
				...coreSystemPromptContext(core),
			},
			// A builder loads one text per ref; the file stands in for the loader here.
			coreSections: coreSystemPromptSectionsFor(core).map(() => section),
		});
	};

	it('names the engine, its calibration, the budget and the one pointer', () => {
		const result = assemble(systemOneAccess());
		expect(result).toContain('## System One');
		expect(result).toContain(`**Engine:** Jev (TypeSafe cloud), ${SYSTEM_ONE_CALIBRATED_NOTE}.`);
		expect(result).toContain(
			'**Budget:** $1.00 a day across all agents; more than half is left today.'
		);
		expect(result).toContain('run `node "/app/maestro-cli.js" s1 guide` once per session');
		// Every variable the section names was filled.
		expect(result).not.toMatch(/\{\{(?!REF:)/);
	});

	it('tells an agent on the local judge that its numbers are not probabilities', () => {
		const result = assemble(
			systemOneAccess({
				engine: 'local-judge',
				engineLabel: 'Local judge (qwen), not calibrated',
				calibrated: false,
			})
		);
		expect(result).toContain(
			`**Engine:** Local judge (qwen), not calibrated, ${SYSTEM_ONE_UNCALIBRATED_NOTE}.`
		);
		expect(result).not.toContain(SYSTEM_ONE_CALIBRATED_NOTE);
	});

	it('is absent behind every gate, and for an SSH remote agent', () => {
		for (const gate of SYSTEM_ONE_GATES) {
			expect(assemble(refusedSystemOneAccess(gate)), gate).toBe('BASE');
		}
		expect(assemble(systemOneAccess(), true)).toBe('BASE');
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

	it('places core sections after the role sections and before the plugin sections', () => {
		const result = assembleMaestroSystemPrompt({
			template: 'BASE',
			context,
			roleSections: ['ROLE'],
			coreSections: ['CORE'],
			pluginSections: ['PLUGIN'],
		});
		const sep = MAESTRO_SYSTEM_PROMPT_SECTION_SEPARATOR;
		expect(result).toBe(`BASE${sep}ROLE${sep}CORE${sep}PLUGIN`);
	});

	it('renders the System One variables empty when no builder supplied them', () => {
		const result = assembleMaestroSystemPrompt({
			template: '[{{SYSTEM_ONE_ENGINE}}|{{SYSTEM_ONE_CALIBRATED}}|{{SYSTEM_ONE_BUDGET}}]',
			context,
		});
		expect(result).toBe('[||]');
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

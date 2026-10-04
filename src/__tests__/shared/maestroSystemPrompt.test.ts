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
		const expected = FIRST_PARTY_PLUGIN_DEFINITIONS.filter((def) => def.systemPromptSection).map(
			(def) => def.systemPromptSection!.promptId
		);
		expect(systemPromptSectionsFor(allOn, { isSsh: false }).map((ref) => ref.promptId)).toEqual(
			expected
		);
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

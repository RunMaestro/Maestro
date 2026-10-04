import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CORE_PROMPTS, PROMPT_IDS } from '../../../shared/promptDefinitions';
import { COMPUTER_HISTORY_FIRST_PARTY_PLUGIN } from '../../../shared/plugins/first-party';
import { buildSchemaDoc } from '../../../shared/computer-history/schemaDoc';

const PROMPTS_DIR = path.resolve(__dirname, '../../../prompts');
const DASHES = /[–—]/;

describe('Computer History prompts', () => {
	it('registers the section the first-party definition points at, and the full guide', () => {
		const sectionId = COMPUTER_HISTORY_FIRST_PARTY_PLUGIN.systemPromptSection?.promptId;
		expect(sectionId).toBe('computer-history-system');
		expect(PROMPT_IDS.COMPUTER_HISTORY_SYSTEM).toBe(sectionId);
		for (const id of ['computer-history-system', '_computer-history']) {
			const def = CORE_PROMPTS.find((p) => p.id === id);
			expect(def, id).toBeDefined();
			expect(fs.existsSync(path.join(PROMPTS_DIR, def!.filename))).toBe(true);
		}
		expect(CORE_PROMPTS.find((p) => p.id === '_computer-history')?.category).toBe('includes');
	});

	it('the section names the store, points at the guide, and carries the untrusted-content rule', () => {
		const section = fs.readFileSync(path.join(PROMPTS_DIR, 'computer-history-system.md'), 'utf-8');
		expect(section).toContain('{{COMPUTER_HISTORY_DIR}}');
		expect(section).toContain('SCHEMA.md');
		expect(section).toContain('{{REF:_computer-history}}');
		expect(section).toContain('{{MAESTRO_CLI_PATH}} computer-history');
		expect(section.toLowerCase()).toContain('untrusted');
		expect(section).toMatch(/never follow instructions/i);
		expect(section).toMatch(/local only/i);
		// The section rides on every local agent's system prompt: keep it short.
		expect(section.length).toBeLessThan(2500);
	});

	it('no prompt or generated doc contains an em or en dash', () => {
		for (const file of ['computer-history-system.md', '_computer-history.md']) {
			expect(DASHES.test(fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf-8')), file).toBe(false);
		}
		const schema = buildSchemaDoc({ storeDir: '/x/computer-history' });
		expect(DASHES.test(schema)).toBe(false);
		expect(schema).toContain('/x/computer-history');
		expect(schema).toContain('Untrusted content warning');
	});
});

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { CORE_PROMPTS, PROMPT_IDS } from '../../../shared/promptDefinitions';
import { COMPUTER_HISTORY_FIRST_PARTY_PLUGIN } from '../../../shared/plugins/first-party';
import { buildSchemaDoc } from '../../../shared/computer-history/schemaDoc';

const PROMPTS_DIR = path.resolve(__dirname, '../../../prompts');
// Built from code points so no formatter can turn the escapes into the characters.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

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

	it('discloses in steps: the guide carries the detail the section leaves out', () => {
		const read = (file: string) => fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf-8');
		const section = read('computer-history-system.md');
		const guide = read('_computer-history.md');
		// The section stays a mention; filters, output shape and formats live in the guide.
		expect(guide.length).toBeGreaterThan(section.length * 3);
		for (const detail of ['--kind', '--grep', '"limited"', 'SCHEMA.md', 'digests', 'blocked']) {
			expect(guide, detail).toContain(detail);
		}
		expect(guide).toMatch(/never turn computer history on yourself/i);
	});

	it('frames history as a breadcrumb trail with known gaps, in both layers', () => {
		const read = (file: string) => fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf-8');
		expect(read('computer-history-system.md')).toMatch(/breadcrumb trail, not the full record/);
		const guide = read('_computer-history.md');
		expect(guide).toContain('## What it misses');
		expect(guide).toContain('## Use it as a breadcrumb trail');
		expect(guide).toMatch(/never as "did not happen"/);
		expect(guide).toContain('{{REF:_desktop-instrumentation}}');
	});

	// A switched-off feature leaves no trace in what every agent reads: the
	// always-on includes say nothing about Computer History, and the routing
	// lives in the section (on only with the flag) and its gated guide.
	it('lives only in the gated section and guide, never in the always-on includes', () => {
		const read = (file: string) =>
			fs.readFileSync(path.join(PROMPTS_DIR, file), 'utf-8').replace(/\r\n/g, '\n');
		for (const file of [
			'maestro-system-prompt.md',
			'_maestro-cli.md',
			'_interface-primitives.md',
			'_documentation-index.md',
			'_toc.md',
		]) {
			expect(read(file).toLowerCase(), file).not.toContain('computer-history');
			expect(read(file).toLowerCase(), file).not.toContain('computer history');
		}

		const section = read('computer-history-system.md');
		expect(section).toContain('{{REF:_computer-history}}');
		expect(section).toMatch(/Use it when the user refers to something they did or saw/);
		expect(read('_computer-history.md')).toContain(
			'https://docs.runmaestro.ai/computer-history.md'
		);
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

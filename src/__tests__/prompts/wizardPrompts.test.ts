import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const promptPaths = [
	'src/prompts/wizard-document-generation.md',
	'src/prompts/wizard-inline-iterate-generation.md',
	'src/prompts/wizard-system.md',
];

describe('wizard prompt sources', () => {
	it('do not contain executable unchecked Auto Run tasks', () => {
		for (const promptPath of promptPaths) {
			const content = fs.readFileSync(path.join(process.cwd(), promptPath), 'utf8');

			expect(content, promptPath).not.toMatch(/^- \[ \]/m);
		}
	});

	it('keeps the project name as a template variable', () => {
		const content = fs.readFileSync(
			path.join(process.cwd(), 'src/prompts/wizard-document-generation.md'),
			'utf8'
		);

		expect(content).toContain('{{PROJECT_NAME}}');
		expect(content).not.toContain('RunMaestro-Maestro-457');
	});
});

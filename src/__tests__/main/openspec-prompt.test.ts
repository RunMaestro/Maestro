import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('openspec implement prompt', () => {
	it('documents the Maestro BEGIN/END envelope required for generated Auto Run documents', () => {
		const promptPath = path.join(process.cwd(), 'src/prompts/openspec/openspec.implement.md');
		const prompt = fs.readFileSync(promptPath, 'utf8');

		const formatBlock = prompt.match(
			/Each generated document block MUST follow this exact format:[\s\S]*?```markdown\n([\s\S]*?)\n```/
		);

		expect(formatBlock?.[1]).toContain('---BEGIN DOCUMENT---');
		expect(formatBlock?.[1]).toContain('FILENAME: OpenSpec-<change-id>-Phase-XX-[Description].md');
		expect(formatBlock?.[1]).toContain('CONTENT:\n# Phase XX: [Brief Title]');
		expect(formatBlock?.[1]).toContain('---END DOCUMENT---');
	});
});

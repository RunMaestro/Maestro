import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real highlight.js scores the snippets; only the Shiki alias lookup is
// stubbed so the test does not load Shiki's grammar bundle.
vi.mock('../../../../renderer/utils/shiki/highlighterManager', () => ({
	resolveLanguage: vi.fn(async (lang: string) => lang),
}));

import { detectLanguage, __resetForTests } from '../../../../renderer/utils/shiki/languageDetect';

describe('detectLanguage', () => {
	beforeEach(() => {
		__resetForTests();
	});

	it('detects a tagless shell script', async () => {
		const result = await detectLanguage('#!/bin/bash\nset -e\nfor f in *.md; do echo "$f"; done');
		expect(result?.language).toBe('bash');
	});

	it('returns null for a tree listing (was detected as Swift)', async () => {
		const tree = [
			'third_party/odin-playbooks/playbooks/',
			'├── agentic-workflow-abuse/SKILL.md',
			'├── indirect-prompt-injection/SKILL.md',
			'├── llm-as-operator/SKILL.md',
			'│   └── nested/SKILL.md',
			'└── (19 playbook dirs, one SKILL.md each)',
		].join('\n');
		expect(await detectLanguage(tree)).toBeNull();
	});

	it('never guesses Swift for English prose', async () => {
		const prose =
			'The quick brown fox jumps over the lazy dog as an operator in each case.\n' +
			'This is indirect text for the protocol.';
		const result = await detectLanguage(prose);
		expect(result?.language).not.toBe('swift');
	});

	it('returns null for snippets too short to judge', async () => {
		expect(await detectLanguage('ls -la')).toBeNull();
	});
});

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

	it('detects PHP when it wins by a clear lead', async () => {
		const result = await detectLanguage('<?php\n$x = array(1, 2);\necho $x[0];\n?>');
		expect(result?.language).toBe('php');
	});

	it('measures the lead outside the winner family (CSS vs SCSS is not doubt)', async () => {
		// hljs: css 20, scss 14 (lead 1.4, would fail); best non-CSS grammar is python 4.
		const css = [
			'.card {',
			'  display: flex;',
			'  padding: 12px 16px;',
			'  border-radius: 8px;',
			'  background-color: #1e1e2e;',
			'}',
			'',
			'.card:hover {',
			'  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);',
			'  transform: translateY(-1px);',
			'}',
			'',
			'@media (max-width: 600px) {',
			'  .card { padding: 8px; }',
			'}',
		].join('\n');
		const result = await detectLanguage(css);
		expect(result?.language).toBe('css');
	});

	it('detects JSON by parsing it, even where hljs ties it with JavaScript', async () => {
		const result = await detectLanguage('{\n  "name": "maestro",\n  "version": "1.0.0"\n}');
		expect(result?.language).toBe('json');
	});

	it.each([
		[
			'English prose (Swift and C# keywords are English words)',
			'The quick brown fox jumps over the lazy dog as an operator in each case.\n' +
				'This is indirect text for the protocol.',
		],
		[
			'a log (scored as YAML)',
			Array.from(
				{ length: 12 },
				(_, i) => `2026-10-06 10:35:${String(i).padStart(2, '0')} INFO worker[${i}] status=ok`
			).join('\n'),
		],
		[
			'a stack trace (Java and PHP tie)',
			"TypeError: Cannot read properties of undefined (reading 'map')\n" +
				'    at render (/app/src/List.tsx:12:20)\n' +
				'    at renderWithHooks (react-dom.development.js:14985:18)',
		],
		[
			'Java that hljs scores as TypeScript with C# close behind',
			'public class Main {\n' +
				'  private final List<String> items = new ArrayList<>();\n' +
				'  public static void main(String[] args) {\n' +
				'    System.out.println("hi");\n' +
				'  }\n' +
				'}',
		],
		[
			'a short Python snippet that hljs scores as CSS',
			'def main():\n    for x in range(10):\n        print(x)',
		],
	])('falls back to plain text for %s', async (_label, text) => {
		expect(await detectLanguage(text)).toBeNull();
	});

	it('returns null for snippets too short to judge', async () => {
		expect(await detectLanguage('ls -la')).toBeNull();
	});
});

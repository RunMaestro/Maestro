import { describe, expect, it } from 'vitest';
import {
	countMarkdownTasks,
	extractStreamJsonDisplayText,
	extractStreamJsonResult,
	splitMarkdownIntoPhases,
} from '../../../renderer/utils/wizardOutputParsing';

describe('wizardOutputParsing', () => {
	describe('extractStreamJsonResult', () => {
		it('preserves Claude result bytes', () => {
			const result = '{"type":"result","result":"  exact\\nbytes  "}';

			expect(extractStreamJsonResult(result, 'claude-code')).toBe('  exact\nbytes  ');
		});

		it('concatenates OpenCode text parts while ignoring malformed JSON', () => {
			const result = [
				'not json',
				'{"type":"text","part":{"text":"first "}}',
				'{"type":"text","part":{"text":"second"}}',
			].join('\n');

			expect(extractStreamJsonResult(result, 'opencode')).toBe('first second');
		});

		it('concatenates both Codex message forms in stream order', () => {
			const result = [
				'{"type":"agent_message","content":[{"type":"text","text":"first "},{"type":"image","text":"ignored"}]}',
				'{"type":"message","text":"second"}',
			].join('\n');

			expect(extractStreamJsonResult(result, 'codex')).toBe('first second');
		});

		it('joins Grok text deltas while filtering thought deltas', () => {
			const result = [
				'{"type":"thought","data":"private reasoning"}',
				'{"type":"text","data":"visible "}',
				'{"type":"text","data":"answer"}',
			].join('\n');

			expect(extractStreamJsonResult(result, 'grok')).toBe('visible answer');
		});

		it('keeps Copilot final answers opt-in', () => {
			const result =
				'{"type":"assistant.message","data":{"phase":"final_answer","content":"final"}}';

			expect(extractStreamJsonResult(result, 'copilot-cli')).toBeNull();
			expect(
				extractStreamJsonResult(result, 'copilot-cli', { allowCopilotFinalAnswer: true })
			).toBe('final');
		});

		it('returns null when only malformed or irrelevant records are present', () => {
			expect(extractStreamJsonResult('not json\n{"type":"message"}', 'claude-code')).toBeNull();
		});

		it('ignores malformed nested Codex content and falls back safely', () => {
			const withFallback = [
				'{"type":"agent_message","content":[null,42,"invalid",{"type":"text","text":false}]}',
				'{"type":"result","result":"Claude fallback"}',
			].join('\n');

			expect(extractStreamJsonResult(withFallback, 'codex')).toBe('Claude fallback');
			expect(
				extractStreamJsonResult(
					'{"type":"agent_message","content":[null,0,"invalid",{"type":"text","text":null}]}',
					'codex'
				)
			).toBeNull();
		});
	});

	describe('extractStreamJsonDisplayText', () => {
		it('extracts compatible display deltas without broadening provider policy', () => {
			const claude = [
				'{"type":"content_block_delta","delta":{"text":"one "}}',
				'{"type":"assistant","message":{"content":[{"type":"text","text":"two"}]}}',
			].join('\n');

			expect(extractStreamJsonDisplayText(claude, 'claude-code')).toBe('one two');
			expect(
				extractStreamJsonDisplayText(
					'{"type":"assistant.message","data":{"phase":"final_answer","content":"final"}}',
					'copilot-cli'
				)
			).toBe('');
		});

		it('ignores malformed nested display content without throwing', () => {
			expect(
				extractStreamJsonDisplayText(
					'{"type":"agent_message","content":[null,true,{"type":"text","text":"visible"}]}',
					'codex'
				)
			).toBe('visible');
			expect(
				extractStreamJsonDisplayText(
					'{"type":"agent_message","content":[null,{},{"type":"text","text":null}]}',
					'codex'
				)
			).toBe('');
		});
	});

	describe('splitMarkdownIntoPhases', () => {
		it('splits H1 and H2 phase headers case-insensitively with cleaned sequential filenames', () => {
			const documents = splitMarkdownIntoPhases(
				'# phase 9: Setup & Discovery!\nTask one\n\n## PHASE 12 - Build / Ship\nTask two'
			);

			expect(documents).toEqual([
				{
					filename: 'Phase-01-Setup-Discovery.md',
					content: '# phase 9: Setup & Discovery!\n\nTask one',
					phase: 1,
				},
				{
					filename: 'Phase-02-Build-Ship.md',
					content: '## PHASE 12 - Build / Ship\n\nTask two',
					phase: 2,
				},
			]);
		});

		it('uses the raw Phase-01 fallback only for non-empty content', () => {
			expect(splitMarkdownIntoPhases(' raw content \n')).toEqual([
				{ filename: 'Phase-01-Initial-Setup.md', content: 'raw content', phase: 1 },
			]);
			expect(splitMarkdownIntoPhases('   ')).toEqual([]);
		});
	});

	describe('countMarkdownTasks', () => {
		it('counts permissive uppercase and whitespace checkbox forms', () => {
			expect(countMarkdownTasks('- [ ] open\n- [X] closed\n-   [   x ] spaced\n-[] no')).toBe(4);
		});
	});
});

/**
 * @file workflow-handoff.test.ts
 * @description Tests for workflow handoff sizing and prompt formatting.
 */

import { describe, expect, it } from 'vitest';
import {
	HANDOFF_DIGEST_CHARS,
	HANDOFF_INLINE_MAX_CHARS,
	classifyHandoff,
	formatHandoffForPrompt,
} from '../../../main/group-chat/workflow-handoff';

describe('classifyHandoff', () => {
	it('keeps content just under the inline threshold inline', () => {
		const content = 'a'.repeat(HANDOFF_INLINE_MAX_CHARS - 1);

		expect(classifyHandoff(content)).toEqual({ mode: 'inline' });
	});

	it('keeps content exactly at the inline threshold inline', () => {
		const content = 'a'.repeat(HANDOFF_INLINE_MAX_CHARS);

		expect(classifyHandoff(content)).toEqual({ mode: 'inline' });
	});

	it('classifies content well over the inline threshold as an artifact', () => {
		const content = `${'A complete sentence. '.repeat(50)}${'details '.repeat(600)}`;

		const result = classifyHandoff(content);

		expect(result.mode).toBe('artifact');
		if (result.mode === 'artifact') {
			expect(Array.from(result.digest).length).toBeLessThanOrEqual(HANDOFF_DIGEST_CHARS);
			expect(content.startsWith(result.digest)).toBe(true);
		}
	});

	it('ends a digest at the latest paragraph boundary within the digest cap', () => {
		const paragraph = 'a'.repeat(650);
		const content = `${paragraph}\n\n${'unfinished '.repeat(400)}`;

		expect(classifyHandoff(content)).toEqual({ mode: 'artifact', digest: paragraph });
	});

	it('prefers a sentence boundary over later word boundaries', () => {
		const sentence = `${'word '.repeat(130).trimEnd()}.`;
		const content = `${sentence} ${'unfinished '.repeat(400)}`;

		expect(classifyHandoff(content)).toEqual({ mode: 'artifact', digest: sentence });
	});

	it('falls back to whitespace without retaining a partial word', () => {
		const completeWords = 'word '.repeat(159).trimEnd();
		const content = `${completeWords} supercalifragilisticexpialidocious ${'tail '.repeat(700)}`;

		const result = classifyHandoff(content);

		expect(result).toEqual({ mode: 'artifact', digest: completeWords });
		expect(result.mode === 'artifact' && result.digest.endsWith('supercal')).toBe(false);
	});

	it('counts and truncates unicode by code point without splitting surrogate pairs', () => {
		const unicodeSentence = `${'🙂'.repeat(390)}.`;
		const content = `${unicodeSentence} ${'🚀'.repeat(HANDOFF_INLINE_MAX_CHARS)}`;

		const result = classifyHandoff(content);

		expect(result).toEqual({ mode: 'artifact', digest: unicodeSentence });
		expect(result.mode === 'artifact' && result.digest).not.toContain('\uFFFD');
	});

	it('uses unicode code points for the inline threshold', () => {
		expect(classifyHandoff('🙂'.repeat(HANDOFF_INLINE_MAX_CHARS))).toEqual({ mode: 'inline' });
		expect(classifyHandoff('🙂'.repeat(HANDOFF_INLINE_MAX_CHARS + 1)).mode).toBe('artifact');
	});
});

describe('formatHandoffForPrompt', () => {
	it('renders the full participant response in inline mode', () => {
		expect(
			formatHandoffForPrompt({
				participantName: 'Builder',
				mode: 'inline',
				content: 'Implemented the requested change.\nAll checks pass.',
			})
		).toBe('### Builder\n\nImplemented the requested change.\nAll checks pass.');
	});

	it('renders only the digest and absolute path in artifact mode', () => {
		expect(
			formatHandoffForPrompt({
				participantName: 'Reviewer',
				mode: 'artifact',
				digest: 'The review found two follow-ups.',
				artifactPath: '/tmp/workflow-runs/run-1/stage-1/Reviewer.md',
			})
		).toBe(
			'### Reviewer\n\nThe review found two follow-ups.\n\nFull output: /tmp/workflow-runs/run-1/stage-1/Reviewer.md'
		);
	});
});

import { describe, expect, it } from 'vitest';
import { prepareSpeechText } from '../../shared/acappella/speech-text';
import {
	buildSpeechVocabulary,
	normalizeSpeechVocabulary,
	MAX_SPEECH_VOCABULARY_CHARS,
} from '../../shared/acappella/speech-vocabulary';

describe('speech presentation', () => {
	it('removes full emoji sequences and leaves numbers, accents and punctuation for the voice', () => {
		expect(
			prepareSpeechText('🧑🏽‍💻 **Pedro Sidián** ✅ costs $42.50 at 3:05, version 1.2.3. 🇺🇸 1️⃣')
		).toBe('Pedro Sidián costs $42.50 at 3:05, version 1.2.3.');
		expect(prepareSpeechText('🎉!')).toBe('');
	});
	it('keeps link labels and prose without speaking code, images, markup or directives', () => {
		const source =
			'> [!IMPORTANT]\n## ✅ Result\n- **Fixed** [auth](https://example.com/auth).\n```ts\nthrow new Error("never speak this");\n```\n![screenshot](file.png)\n::git-create-pr{title="private"}\n<b>Ready</b> &amp; safe.';
		expect(prepareSpeechText(source)).toBe('Result Fixed auth. Ready & safe.');
		expect(prepareSpeechText(prepareSpeechText(source))).toBe(prepareSpeechText(source));
	});
	it('flattens tables while preserving their cell text', () => {
		const spoken = prepareSpeechText('| Agent | Status |\n| --- | --- |\n| ✅ Backend | Ready |');
		expect(spoken).toContain('Backend');
		expect(spoken).toContain('Ready');
		expect(spoken).not.toMatch(/[|✅]/);
	});
});

describe('speech vocabulary', () => {
	it('takes literal names from the roster, prioritizes the active agent and deduplicates custom terms', () => {
		expect(
			buildSpeechVocabulary(
				[
					{
						sessionId: 'a',
						name: '🧑‍💻 Backend',
						agentType: 'codex',
						cwd: '/private/path',
						tabs: [{ id: 't', name: 'Auth', lastActiveAt: 0 }],
					},
					{ sessionId: 'b', name: '🏢 Pedro Sidián', agentType: 'codex', cwd: '/other', tabs: [] },
				],
				['NorseStar', 'backend'],
				'b'
			)
		).toEqual(['Pedro Sidián', 'NorseStar', 'backend', 'Maestro', 'Auth']);
	});
	it('bounds hints and rejects invalid fields without leaking paths or recent transcript content', () => {
		expect(
			normalizeSpeechVocabulary([null, '<instruction>', 'x'.repeat(81), '0DIN', '#build', 'café'])
		).toEqual(['0DIN', '#build', 'café']);
		const terms = normalizeSpeechVocabulary(
			Array.from({ length: 500 }, (_, i) => `agent ${i} ${'x'.repeat(55)}`)
		);
		expect(terms.join(', ').length).toBeLessThanOrEqual(MAX_SPEECH_VOCABULARY_CHARS);
	});
});

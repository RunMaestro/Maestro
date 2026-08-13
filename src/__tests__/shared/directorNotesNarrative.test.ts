/**
 * Tests for shared/directorNotesNarrative.ts - the Director's Notes structured
 * narrative parser.
 *
 * `parseDirectorNotesNarrative` is the single source of truth for turning the
 * agent's raw string into a validated `DirectorNotesNarrative`. The contract it
 * promises (and these tests pin down):
 *   - it NEVER throws,
 *   - it tolerantly extracts the object from a code fence or stray prose,
 *   - it validates strictly and returns `{ ok: false, error }` with a precise,
 *     descriptive message on ANY structural problem,
 *   - on success it returns the exact parsed structure with only the allowed
 *     optional fields present.
 *
 * The parser is pure and dependency-free, so there is nothing to mock here.
 */

import { describe, it, expect } from 'vitest';
import {
	looksLikeStructuredOutput,
	parseDirectorNotesNarrative,
	recoverDirectorNotesNarrative,
	narrativeToMarkdown,
	type DirectorNotesNarrative,
} from '../../shared/directorNotesNarrative';

/**
 * A representative, fully-formed narrative exercising every optional field:
 * an item with neither `severity` nor `agent`, one with both, one with only
 * `severity`, and one with only `agent`. Used as the canonical "good" payload
 * so success assertions can pin the EXACT parsed structure.
 */
const WELL_FORMED: DirectorNotesNarrative = {
	version: 1,
	sections: [
		{
			kind: 'accomplishments',
			title: 'What got done',
			items: [
				{ text: 'Shipped the deterministic stats engine.' },
				{
					text: 'Closed the flaky SuccessFailureWidget test.',
					severity: 'info',
					agent: 'directors-notes-rich-mode',
				},
			],
		},
		{
			kind: 'challenges',
			title: 'Where it got stuck',
			items: [{ text: 'Concurrent Cue writes corrupted history.', severity: 'critical' }],
		},
		{
			kind: 'nextSteps',
			title: 'What is next',
			items: [{ text: 'Wire up the Widget Gallery dev command.', agent: 'peer-agent' }],
		},
	],
};

/** Assert a bad input yields `ok: false` and a descriptive error. */
function expectParseError(raw: string, matcher: string | RegExp): void {
	const result = parseDirectorNotesNarrative(raw);
	expect(result.ok).toBe(false);
	// Type-narrow for the error access below.
	if (result.ok) throw new Error('expected parse to fail but it succeeded');
	expect(result.error.length).toBeGreaterThan(0);
	if (typeof matcher === 'string') {
		expect(result.error).toBe(matcher);
	} else {
		expect(result.error).toMatch(matcher);
	}
}

describe('parseDirectorNotesNarrative', () => {
	describe('well-formed input (ok: true with exact structure)', () => {
		it('parses a clean well-formed JSON object', () => {
			const result = parseDirectorNotesNarrative(JSON.stringify(WELL_FORMED));
			expect(result).toEqual({ ok: true, narrative: WELL_FORMED });
		});

		it('parses JSON wrapped in a ```json fence', () => {
			const fenced = '```json\n' + JSON.stringify(WELL_FORMED, null, 2) + '\n```';
			const result = parseDirectorNotesNarrative(fenced);
			expect(result).toEqual({ ok: true, narrative: WELL_FORMED });
		});

		it('parses JSON with leading and trailing prose', () => {
			const prose =
				"Here are the director's notes for this run:\n\n" +
				JSON.stringify(WELL_FORMED) +
				'\n\nLet me know if you want a Plain Mode summary instead.';
			const result = parseDirectorNotesNarrative(prose);
			expect(result).toEqual({ ok: true, narrative: WELL_FORMED });
		});

		it('parses JSON followed by an epilogue that contains braces', () => {
			// A naive last-`}` scan swallows the epilogue and fails the whole
			// object; the balanced scan stops at the object's real close brace.
			const withEpilogue =
				JSON.stringify(WELL_FORMED) + '\n\nNote: skipped one unreadable file {see log}.';
			const result = parseDirectorNotesNarrative(withEpilogue);
			expect(result).toEqual({ ok: true, narrative: WELL_FORMED });
		});

		it('does not treat braces inside item text as structure', () => {
			const braced = {
				version: 1 as const,
				sections: [
					{
						kind: 'accomplishments' as const,
						title: 'Accomplishments',
						items: [{ text: 'Fixed the `{{TAB_ID}}` template variable } leak' }],
					},
				],
			};
			const result = parseDirectorNotesNarrative(JSON.stringify(braced));
			expect(result).toEqual({ ok: true, narrative: braced });
		});

		it('says the object was cut off, not that no object was found', () => {
			// Reporting "no JSON object found" about a response that visibly starts
			// with one sends the reader hunting for the wrong problem.
			const truncated = JSON.stringify(WELL_FORMED).slice(0, -1);
			const result = parseDirectorNotesNarrative(truncated);
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error('expected failure');
			expect(result.error).toContain('cut off');
			expect(result.error).not.toContain('No JSON object found');
		});

		it('accepts an empty sections array', () => {
			const result = parseDirectorNotesNarrative('{ "version": 1, "sections": [] }');
			expect(result).toEqual({ ok: true, narrative: { version: 1, sections: [] } });
		});

		it('omits optional fields that were not provided', () => {
			const result = parseDirectorNotesNarrative(JSON.stringify(WELL_FORMED));
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error('expected success');
			const firstItem = result.narrative.sections[0].items[0];
			expect(firstItem).toEqual({ text: 'Shipped the deterministic stats engine.' });
			expect(firstItem).not.toHaveProperty('severity');
			expect(firstItem).not.toHaveProperty('agent');
		});

		it('preserves the allowed optional fields exactly', () => {
			const result = parseDirectorNotesNarrative(JSON.stringify(WELL_FORMED));
			if (!result.ok) throw new Error('expected success');
			expect(result.narrative.sections[0].items[1]).toEqual({
				text: 'Closed the flaky SuccessFailureWidget test.',
				severity: 'info',
				agent: 'directors-notes-rich-mode',
			});
			expect(result.narrative.sections[1].items[0]).toEqual({
				text: 'Concurrent Cue writes corrupted history.',
				severity: 'critical',
			});
			expect(result.narrative.sections[2].items[0]).toEqual({
				text: 'Wire up the Widget Gallery dev command.',
				agent: 'peer-agent',
			});
		});
	});

	describe('the optional progress section', () => {
		// Emitted only when the conductor has configured an Ideal End State, so
		// the parser must accept a four-section report without requiring one.
		const WITH_PROGRESS = {
			version: 1,
			sections: [
				{ kind: 'accomplishments', title: 'Accomplishments', items: [{ text: 'Shipped it.' }] },
				{ kind: 'challenges', title: 'Challenges', items: [] },
				{ kind: 'nextSteps', title: 'Next Steps', items: [] },
				{
					kind: 'progress',
					title: 'Progress Toward Ideal End State',
					items: [
						{ text: 'Ingest pipeline is 3 of 5 milestones in.', agent: 'parser-a' },
						{ text: 'No activity on the docs rewrite this window.', severity: 'warn' },
					],
				},
			],
		};

		it('accepts a four-section report', () => {
			const result = parseDirectorNotesNarrative(JSON.stringify(WITH_PROGRESS));
			if (!result.ok) throw new Error(`expected success, got: ${result.error}`);

			expect(result.narrative.sections).toHaveLength(4);
			expect(result.narrative.sections[3].kind).toBe('progress');
			expect(result.narrative.sections[3].items[1]).toEqual({
				text: 'No activity on the docs rewrite this window.',
				severity: 'warn',
			});
		});

		it('still accepts a three-section report (end state unset)', () => {
			const result = parseDirectorNotesNarrative(JSON.stringify(WELL_FORMED));
			if (!result.ok) throw new Error('expected success');

			expect(result.narrative.sections).toHaveLength(3);
			expect(result.narrative.sections.some((s) => s.kind === 'progress')).toBe(false);
		});

		it('renders the progress section in markdown', () => {
			const result = parseDirectorNotesNarrative(JSON.stringify(WITH_PROGRESS));
			if (!result.ok) throw new Error('expected success');

			const markdown = narrativeToMarkdown(result.narrative);
			expect(markdown).toContain('## Progress Toward Ideal End State');
			expect(markdown).toContain('- Ingest pipeline is 3 of 5 milestones in. _(parser-a)_');
		});
	});

	describe('empty input (ok: false)', () => {
		it('rejects an empty string', () => {
			expectParseError('', 'Response was empty.');
		});

		it('rejects a whitespace-only string', () => {
			expectParseError('   \n\t  ', 'Response was empty.');
		});
	});

	describe('no extractable object (ok: false)', () => {
		it('rejects prose with no JSON object at all', () => {
			expectParseError(
				'Sorry, I could not generate notes this time.',
				'No JSON object found in the response.'
			);
		});

		it('rejects a JSON array (no object braces)', () => {
			expectParseError('[1, 2, 3]', 'No JSON object found in the response.');
		});

		it('rejects a closing brace appearing before any opening brace', () => {
			// The scan starts at the FIRST `{`, so the leading `}` is not structure -
			// what is left is an object that opened and never closed.
			expectParseError(
				'} then {',
				'The JSON object was never closed - the response was cut off before it finished.'
			);
		});
	});

	describe('malformed JSON (ok: false)', () => {
		it('rejects syntactically invalid JSON between the braces', () => {
			expectParseError('{ "version": 1, "sections": [oops] }', /Response is not valid JSON:/);
		});

		it('rejects an unterminated object', () => {
			expectParseError('{ "version": 1, "sections": [1, 2, }', /Response is not valid JSON:/);
		});
	});

	describe('structurally-invalid JSON (ok: false)', () => {
		it('rejects a wrong version number', () => {
			expectParseError('{ "version": 2, "sections": [] }', 'Field "version" must be the number 1.');
		});

		it('rejects a missing version', () => {
			expectParseError('{ "sections": [] }', 'Field "version" must be the number 1.');
		});

		it('rejects a string version that is not the number 1', () => {
			expectParseError(
				'{ "version": "1", "sections": [] }',
				'Field "version" must be the number 1.'
			);
		});

		it('rejects a missing sections field', () => {
			expectParseError('{ "version": 1 }', 'Field "sections" must be an array.');
		});

		it('rejects a non-array sections field', () => {
			expectParseError(
				'{ "version": 1, "sections": "nope" }',
				'Field "sections" must be an array.'
			);
		});

		it('rejects a section that is not an object', () => {
			expectParseError('{ "version": 1, "sections": [42] }', 'sections[0] must be an object.');
		});

		it('rejects an unknown section kind', () => {
			expectParseError(
				'{ "version": 1, "sections": [{ "kind": "misc", "title": "x", "items": [] }] }',
				'sections[0].kind must be one of "accomplishments", "challenges", "nextSteps", "progress".'
			);
		});

		it('rejects a non-string section title', () => {
			expectParseError(
				'{ "version": 1, "sections": [{ "kind": "accomplishments", "title": 5, "items": [] }] }',
				'sections[0].title must be a string.'
			);
		});

		it('rejects non-array section items', () => {
			expectParseError(
				'{ "version": 1, "sections": [{ "kind": "challenges", "title": "x", "items": "nope" }] }',
				'sections[0].items must be an array.'
			);
		});

		it('rejects an item that is not an object', () => {
			expectParseError(
				'{ "version": 1, "sections": [{ "kind": "nextSteps", "title": "x", "items": [7] }] }',
				'sections[0].items[0] must be an object.'
			);
		});

		it('rejects an item missing the required text field', () => {
			expectParseError(
				'{ "version": 1, "sections": [{ "kind": "accomplishments", "title": "x", "items": [{}] }] }',
				'sections[0].items[0].text must be a string.'
			);
		});

		it('rejects a non-string item text', () => {
			expectParseError(
				'{ "version": 1, "sections": [{ "kind": "accomplishments", "title": "x", "items": [{ "text": 9 }] }] }',
				'sections[0].items[0].text must be a string.'
			);
		});

		it('rejects an unknown item severity', () => {
			expectParseError(
				'{ "version": 1, "sections": [{ "kind": "challenges", "title": "x", "items": [{ "text": "t", "severity": "fatal" }] }] }',
				'sections[0].items[0].severity must be one of "info", "warn", "critical".'
			);
		});

		it('rejects a non-string item agent', () => {
			expectParseError(
				'{ "version": 1, "sections": [{ "kind": "nextSteps", "title": "x", "items": [{ "text": "t", "agent": 3 }] }] }',
				'sections[0].items[0].agent must be a string.'
			);
		});

		it('reports the location of the first bad item in a later section', () => {
			const raw = JSON.stringify({
				version: 1,
				sections: [
					{ kind: 'accomplishments', title: 'ok', items: [{ text: 'fine' }] },
					{ kind: 'challenges', title: 'bad', items: [{ text: 'ok' }, { severity: 'info' }] },
				],
			});
			expectParseError(raw, 'sections[1].items[1].text must be a string.');
		});
	});

	describe('robustness', () => {
		it('never throws on assorted garbage input', () => {
			const inputs = [
				'',
				'   ',
				'{',
				'}',
				'{}',
				'null',
				'true',
				'{ "version": 1, "sections": [{}] }',
				'{ "version": 1, "sections": [{ "kind": "accomplishments" }] }',
				'```json\n{ broken \n```',
				'random text { with a brace } and more',
			];
			for (const input of inputs) {
				expect(() => parseDirectorNotesNarrative(input)).not.toThrow();
				// Every one of these is invalid, so all must report failure.
				expect(parseDirectorNotesNarrative(input).ok).toBe(false);
			}
		});
	});

	describe('narrativeToMarkdown', () => {
		it('renders each section as a `##` heading with bullet items', () => {
			const md = narrativeToMarkdown({
				version: 1,
				sections: [
					{
						kind: 'accomplishments',
						title: 'Accomplishments',
						items: [{ text: 'Shipped Plain Mode' }, { text: 'Fixed the JSON leak' }],
					},
				],
			});
			expect(md).toContain('## Accomplishments');
			expect(md).toContain('- Shipped Plain Mode');
			expect(md).toContain('- Fixed the JSON leak');
		});

		it('bolds critical items and appends the agent as italic attribution', () => {
			const md = narrativeToMarkdown({
				version: 1,
				sections: [
					{
						kind: 'challenges',
						title: 'Challenges',
						items: [
							{ text: 'Build pipeline broke', severity: 'critical', agent: 'rc' },
							{ text: 'Routine cleanup', agent: 'Maestro' },
						],
					},
				],
			});
			expect(md).toContain('- **Build pipeline broke** _(rc)_');
			expect(md).toContain('- Routine cleanup _(Maestro)_');
		});

		it('keeps warn/info items plain (no bold)', () => {
			const md = narrativeToMarkdown({
				version: 1,
				sections: [
					{
						kind: 'challenges',
						title: 'Challenges',
						items: [
							{ text: 'A risk', severity: 'warn' },
							{ text: 'A note', severity: 'info' },
						],
					},
				],
			});
			expect(md).toContain('- A risk');
			expect(md).toContain('- A note');
			expect(md).not.toContain('**A risk**');
			expect(md).not.toContain('**A note**');
		});

		it('renders an empty section with a "Nothing to report." note under its heading', () => {
			const md = narrativeToMarkdown({
				version: 1,
				sections: [{ kind: 'nextSteps', title: 'Next Steps', items: [] }],
			});
			expect(md).toContain('## Next Steps');
			expect(md).toContain('_Nothing to report._');
		});

		it('never emits the raw JSON keys (proves Plain Mode is prose, not the object)', () => {
			const md = narrativeToMarkdown({
				version: 1,
				sections: [
					{
						kind: 'accomplishments',
						title: 'Accomplishments',
						items: [{ text: 'Did the thing', severity: 'info', agent: 'Maestro' }],
					},
				],
			});
			expect(md).not.toContain('"version"');
			expect(md).not.toContain('"sections"');
			expect(md).not.toContain('"kind"');
			expect(md).not.toContain('"items"');
		});
	});
});

/**
 * `recoverDirectorNotesNarrative` is the salvage path taken ONLY after the
 * strict parser rejects the output. A synopsis run costs minutes of agent time,
 * so the failures that actually happen in the field (a response cut off
 * mid-stream, a raw line break inside a bullet, one malformed item) must not
 * cost the whole report. The contract these tests pin down:
 *   - it recovers the readable portion of a truncated response,
 *   - it drops individual bad items instead of the document,
 *   - it always explains what it salvaged (never silently partial),
 *   - it still refuses output with no narrative content in it.
 */
describe('recoverDirectorNotesNarrative', () => {
	/** Build a full narrative response, then cut it at `chars` to simulate truncation. */
	const fullResponse = JSON.stringify({
		version: 1,
		sections: [
			{
				kind: 'accomplishments',
				title: 'Accomplishments',
				items: [
					{ text: 'Shipped the tab-tiling restore', severity: 'info', agent: 'rc' },
					{ text: 'Fixed the platform detection bug', severity: 'info', agent: 'Maestro' },
				],
			},
			{
				kind: 'challenges',
				title: 'Challenges',
				items: [{ text: 'CI stayed red all week', severity: 'critical', agent: 'rc' }],
			},
		],
	});

	it('recovers the readable sections when the response is cut off mid-string', () => {
		const truncated = fullResponse.slice(0, fullResponse.indexOf('Fixed the platform') + 8);
		// Precondition: the strict parser must have failed for recovery to matter.
		expect(parseDirectorNotesNarrative(truncated).ok).toBe(false);

		const result = recoverDirectorNotesNarrative(truncated);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.narrative.sections).toHaveLength(1);
		expect(result.narrative.sections[0].items).toEqual([
			{ text: 'Shipped the tab-tiling restore', severity: 'info', agent: 'rc' },
		]);
		expect(result.reason).toContain('cut off');
	});

	it('recovers a response cut off between two complete items', () => {
		const truncated = fullResponse.slice(0, fullResponse.indexOf('},{', 40) + 1);
		const result = recoverDirectorNotesNarrative(truncated);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.narrative.sections[0].items[0].text).toBe('Shipped the tab-tiling restore');
	});

	it('recovers bullets containing a raw line break (invalid JSON the prompt forbids)', () => {
		const raw =
			'{"version":1,"sections":[{"kind":"accomplishments","title":"Accomplishments",' +
			'"items":[{"text":"First line\nsecond line"}]}]}';
		expect(parseDirectorNotesNarrative(raw).ok).toBe(false);

		const result = recoverDirectorNotesNarrative(raw);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.narrative.sections[0].items[0].text).toBe('First line\nsecond line');
		expect(result.reason).toContain('line breaks');
	});

	it('drops a malformed bullet and keeps the rest of the section', () => {
		const raw = JSON.stringify({
			version: 1,
			sections: [
				{
					kind: 'accomplishments',
					title: 'Accomplishments',
					items: [{ text: 'Kept this one' }, { agent: 'no text field' }, { text: '   ' }],
				},
			],
		});
		const result = recoverDirectorNotesNarrative(raw);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.narrative.sections[0].items).toEqual([{ text: 'Kept this one' }]);
		expect(result.reason).toContain('2 bullets were malformed and dropped');
	});

	it('keeps a bullet whose severity is invalid, dropping only that field', () => {
		const raw = JSON.stringify({
			version: 1,
			sections: [
				{
					kind: 'accomplishments',
					title: 'Accomplishments',
					items: [{ text: 'Still readable', severity: 'catastrophic', agent: 'rc' }],
				},
			],
		});
		const result = recoverDirectorNotesNarrative(raw);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.narrative.sections[0].items[0]).toEqual({
			text: 'Still readable',
			agent: 'rc',
		});
	});

	it('drops a section with an unknown kind rather than the whole document', () => {
		const raw = JSON.stringify({
			version: 1,
			sections: [
				{ kind: 'vibes', title: 'Vibes', items: [{ text: 'Not a real section' }] },
				{ kind: 'nextSteps', title: 'Next Steps', items: [{ text: 'Keep going' }] },
			],
		});
		const result = recoverDirectorNotesNarrative(raw);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.narrative.sections).toHaveLength(1);
		expect(result.narrative.sections[0].kind).toBe('nextSteps');
	});

	it('falls back to the canonical title when a salvaged section has none', () => {
		const raw = '{"version":1,"sections":[{"kind":"challenges","items":[{"text":"A blocker"}]}';
		const result = recoverDirectorNotesNarrative(raw);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.narrative.sections[0].title).toBe('Challenges');
	});

	it('converts a recovered narrative to prose with no JSON left in it', () => {
		const truncated = fullResponse.slice(0, fullResponse.indexOf('Fixed the platform') + 8);
		const result = recoverDirectorNotesNarrative(truncated);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const md = narrativeToMarkdown(result.narrative);
		expect(md).toContain('## Accomplishments');
		expect(md).not.toContain('"version"');
		expect(md).not.toContain('"sections"');
	});

	// The field failure this distinction exists for: an agent writing right up
	// against its output limit finishes the whole structure and loses only the
	// final `}`. Every section and bullet is present, so the report is COMPLETE -
	// and must not be handed to the user under a "may be incomplete" banner.
	describe('lossless repair (report survives intact)', () => {
		it('reports lossless when only the closing brace is missing', () => {
			const truncated = fullResponse.slice(0, -1);
			expect(parseDirectorNotesNarrative(truncated).ok).toBe(false);

			const result = recoverDirectorNotesNarrative(truncated);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.lossless).toBe(true);
			// Every section and bullet of the original response survived.
			expect(result.narrative).toEqual(JSON.parse(fullResponse));
			expect(result.reason).toContain('closing punctuation');
			expect(result.reason).toContain('No report content was lost');
			expect(result.reason).not.toContain('cut off');
		});

		it('reports lossless for a stray line break inside a bullet', () => {
			const raw =
				'{"version":1,"sections":[{"kind":"accomplishments","title":"Accomplishments",' +
				'"items":[{"text":"First line\nsecond line"}]}]}';
			const result = recoverDirectorNotesNarrative(raw);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.lossless).toBe(true);
		});

		it('reports NOT lossless when the cut landed mid-report', () => {
			const truncated = fullResponse.slice(0, fullResponse.indexOf('Fixed the platform') + 8);
			const result = recoverDirectorNotesNarrative(truncated);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.lossless).toBe(false);
			expect(result.reason).toContain('cut off');
		});

		it('reports NOT lossless when a bullet had to be dropped', () => {
			const raw = JSON.stringify({
				version: 1,
				sections: [
					{
						kind: 'accomplishments',
						title: 'Accomplishments',
						items: [{ text: 'Kept this one' }, { agent: 'no text field' }],
					},
				],
			});
			const result = recoverDirectorNotesNarrative(raw);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.lossless).toBe(false);
		});

		it('reports NOT lossless when the sections array itself never closed', () => {
			// Same "nothing discarded" shape as the brace-only case, but the agent
			// stopped mid-list: more sections were still coming, so content IS lost.
			const truncated = fullResponse.slice(0, fullResponse.indexOf('},{"kind":"challenges"') + 1);
			const result = recoverDirectorNotesNarrative(truncated);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.lossless).toBe(false);
		});
	});

	it('refuses output with no narrative content in it', () => {
		for (const raw of [
			'',
			'   ',
			'Sorry, I could not read the history files.',
			'{"version":1,"sections":[]}',
			'{"unrelated":{"nested":true}}',
		]) {
			const result = recoverDirectorNotesNarrative(raw);
			expect(result.ok).toBe(false);
		}
	});

	it('never throws, whatever the input', () => {
		for (const raw of ['{', '{{{{', '[]', 'null', '{"sections":"nope"}', '{"sections":[{']) {
			expect(() => recoverDirectorNotesNarrative(raw)).not.toThrow();
		}
	});
});

describe('looksLikeStructuredOutput', () => {
	// This predicate decides what a FAILED parse means. The Director's Notes
	// prompt is a user-editable setting persisted to userData, so a profile can
	// hold a markdown-contract prompt while the build expects JSON, or the
	// reverse. JSON-shaped means the narrative is genuinely broken; anything
	// else is prose that should simply be rendered.
	it('accepts a bare structured object', () => {
		expect(looksLikeStructuredOutput('{"version":1,"sections":[]}')).toBe(true);
		expect(looksLikeStructuredOutput('\n\n  {"version":1}  ')).toBe(true);
	});

	it('accepts an object wrapped in a code fence', () => {
		// The agent fences it sometimes despite being told not to.
		expect(looksLikeStructuredOutput('```json\n{"version":1}\n```')).toBe(true);
		expect(looksLikeStructuredOutput('```\n{"version":1}\n```')).toBe(true);
	});

	it('rejects markdown prose', () => {
		expect(looksLikeStructuredOutput('# Synopsis\n\nWe shipped things.')).toBe(false);
		expect(looksLikeStructuredOutput('## Accomplishments\n\n- Did the thing')).toBe(false);
	});

	it('rejects markdown that merely CONTAINS a JSON example', () => {
		// Why this is a starts-with check and not a scan: a report quoting a JSON
		// snippet is still a report, and treating it as a botched narrative would
		// replace it with a parse error.
		const raw = '# Synopsis\n\nThe config looked like:\n\n```json\n{"a":1}\n```\n';
		expect(looksLikeStructuredOutput(raw)).toBe(false);
	});

	it('rejects empty and non-string input without throwing', () => {
		expect(looksLikeStructuredOutput('')).toBe(false);
		expect(looksLikeStructuredOutput('   \n  ')).toBe(false);
		expect(looksLikeStructuredOutput(undefined as unknown as string)).toBe(false);
		expect(looksLikeStructuredOutput('```json')).toBe(false);
	});
});

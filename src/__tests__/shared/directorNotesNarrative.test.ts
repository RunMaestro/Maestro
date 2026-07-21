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
	parseDirectorNotesNarrative,
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
			expectParseError('} then {', 'No JSON object found in the response.');
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
				'sections[0].kind must be one of "accomplishments", "challenges", "nextSteps".'
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

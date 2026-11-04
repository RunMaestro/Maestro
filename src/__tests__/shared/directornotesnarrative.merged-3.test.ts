// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/directorNotesNarrative.test.ts
// Source: src/__tests__/shared/autorunModelHints.test.ts
// Source: src/__tests__/shared/autorunAutoResume.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import {
	looksLikeStructuredOutput,
	parseDirectorNotesNarrative,
	recoverDirectorNotesNarrative,
	narrativeToMarkdown,
	type DirectorNotesNarrative,
} from '../../shared/directorNotesNarrative';
import { buildNarrativeGroupLookup } from '../../shared/directorNotesGrouping';
import { noteEffortRejection, resetEffortRejections } from '../../shared/effortRejection';
import {
	findActiveModelHint,
	findAllModelHints,
	countTasksUnderActiveHint,
	describeSegmentLimit,
} from '../../shared/autorunModelHints';
import { resolveTurnSettings } from '../../shared/autorunTurnSettings';
import {
	AUTO_RESUME_DEFAULT_MINUTES,
	AUTO_RESUME_DEFAULT_MAX_ATTEMPTS,
	AUTO_RESUME_MIN_MINUTES,
	AUTO_RESUME_MAX_MINUTES,
	AUTO_RESUME_MIN_ATTEMPTS,
	AUTO_RESUME_MAX_ATTEMPTS,
	autoResumeEnabled,
	clampAutoResumeMinutes,
	clampMaxAutoResumes,
	resolveAutoResumePolicy,
} from '../../shared/autorunAutoResume';
// Source: src/__tests__/shared/directorNotesNarrative.test.ts
describe('', () => {
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
				// The section mixes an attributed and an unattributed bullet, so it
				// buckets: the agent moves to a subheading and stops repeating on the
				// bullet itself.
				expect(markdown).toContain('### parser-a');
				expect(markdown).toContain('- Ingest pipeline is 3 of 5 milestones in.');
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
				expectParseError('{ "version": 1, "sections": [1, 2, ', /never closed/);
			});
			// A `}` where a `]` belonged used to balance a plain depth counter back to
			// zero, so the slice handed to JSON.parse looked complete and the error
			// blamed the syntax rather than the bracket. Name what actually happened.
			it('rejects a container closed with the wrong bracket', () => {
				expectParseError('{ "version": 1, "sections": [1, 2, }', /brackets do not match/);
			});
		});
		describe('structurally-invalid JSON (ok: false)', () => {
			it('rejects a wrong version number', () => {
				expectParseError(
					'{ "version": 2, "sections": [] }',
					'Field "version" must be the number 1.'
				);
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
			it('bolds critical items and buckets each agent under its own subheading', () => {
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
				expect(md).toContain('### rc');
				expect(md).toContain('- **Build pipeline broke**');
				expect(md).toContain('### Maestro');
				expect(md).toContain('- Routine cleanup');
				// Under an agent heading the attribution would only repeat the heading.
				expect(md).not.toContain('_(rc)_');
			});
			it('keeps the attribution inline when every bullet shares one agent', () => {
				const md = narrativeToMarkdown({
					version: 1,
					sections: [
						{
							kind: 'challenges',
							title: 'Challenges',
							items: [
								{ text: 'Build pipeline broke', severity: 'critical', agent: 'rc' },
								{ text: 'Routine cleanup', agent: 'rc' },
							],
						},
					],
				});
				// One bucket means no subheading is worth drawing.
				expect(md).not.toContain('###');
				expect(md).toContain('- **Build pipeline broke** _(rc)_');
				expect(md).toContain('- Routine cleanup _(rc)_');
			});
			it('buckets by GROUP when a lookup maps the agents into one', () => {
				const md = narrativeToMarkdown(
					{
						version: 1,
						sections: [
							{
								kind: 'challenges',
								title: 'Challenges',
								items: [
									{ text: 'Build pipeline broke', agent: 'rc' },
									{ text: 'Routine cleanup', agent: 'Maestro' },
									{ text: 'Voice models stalled', agent: 'acappella' },
								],
							},
						],
					},
					{
						groupLookup: buildNarrativeGroupLookup([
							{ agent: 'rc', group: 'Maestro Core', emoji: '🎬' },
							{ agent: 'Maestro', group: 'Maestro Core', emoji: '🎬' },
						]),
					}
				);
				// Two grouped agents collapse into one bucket; the ungrouped one keeps
				// its own, and inside a group the pill still names the member.
				expect(md).toContain('### 🎬 Maestro Core');
				expect(md).toContain('- Build pipeline broke _(rc)_');
				expect(md).toContain('- Routine cleanup _(Maestro)_');
				expect(md).toContain('### acappella');
				expect(md).toContain('- Voice models stalled');
				expect(md).not.toContain('_(acappella)_');
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
			// The field failure this whole branch exists for, verbatim: a 16 KB report
			// whose final `]` came out as `}`. Every section and bullet was written -
			// only one character was wrong - but the bracket-blind scanners counted
			// the object as balanced, so the repair path declared "nothing to repair"
			// and the user got a parse error over a report that was entirely intact.
			it('reports lossless when the last container was closed with the wrong bracket', () => {
				// The `]` that closes `sections` comes out as a second `}`.
				const fumbled = fullResponse.slice(0, -2) + '}}';
				expect(parseDirectorNotesNarrative(fumbled).ok).toBe(false);
				const result = recoverDirectorNotesNarrative(fumbled);
				expect(result.ok).toBe(true);
				if (!result.ok) return;
				expect(result.lossless).toBe(true);
				expect(result.narrative).toEqual(JSON.parse(fullResponse));
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
});
// Source: src/__tests__/shared/autorunModelHints.test.ts
describe('', () => {
	describe('findActiveModelHint', () => {
		it('returns null when the document sets no hint', () => {
			expect(findActiveModelHint('- [ ] do the thing')).toBeNull();
		});
		it('applies the marker above the next unfinished task', () => {
			const doc = `<!-- MAESTRO:MODEL tier="high" effort="high" -->\n\n- [ ] plan the migration`;
			expect(findActiveModelHint(doc)).toMatchObject({ tier: 'high', effort: 'high' });
		});
		it('takes the LAST marker above the task, because a hint is a setting', () => {
			// Unlike a HITL gate (where the earliest unacknowledged one wins because it
			// is a thing to stop at), the most recent assignment wins.
			const doc = [
				'<!-- MAESTRO:MODEL tier="low" -->',
				'<!-- MAESTRO:MODEL tier="high" -->',
				'- [ ] task',
			].join('\n');
			expect(findActiveModelHint(doc)?.tier).toBe('high');
		});
		it('steps over checked tasks so a half-done section keeps its setting', () => {
			// The completed half of a phase must not drop the model the rest of it
			// still needs - this is what makes one marker per section work.
			const doc = [
				'## Design',
				'<!-- MAESTRO:MODEL tier="high" -->',
				'- [x] sketch the approach',
				'- [ ] write the plan',
			].join('\n');
			expect(findActiveModelHint(doc)?.tier).toBe('high');
		});
		it('switches settings at a later section boundary', () => {
			const doc = [
				'<!-- MAESTRO:MODEL tier="high" -->',
				'- [x] design done',
				'<!-- MAESTRO:MODEL tier="low" -->',
				'- [ ] mechanical rename',
			].join('\n');
			expect(findActiveModelHint(doc)?.tier).toBe('low');
		});
		it('ignores markers inside fenced code so a playbook can document the syntax', () => {
			const doc = [
				'Explaining the feature:',
				'```markdown',
				'<!-- MAESTRO:MODEL tier="high" -->',
				'```',
				'- [ ] task',
			].join('\n');
			expect(findActiveModelHint(doc)).toBeNull();
		});
		it('reports no hint when every task is done', () => {
			// A trailing marker governs nothing - there is no task left for it to apply
			// to, so it must not be reported as active.
			const doc = ['- [x] done', '<!-- MAESTRO:MODEL tier="high" -->'].join('\n');
			expect(findActiveModelHint(doc)).toBeNull();
		});
		it('treats each axis independently', () => {
			const doc = `<!-- MAESTRO:MODEL effort="low" -->\n- [ ] task`;
			const hint = findActiveModelHint(doc);
			expect(hint?.effort).toBe('low');
			expect(hint?.tier).toBeUndefined();
		});
		it('keeps "default" as an explicit directive rather than collapsing it', () => {
			// It must survive parsing so a task-scoped `default` can override a
			// document-scoped level. Resolution treats it as "use the agent's value".
			const doc = `<!-- MAESTRO:MODEL tier="default" effort="default" -->\n- [ ] task`;
			const hint = findActiveModelHint(doc);
			expect(hint?.tier).toBe('default');
			expect(hint?.effort).toBe('default');
			expect(hint?.invalid).toBeUndefined();
		});
		it('records a misspelled value instead of silently ignoring it', () => {
			// A typo that resolved to "no hint" would run the task on the wrong model
			// with no signal, which is the exact failure this feature exists to avoid.
			const doc = `<!-- MAESTRO:MODEL tier="hgih" -->\n- [ ] task`;
			const hint = findActiveModelHint(doc);
			expect(hint?.tier).toBeUndefined();
			expect(hint?.invalid).toEqual([{ attribute: 'tier', value: 'hgih' }]);
		});
	});
	describe('hint scopes', () => {
		it('carries a document-scoped marker to every task below it', () => {
			const doc = [
				'<!-- MAESTRO:MODEL tier="low" effort="low" -->',
				'- [x] first',
				'- [ ] second',
				'- [ ] third',
			].join('\n');
			expect(findActiveModelHint(doc)).toMatchObject({ tier: 'low', effort: 'low' });
		});
		it('applies an inline marker to that task only', () => {
			const doc = ['- [ ] design the migration <!-- MAESTRO:MODEL tier="high" -->'].join('\n');
			const hint = findActiveModelHint(doc);
			expect(hint?.tier).toBe('high');
			expect(hint?.scopes?.tier).toBe('task');
		});
		it('reverts to the document scope once the inline task is checked off', () => {
			// The whole point of task scope: the NEXT task must not inherit it.
			const doc = [
				'<!-- MAESTRO:MODEL tier="low" effort="low" -->',
				'- [x] design the migration <!-- MAESTRO:MODEL tier="high" effort="high" -->',
				'- [ ] apply the renames',
			].join('\n');
			expect(findActiveModelHint(doc)).toMatchObject({ tier: 'low', effort: 'low' });
		});
		it('reverts to no hint at all when there was no document scope', () => {
			const doc = [
				'- [x] design the migration <!-- MAESTRO:MODEL tier="high" -->',
				'- [ ] apply the renames',
			].join('\n');
			expect(findActiveModelHint(doc)).toBeNull();
		});
		it('layers the two per axis rather than wholesale', () => {
			// A task raising only the tier must keep the document's effort - otherwise
			// tier="high" would silently LOWER the effort inside a high-effort section.
			const doc = [
				'<!-- MAESTRO:MODEL tier="low" effort="high" -->',
				'- [ ] design <!-- MAESTRO:MODEL tier="high" -->',
			].join('\n');
			const hint = findActiveModelHint(doc);
			expect(hint?.tier).toBe('high');
			expect(hint?.effort).toBe('high');
			expect(hint?.scopes).toEqual({ tier: 'task', effort: 'document' });
		});
		it('lets one task opt out of a document-wide hint with "default"', () => {
			const doc = [
				'<!-- MAESTRO:MODEL tier="high" effort="high" -->',
				'- [ ] trivial rename <!-- MAESTRO:MODEL tier="default" effort="default" -->',
			].join('\n');
			const hint = findActiveModelHint(doc);
			expect(hint?.tier).toBe('default');
			expect(hint?.effort).toBe('default');
		});
		it('does not let an inline marker on a checked task become a section marker', () => {
			const doc = ['- [x] design <!-- MAESTRO:MODEL tier="high" -->', '- [ ] a', '- [ ] b'].join(
				'\n'
			);
			expect(findActiveModelHint(doc)).toBeNull();
		});
		it('ignores an inline marker inside fenced code', () => {
			// The fence promise has to hold for BOTH forms, or a playbook that
			// documents the inline syntax silently changes its own model.
			const doc = [
				'```markdown',
				'- [ ] example <!-- MAESTRO:MODEL tier="high" -->',
				'```',
				'- [ ] the real task',
			].join('\n');
			expect(findActiveModelHint(doc)).toBeNull();
		});
		it('keeps a typo on either scope reportable after they merge', () => {
			// Merging must not swallow the document's invalid value in favor of the
			// task's, or a misspelled marker warns only until someone adds an inline
			// one below it.
			const doc = [
				'<!-- MAESTRO:MODEL tier="hgih" -->',
				'- [ ] design <!-- MAESTRO:MODEL effort="hihg" -->',
			].join('\n');
			expect(findActiveModelHint(doc)?.invalid).toEqual([
				{ attribute: 'tier', value: 'hgih' },
				{ attribute: 'effort', value: 'hihg' },
			]);
		});
	});
	describe('reason attribute', () => {
		it('parses the justification alongside the levels', () => {
			const doc = [
				'<!-- MAESTRO:MODEL tier="high" effort="high" reason="Lock ordering across three services. A wrong ordering corrupts data." -->',
				'- [ ] Design',
			].join('\n');
			expect(findActiveModelHint(doc)).toMatchObject({
				tier: 'high',
				effort: 'high',
				reason: 'Lock ordering across three services. A wrong ordering corrupts data.',
			});
		});
		it('never lets a reason change what the task runs on', () => {
			// The whole safety argument for the attribute: it is documentation, so it
			// must not reach model resolution even when it is the only thing present.
			const withReason = findActiveModelHint(
				'<!-- MAESTRO:MODEL tier="low" reason="Mechanical work." -->\n- [ ] x'
			);
			const without = findActiveModelHint('<!-- MAESTRO:MODEL tier="low" -->\n- [ ] x');
			expect(resolveTurnSettings('claude-code', withReason)).toEqual(
				resolveTurnSettings('claude-code', without)
			);
		});
		it('does not split a document-mode segment on differing reasons', () => {
			// Segmenting compares resolved model/effort. If prose reached that
			// comparison, editing a comment would cost an extra dispatch.
			const doc = [
				'- [ ] a <!-- MAESTRO:MODEL tier="low" reason="Because of one thing." -->',
				'- [ ] b <!-- MAESTRO:MODEL tier="low" reason="Because of something else." -->',
			].join('\n');
			expect(countTasksUnderActiveHint(doc, 'claude-code')).toEqual({ count: 2, total: 2 });
		});
		it('keeps the levels when an inner double quote truncates the reason', () => {
			// Degrading to a short sentence is fine; degrading to the wrong model is
			// not. tier and effort are matched independently of the prose.
			const hint = findActiveModelHint(
				'<!-- MAESTRO:MODEL tier="high" effort="high" reason="Uses the "fast" path." -->\n- [ ] x'
			);
			expect(hint).toMatchObject({ tier: 'high', effort: 'high', reason: 'Uses the' });
		});
		it('collapses newlines so a wrapped marker reads as one sentence', () => {
			const hint = findActiveModelHint(
				'<!-- MAESTRO:MODEL tier="low" reason="First line.   Second line." -->\n- [ ] x'
			);
			expect(hint?.reason).toBe('First line. Second line.');
		});
		it('truncates a reason too long to peek at', () => {
			const hint = findActiveModelHint(
				`<!-- MAESTRO:MODEL tier="low" reason="${'x'.repeat(600)}" -->\n- [ ] x`
			);
			expect(hint?.reason).toHaveLength(400);
			expect(hint?.reason?.endsWith('…')).toBe(true);
		});
		it('omits the field entirely when the attribute is absent or empty', () => {
			expect(
				findActiveModelHint('<!-- MAESTRO:MODEL tier="low" -->\n- [ ] x')?.reason
			).toBeUndefined();
			expect(
				findActiveModelHint('<!-- MAESTRO:MODEL tier="low" reason="  " -->\n- [ ] x')?.reason
			).toBeUndefined();
		});
		it('lets the narrower scope explain itself when the two merge', () => {
			const doc = [
				'<!-- MAESTRO:MODEL tier="low" reason="Mostly mechanical phase." -->',
				'- [ ] Design <!-- MAESTRO:MODEL tier="high" reason="This one needs judgment." -->',
			].join('\n');
			expect(findActiveModelHint(doc)).toMatchObject({
				tier: 'high',
				reason: 'This one needs judgment.',
			});
		});
		it('inherits the document reason when the task marker gives none', () => {
			const doc = [
				'<!-- MAESTRO:MODEL tier="low" reason="Mostly mechanical phase." -->',
				'- [ ] Design <!-- MAESTRO:MODEL effort="high" -->',
			].join('\n');
			expect(findActiveModelHint(doc)?.reason).toBe('Mostly mechanical phase.');
		});
	});
	describe('findAllModelHints', () => {
		it('collects every marker for authoring-time validation', () => {
			const doc = [
				'<!-- MAESTRO:MODEL tier="low" -->',
				'- [ ] a',
				'<!-- MAESTRO:MODEL tier="bogus" -->',
				'- [ ] b',
			].join('\n');
			const all = findAllModelHints(doc);
			expect(all).toHaveLength(2);
			expect(all[1].invalid).toEqual([{ attribute: 'tier', value: 'bogus' }]);
		});
		it('tags each marker with the scope it would apply at', () => {
			// Authoring-time validation reports where a hint reaches, so a marker the
			// author meant as document-wide but wrote onto a task line has to be
			// distinguishable from one that really is standalone.
			const doc = [
				'<!-- MAESTRO:MODEL tier="low" -->',
				'- [ ] a <!-- MAESTRO:MODEL tier="high" -->',
				'- [x] b <!-- MAESTRO:MODEL effort="high" -->',
			].join('\n');
			expect(findAllModelHints(doc).map((hint) => hint.scopes)).toEqual([
				{ tier: 'document' },
				{ tier: 'task' },
				{ effort: 'task' },
			]);
		});
	});
	describe('resolveTurnSettings', () => {
		it('leaves the agent config alone when there is no hint', () => {
			const resolved = resolveTurnSettings('claude-code', null, 'sonnet', 'medium');
			expect(resolved).toMatchObject({ model: 'sonnet', effort: 'medium' });
			expect(resolved.notes).toEqual([]);
			expect(resolved.warnings).toEqual([]);
		});
		it('overrides the agent config when the provider can honor the hint', () => {
			const hint = findActiveModelHint(`<!-- MAESTRO:MODEL tier="high" effort="high" -->\n- [ ] x`);
			const resolved = resolveTurnSettings('claude-code', hint, 'sonnet', 'medium');
			expect(resolved.model).toBe('opus');
			expect(resolved.effort).toBe('max');
			expect(resolved.warnings).toEqual([]);
		});
		it('falls back to the agent config AND warns when the provider cannot honor it', () => {
			// Running the task anyway is right, since the work still needs doing.
			// Doing it silently is how someone concludes the feature is broken.
			const hint = findActiveModelHint(`<!-- MAESTRO:MODEL tier="high" effort="high" -->\n- [ ] x`);
			const resolved = resolveTurnSettings('opencode', hint, 'ollama/qwen3:8b', undefined);
			expect(resolved.model).toBe('ollama/qwen3:8b');
			expect(resolved.effort).toBeUndefined();
			expect(resolved.warnings).toHaveLength(2);
			expect(resolved.warnings.join(' ')).toContain('opencode');
		});
		it('honors the axis it can and warns about the one it cannot', () => {
			// Codex has an effort ladder but no tier map, so a marker setting both
			// must not be all-or-nothing.
			const hint = findActiveModelHint(`<!-- MAESTRO:MODEL tier="high" effort="high" -->\n- [ ] x`);
			const resolved = resolveTurnSettings('codex', hint, 'gpt-5.3-codex', undefined);
			expect(resolved.effort).toBe('xhigh');
			expect(resolved.model).toBe('gpt-5.3-codex');
			expect(resolved.warnings).toHaveLength(1);
		});
		describe('after the provider refused the value a level maps to', () => {
			afterEach(() => {
				resetEffortRejections();
			});
			it('inherits the agent effort and says the provider refused it', () => {
				// Not "no level is mapped": the document is fine, the provider's
				// catalogue moved, and the author should be told which it was.
				noteEffortRejection('codex', {
					value: 'xhigh',
					model: 'gpt-6-luna',
					supported: ['low', 'medium', 'high'],
				});
				const hint = findActiveModelHint(`<!-- MAESTRO:MODEL effort="high" -->\n- [ ] x`);
				const resolved = resolveTurnSettings('codex', hint, 'gpt-6-luna', 'medium');
				expect(resolved.effort).toBe('medium');
				expect(resolved.notes).toEqual([]);
				expect(resolved.warnings).toEqual([
					'codex rejected effort "xhigh" for gpt-6-luna. It accepts low, medium, high. effort="high" was ignored; using the agent\'s configured effort.',
				]);
			});
			it('leaves a level that maps to a different value untouched', () => {
				noteEffortRejection('codex', { value: 'xhigh', supported: [] });
				const hint = findActiveModelHint(`<!-- MAESTRO:MODEL effort="low" -->\n- [ ] x`);
				const resolved = resolveTurnSettings('codex', hint, undefined, 'medium');
				expect(resolved.effort).toBe('low');
				expect(resolved.warnings).toEqual([]);
			});
		});
		it('resolves an explicit "default" back to the agent\'s own values', () => {
			const hint = findActiveModelHint(
				[
					'<!-- MAESTRO:MODEL tier="high" effort="high" -->',
					'- [ ] trivial <!-- MAESTRO:MODEL tier="default" effort="default" -->',
				].join('\n')
			);
			const resolved = resolveTurnSettings('claude-code', hint, 'sonnet', 'medium');
			expect(resolved.model).toBe('sonnet');
			expect(resolved.effort).toBe('medium');
			expect(resolved.warnings).toEqual([]);
		});
		it('reports which scope supplied each axis', () => {
			const hint = findActiveModelHint(
				[
					'<!-- MAESTRO:MODEL effort="high" -->',
					'- [ ] design <!-- MAESTRO:MODEL tier="high" -->',
				].join('\n')
			);
			const resolved = resolveTurnSettings('claude-code', hint, undefined, undefined);
			expect(resolved.notes.join(' ')).toContain('(task)');
			expect(resolved.notes.join(' ')).toContain('(document)');
		});
		it('surfaces a misspelled value as a warning', () => {
			const hint = findActiveModelHint(`<!-- MAESTRO:MODEL effort="hihg" -->\n- [ ] x`);
			const resolved = resolveTurnSettings('claude-code', hint, undefined, undefined);
			expect(resolved.warnings.join(' ')).toContain('hihg');
			expect(resolved.effort).toBeUndefined();
		});
	});
	describe('countTasksUnderActiveHint', () => {
		// The regression that would hurt: every playbook written before model hints
		// existed has no markers, so this path decides whether the whole existing
		// corpus keeps behaving as it always has.
		it('reports the whole document when nothing changes settings', () => {
			const content = ['- [ ] one', '- [ ] two', '- [ ] three'].join('\n');
			expect(countTasksUnderActiveHint(content, 'claude-code', 'sonnet', 'medium')).toEqual({
				count: 3,
				total: 3,
			});
		});
		it('stops at the task that asks for a different tier', () => {
			const content = [
				'<!-- MAESTRO:MODEL tier="low" -->',
				'- [ ] one',
				'- [ ] two',
				'- [ ] three <!-- MAESTRO:MODEL tier="high" -->',
				'- [ ] four',
			].join('\n');
			expect(countTasksUnderActiveHint(content, 'claude-code', 'sonnet', 'medium')).toEqual({
				count: 2,
				total: 4,
			});
		});
		it('stops when a standalone marker changes the settings partway down', () => {
			const content = [
				'- [ ] one',
				'<!-- MAESTRO:MODEL tier="high" -->',
				'- [ ] two',
				'- [ ] three',
			].join('\n');
			expect(countTasksUnderActiveHint(content, 'claude-code', 'sonnet', 'medium')).toEqual({
				count: 1,
				total: 3,
			});
		});
		// The whole reason this compares resolved settings instead of tier words:
		// codex has no tier table, so both tiers fall back to the agent's own model.
		// Splitting here would end one dispatch and start another at exactly the
		// same configuration.
		it('does not split on tier words that resolve to identical settings', () => {
			const content = [
				'<!-- MAESTRO:MODEL tier="low" -->',
				'- [ ] one',
				'- [ ] two <!-- MAESTRO:MODEL tier="high" -->',
			].join('\n');
			expect(countTasksUnderActiveHint(content, 'codex', 'gpt-5', 'medium')).toEqual({
				count: 2,
				total: 2,
			});
		});
		it('treats tier="default" as the agent baseline rather than a change', () => {
			const content = ['- [ ] one', '- [ ] two <!-- MAESTRO:MODEL tier="default" -->'].join('\n');
			expect(countTasksUnderActiveHint(content, 'claude-code', 'sonnet', 'medium')).toEqual({
				count: 2,
				total: 2,
			});
		});
		it('ignores checked tasks and counts only what remains', () => {
			const content = ['- [x] done', '- [ ] one', '- [ ] two'].join('\n');
			expect(countTasksUnderActiveHint(content, 'claude-code', 'sonnet', 'medium')).toEqual({
				count: 2,
				total: 2,
			});
		});
		it('reports nothing for a document with no unchecked tasks', () => {
			expect(countTasksUnderActiveHint('- [x] done', 'claude-code')).toEqual({
				count: 0,
				total: 0,
			});
		});
	});
	describe('describeSegmentLimit', () => {
		it('returns nothing when the whole remainder shares one setting', () => {
			expect(describeSegmentLimit({ count: 3, total: 3 })).toBe('');
			expect(describeSegmentLimit(undefined)).toBe('');
		});
		it('names the boundary when the settings change partway down', () => {
			const text = describeSegmentLimit({ count: 2, total: 5 });
			expect(text).toContain('ONLY the next 2 unchecked tasks');
			expect(text).toContain('separate pass');
		});
		it('says "task" rather than "tasks" for a single one', () => {
			expect(describeSegmentLimit({ count: 1, total: 4 })).toContain('next 1 unchecked task,');
		});
	});
	/**
	 * The contract the two pieces make together: a document that changes settings
	 * partway down must produce MORE THAN ONE dispatch, each at its own resolved
	 * model, rather than one dispatch that silently runs every task at whatever the
	 * first task asked for. The engines recompute both of these per dispatch from
	 * the document as it stands, so replaying them over the checked-off document is
	 * the same walk the runner does.
	 */
	describe('document-mode dispatch boundary', () => {
		const dispatch = (content: string) => {
			const settings = resolveTurnSettings(
				'claude-code',
				findActiveModelHint(content),
				'sonnet',
				'medium'
			);
			const segment = countTasksUnderActiveHint(content, 'claude-code', 'sonnet', 'medium');
			return { model: settings.model, effort: settings.effort, segment };
		};
		it('splits a mixed-tier document into two dispatches at different models', () => {
			const first = dispatch(
				[
					'<!-- MAESTRO:MODEL tier="low" -->',
					'- [ ] one',
					'- [ ] two',
					'- [ ] three <!-- MAESTRO:MODEL tier="high" -->',
				].join('\n')
			);
			expect(first.segment).toEqual({ count: 2, total: 3 });
			// The runner checks off what it completed and comes back around.
			const second = dispatch(
				[
					'<!-- MAESTRO:MODEL tier="low" -->',
					'- [x] one',
					'- [x] two',
					'- [ ] three <!-- MAESTRO:MODEL tier="high" -->',
				].join('\n')
			);
			expect(second.segment).toEqual({ count: 1, total: 1 });
			// Two dispatches, and they are genuinely at different models - not two
			// passes over the same configuration.
			expect(first.model).toBeTruthy();
			expect(second.model).toBeTruthy();
			expect(second.model).not.toBe(first.model);
		});
		it('leaves an unmarked document as a single whole-document dispatch', () => {
			const only = dispatch(['- [ ] one', '- [ ] two', '- [ ] three'].join('\n'));
			expect(only.segment).toEqual({ count: 3, total: 3 });
			expect(describeSegmentLimit(only.segment)).toBe('');
			expect(only.model).toBe('sonnet');
			expect(only.effort).toBe('medium');
		});
	});
});
// Source: src/__tests__/shared/autorunAutoResume.test.ts
describe('', () => {
	describe('autoResumeEnabled', () => {
		it('treats an absent flag as ON so an existing run is protected', () => {
			expect(autoResumeEnabled(undefined)).toBe(true);
			expect(autoResumeEnabled(true)).toBe(true);
		});
		it('only an explicit false opts out', () => {
			expect(autoResumeEnabled(false)).toBe(false);
		});
	});
	describe('clampAutoResumeMinutes', () => {
		it('keeps a value inside the range', () => {
			expect(clampAutoResumeMinutes(12)).toBe(12);
		});
		it('clamps to the bounds rather than rejecting', () => {
			expect(clampAutoResumeMinutes(0)).toBe(AUTO_RESUME_MIN_MINUTES);
			expect(clampAutoResumeMinutes(-30)).toBe(AUTO_RESUME_MIN_MINUTES);
			expect(clampAutoResumeMinutes(10000)).toBe(AUTO_RESUME_MAX_MINUTES);
		});
		it('falls back to the default for junk, which is what an empty input sends', () => {
			expect(clampAutoResumeMinutes(NaN)).toBe(AUTO_RESUME_DEFAULT_MINUTES);
			expect(clampAutoResumeMinutes(undefined)).toBe(AUTO_RESUME_DEFAULT_MINUTES);
			expect(clampAutoResumeMinutes('five')).toBe(AUTO_RESUME_DEFAULT_MINUTES);
		});
		it('rounds a fractional value to whole minutes', () => {
			expect(clampAutoResumeMinutes(7.4)).toBe(7);
		});
	});
	describe('clampMaxAutoResumes', () => {
		it('clamps to the bounds', () => {
			expect(clampMaxAutoResumes(0)).toBe(AUTO_RESUME_MIN_ATTEMPTS);
			expect(clampMaxAutoResumes(9999)).toBe(AUTO_RESUME_MAX_ATTEMPTS);
		});
		it('falls back to the default for junk', () => {
			expect(clampMaxAutoResumes(undefined)).toBe(AUTO_RESUME_DEFAULT_MAX_ATTEMPTS);
		});
	});
	describe('resolveAutoResumePolicy', () => {
		it('gives the documented defaults for a config that says nothing', () => {
			expect(resolveAutoResumePolicy({})).toEqual({
				delayMs: AUTO_RESUME_DEFAULT_MINUTES * 60000,
				maxAttempts: AUTO_RESUME_DEFAULT_MAX_ATTEMPTS,
			});
		});
		it('gives the same defaults for a missing config entirely', () => {
			// A run launched from the CLI, or restored from a playbook written before
			// this existed, must still auto-resume.
			expect(resolveAutoResumePolicy(undefined)).toEqual({
				delayMs: AUTO_RESUME_DEFAULT_MINUTES * 60000,
				maxAttempts: AUTO_RESUME_DEFAULT_MAX_ATTEMPTS,
			});
			expect(resolveAutoResumePolicy(null)).not.toBeNull();
		});
		it('returns null when the run opted out', () => {
			expect(resolveAutoResumePolicy({ autoResumeOnError: false })).toBeNull();
		});
		it('converts minutes to milliseconds', () => {
			expect(resolveAutoResumePolicy({ autoResumeAfterMin: 3 })?.delayMs).toBe(180000);
		});
		it('clamps a config that would otherwise hammer the run', () => {
			const policy = resolveAutoResumePolicy({ autoResumeAfterMin: 0, maxAutoResumes: 100000 });
			expect(policy?.delayMs).toBe(AUTO_RESUME_MIN_MINUTES * 60000);
			expect(policy?.maxAttempts).toBe(AUTO_RESUME_MAX_ATTEMPTS);
		});
	});
});

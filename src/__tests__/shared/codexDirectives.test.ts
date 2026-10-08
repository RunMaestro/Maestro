/**
 * Tests for the Codex assistant-directive parser.
 *
 * The grammar is a wire format Maestro only gets to read, so these tests are
 * written from the producer's side: the real followup out of the bug report,
 * the shapes the bundled Codex skills emit, and the malformed candidates that
 * must fail rather than be guessed at. A parse that succeeds tells a caller it
 * may delete exactly `raw` from the assistant's prose, which is why every
 * rejection below matters as much as every acceptance.
 */

import { describe, it, expect } from 'vitest';
import {
	DEFAULT_CODEX_DIRECTIVE_BUDGET,
	KNOWN_CODEX_DIRECTIVES,
	findCodexDirectives,
	isKnownCodexDirective,
	parseCodexDirective,
} from '../../shared/codexDirectives';

describe('parseCodexDirective', () => {
	it('parses the real-world followup from the bug report', () => {
		const source =
			':codex-followup[Design the canonical schema]{prompt="Design the canonical Four Arrows medication, lab, citation, and review schema based on this audit."}';

		const directive = parseCodexDirective(source);

		expect(directive).not.toBeNull();
		expect(directive?.name).toBe('codex-followup');
		expect(directive?.label).toBe('Design the canonical schema');
		expect(directive?.attributes.prompt).toBe(
			'Design the canonical Four Arrows medication, lab, citation, and review schema based on this audit.'
		);
		expect(directive?.raw).toBe(source);
	});

	it('parses a quoted attribute beside a bare one', () => {
		const directive = parseCodexDirective('::git-create-pr{cwd="/repo" isDraft=true}');

		expect(directive?.name).toBe('git-create-pr');
		expect(directive?.attributes).toEqual({ cwd: '/repo', isDraft: 'true' });
		// Bare values stay strings. Nothing here coerces `true` to a boolean.
		expect(directive?.attributes.isDraft).toBe('true');
	});

	it('does not let a `}` inside a quoted value terminate the directive', () => {
		const source = String.raw`::code-comment{body="Keep \"x}\" literal."}`;

		const directive = parseCodexDirective(source);

		expect(directive?.name).toBe('code-comment');
		expect(directive?.attributes.body).toBe('Keep "x}" literal.');
		expect(directive?.raw).toBe(source);
	});

	it('accepts single-quoted values', () => {
		const directive = parseCodexDirective(
			`::git-commit{message='Add the "shared" parser' cwd='/repo'}`
		);

		expect(directive?.attributes).toEqual({
			message: 'Add the "shared" parser',
			cwd: '/repo',
		});
	});

	it('parses a directive with no attributes at all', () => {
		expect(parseCodexDirective('::git-push{}')).toEqual({
			name: 'git-push',
			attributes: {},
			raw: '::git-push{}',
		});
	});

	it('accepts one, two, and three colons', () => {
		for (const prefix of [':', '::', ':::']) {
			expect(parseCodexDirective(`${prefix}git-push{cwd="/repo"}`)?.name).toBe('git-push');
		}
	});

	it('stops `raw` at the closing brace, excluding trailing prose', () => {
		const directive = parseCodexDirective('::git-push{cwd="/repo"} done');

		expect(directive?.raw).toBe('::git-push{cwd="/repo"}');
		expect(directive?.raw.endsWith('}')).toBe(true);
	});

	it('omits `label` when the directive carries none', () => {
		expect(parseCodexDirective('::git-push{cwd="/repo"}')).not.toHaveProperty('label');
	});

	it('accepts an empty label and an empty quoted value', () => {
		const directive = parseCodexDirective('::codex-followup[]{prompt=""}');

		expect(directive?.label).toBe('');
		expect(directive?.attributes.prompt).toBe('');
	});

	describe('rejections', () => {
		const rejected: Array<[string, string]> = [
			['no colons', 'git-push{cwd="/repo"}'],
			['four colons', '::::git-push{cwd="/repo"}'],
			['a name starting with a digit', '::9git{cwd="/repo"}'],
			['whitespace before the brace', '::git-create-pr {cwd="/repo"}'],
			['prose after the name', '::git-create-pr prose'],
			['a duplicate key', '::git-push{cwd="/repo" cwd="/other"}'],
			['an unterminated quote', '::git-push{cwd="/repo'],
			['a newline inside a quoted value', '::git-push{cwd="/re\npo"}'],
			['an empty bare value', '::git-push{cwd=}'],
			['a bare value that is only a space', '::git-push{cwd= }'],
			['an unterminated brace', '::git-push{cwd="/repo"'],
			['a key with no value', '::git-push{cwd}'],
			['an unterminated label', '::codex-followup[Go{prompt="go"}'],
			['a newline inside a label', '::codex-followup[G\no]{prompt="go"}'],
			['two attributes with no separator', '::git-push{a="x"b="y"}'],
			['a newline where a separator belongs', '::git-push{a="x"\nb="y"}'],
			['an empty string', ''],
			['a bare colon', ':'],
		];

		for (const [description, source] of rejected) {
			it(`returns null for ${description}`, () => {
				expect(parseCodexDirective(source)).toBeNull();
			});
		}
	});

	describe('escaping modes', () => {
		it("decodes escaped quotes in 'backslash' mode (the default)", () => {
			const directive = parseCodexDirective(String.raw`::git-commit{message="say \"hi\""}`, {
				escaping: 'backslash',
			});

			expect(directive?.attributes.message).toBe('say "hi"');
		});

		it('keeps other escape pairs verbatim, so a Windows path survives', () => {
			const directive = parseCodexDirective(String.raw`::git-push{cwd="C:\repo\new"}`);

			expect(directive?.attributes.cwd).toBe(String.raw`C:\repo\new`);
		});

		it("ends a value at the first quote in 'literal' mode", () => {
			const directive = parseCodexDirective(String.raw`::git-commit{message="a\" b=2}`, {
				escaping: 'literal',
			});

			// The value stops at the quote after the backslash, so the backslash
			// is part of it and `b=2` is a second attribute.
			expect(directive?.attributes).toEqual({ message: 'a\\', b: '2' });
		});
	});

	describe('scan budget', () => {
		// Terminated, but only past a small budget - so a null here proves the
		// budget stopped the scan rather than the input simply being malformed.
		const long = `::code-comment{body="${'x'.repeat(4000)}"}`;

		it('returns null once the scan exceeds the budget', () => {
			expect(parseCodexDirective(long, { budget: 64 })).toBeNull();
		});

		it('parses the same source when the budget allows it', () => {
			expect(parseCodexDirective(long, { budget: 8192 })?.attributes.body).toHaveLength(4000);
		});

		it('does not scan a pathological unterminated quote to the end', () => {
			const pathological = `::code-comment{body="${'x'.repeat(1_000_000)}`;

			expect(parseCodexDirective(pathological, { budget: 64 })).toBeNull();
			// The default budget bounds it too, with no options passed at all.
			expect(parseCodexDirective(pathological)).toBeNull();
		});

		it('accepts a directive exactly as long as the budget', () => {
			const source = '::git-push{}';

			expect(parseCodexDirective(source, { budget: source.length })?.name).toBe('git-push');
			expect(parseCodexDirective(source, { budget: source.length - 1 })).toBeNull();
		});

		it('defaults to DEFAULT_CODEX_DIRECTIVE_BUDGET', () => {
			expect(DEFAULT_CODEX_DIRECTIVE_BUDGET).toBe(8192);
		});
	});
});

describe('isKnownCodexDirective', () => {
	it('accepts every name in the allowlist', () => {
		for (const name of KNOWN_CODEX_DIRECTIVES) {
			expect(isKnownCodexDirective(name)).toBe(true);
		}
	});

	it('rejects a name that merely parses', () => {
		expect(isKnownCodexDirective('before')).toBe(false);
		expect(isKnownCodexDirective('codex-followups')).toBe(false);
		expect(isKnownCodexDirective('')).toBe(false);
	});
});

describe('findCodexDirectives', () => {
	it('skips unknown names, so prose about CSS is not a directive', () => {
		const source = 'Some prose with a::before{color:red} and :codex-followup[Go]{prompt="go"}';

		const found = findCodexDirectives(source);

		expect(found).toHaveLength(1);
		expect(found[0].name).toBe('codex-followup');
		expect(found[0].label).toBe('Go');
	});

	it('skips a well-formed directive whose name is not on the allowlist', () => {
		expect(findCodexDirectives('a::before{color=red} is CSS')).toEqual([]);
	});

	it('reports exact offsets, so slicing the source reproduces `raw`', () => {
		const source = [
			'Created :codex-file-citation{path="/tmp/plan.docx" purpose="output"} for you.',
			'',
			'- :codex-followup[Design the schema]{prompt="Design the schema."}',
			'- :codex-followup[Review it]{prompt="Review the schema."}',
		].join('\n');

		const found = findCodexDirectives(source);

		expect(found.map((match) => match.name)).toEqual([
			'codex-file-citation',
			'codex-followup',
			'codex-followup',
		]);
		for (const match of found) {
			expect(source.slice(match.start, match.end)).toBe(match.raw);
		}
	});

	it('returns matches in source order with non-overlapping ranges', () => {
		const source = '::git-stage{paths="a"} then ::git-commit{message="m"} then ::git-push{}';

		const found = findCodexDirectives(source);

		expect(found.map((match) => match.name)).toEqual(['git-stage', 'git-commit', 'git-push']);
		expect(found[0].end).toBeLessThan(found[1].start);
		expect(found[1].end).toBeLessThan(found[2].start);
	});

	it('does not read a four-colon run as the legal three-colon form', () => {
		expect(findCodexDirectives('::::git-push{cwd="/repo"}')).toEqual([]);
	});

	it('returns nothing for text with no directives', () => {
		expect(findCodexDirectives('')).toEqual([]);
		expect(findCodexDirectives('no colons at all')).toEqual([]);
		expect(findCodexDirectives('a ratio of 3:1, and a time of 10:30')).toEqual([]);
	});

	it('leaves a malformed candidate alone rather than eating the rest of the line', () => {
		const source = '::git-push{cwd="/repo and then some ordinary prose';

		expect(findCodexDirectives(source)).toEqual([]);
	});

	it('passes options through to the parser', () => {
		const source = String.raw`::code-comment{body="Keep \"x}\" literal."}`;

		expect(findCodexDirectives(source)).toHaveLength(1);
		// In 'literal' mode the same source is malformed, so nothing matches.
		expect(findCodexDirectives(source, { escaping: 'literal' })).toEqual([]);
	});
});

// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/codexDirectives.test.ts
// Source: src/__tests__/shared/typography.test.ts
// Source: src/__tests__/shared/stringUtils.test.ts
// Source: src/__tests__/shared/emojiUtils.test.ts
// Source: src/__tests__/shared/symphony-types.test.ts
// Source: src/__tests__/shared/modelUsage.test.ts
import { describe, it, expect } from 'vitest';
import {
	DEFAULT_CODEX_DIRECTIVE_BUDGET,
	KNOWN_CODEX_DIRECTIVES,
	findCodexContentReferences,
	findCodexDirectives,
	isKnownCodexDirective,
	parseCodexDirective,
} from '../../shared/codexDirectives';
import {
	FONT_ZOOM_DEFAULT,
	FONT_ZOOM_MAX,
	FONT_ZOOM_MIN,
	SURFACE_FONT_SIZE_MAX,
	SURFACE_FONT_SIZE_MIN,
	INHERIT_TERMINAL,
	TYPOGRAPHY_ROOTS,
	TYPOGRAPHY_SURFACES,
	inheritOptionsForSurface,
	resolveInheritRoot,
	resolveInheritedFont,
	TYPOGRAPHY_SURFACE_LIST,
	TYPOGRAPHY_SURFACE_SPECS,
	clampFontZoom,
	clampSurfaceFontSize,
	resolveSurfaceFontSize,
	resolveTypographySurface,
} from '../../shared/typography';
import { safeDecodeURIComponent, stripAnsiCodes } from '../../shared/stringUtils';
/**
 * Tests for shared emoji utilities
 */
import {
	stripLeadingEmojis,
	nameSortKey,
	compareNamesIgnoringEmojis,
} from '../../shared/emojiUtils';
import {
	SymphonyError,
	type SymphonyCategory,
	type SymphonyIssue,
	type SymphonyCache,
	type ContributionStatus,
	type IssueStatus,
} from '../../shared/symphony-types';
import { ModelUsageAccumulator, claudeModelUsage } from '../../shared/modelUsage';
import { calculateModelCost, type ModelCost } from '../../shared/modelPricing';
// Source: src/__tests__/shared/codexDirectives.test.ts
describe('', () => {
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
				const pathological = `::code-comment{body="${'x'.repeat(1000000)}`;
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
	describe('content references (U+E200 grammar)', () => {
		const ref = (name: string, payload: string) => `\uE200${name}\uE202${payload}\uE201`;
		it('parses the visualize reference Codex emitted in the field', () => {
			const raw = ref('visualize', '{"path":"/Users/p/designs/dropdown-hints.html","mode":"wide"}');
			const source = `Mocks below.\n\n${raw}`;
			const [match] = findCodexDirectives(source);
			expect(match).toMatchObject({
				name: 'visualize',
				attributes: { path: '/Users/p/designs/dropdown-hints.html', mode: 'wide' },
				raw,
			});
			expect(source.slice(match.start, match.end)).toBe(raw);
		});
		it('keeps a non-JSON payload whole as ref', () => {
			expect(findCodexContentReferences(`Fact.${ref('cite', 'turn0view0')}`)).toEqual([
				expect.objectContaining({ name: 'cite', attributes: { ref: 'turn0view0' } }),
			]);
		});
		it('keeps only string fields of a JSON payload', () => {
			const [match] = findCodexContentReferences(ref('visualize', '{"path":"/a.html","n":3}'));
			expect(match.attributes).toEqual({ path: '/a.html' });
		});
		it('rejects unknown names, malformed JSON, newlines and a missing terminator', () => {
			expect(findCodexContentReferences(ref('mystery', '{}'))).toEqual([]);
			expect(findCodexContentReferences(ref('visualize', '{"path":'))).toEqual([]);
			expect(findCodexContentReferences(ref('visualize', '{"path":\n"/a"}'))).toEqual([]);
			expect(findCodexContentReferences('\uE200visualize\uE202{"path":"/a"}')).toEqual([]);
		});
		it('orders references among colon directives and ignores colons inside a payload', () => {
			const source = `${ref('visualize', '{"path":"/a.html"}')} then :codex-followup[Go]{prompt="go"}`;
			expect(findCodexDirectives(source).map((m) => m.name)).toEqual([
				'visualize',
				'codex-followup',
			]);
		});
	});
});
// Source: src/__tests__/shared/typography.test.ts
describe('', () => {
	describe('typography surface registry', () => {
		it('gives every surface a unique settings key and CSS variable', () => {
			// A shared key would make two surfaces silently overwrite each other.
			const keys = TYPOGRAPHY_SURFACE_LIST.flatMap((s) => [s.fontKey, s.sizeKey]);
			const vars = TYPOGRAPHY_SURFACE_LIST.flatMap((s) => [s.fontVar, s.sizeVar]);
			expect(new Set(keys).size).toBe(keys.length);
			expect(new Set(vars).size).toBe(vars.length);
		});
		it('makes exactly one surface inherit from nothing', () => {
			// `interface` is the base of the whole graph. `terminal` is a root others
			// may follow, but it still follows the interface itself.
			const bases = TYPOGRAPHY_SURFACE_LIST.filter((s) => s.inheritsFrom.length === 0);
			expect(bases).toHaveLength(1);
			expect(bases[0].id).toBe('interface');
		});
		it('keeps the inheritance graph exactly two levels deep', () => {
			// This is what makes a cycle impossible without a graph walk to detect
			// one: every surface a root can follow must itself follow nothing.
			for (const root of TYPOGRAPHY_ROOTS) {
				for (const parent of TYPOGRAPHY_SURFACE_SPECS[root].inheritsFrom) {
					expect(TYPOGRAPHY_SURFACE_SPECS[parent].inheritsFrom).toEqual([]);
				}
			}
		});
		it('only ever points a surface at a declared root', () => {
			for (const spec of TYPOGRAPHY_SURFACE_LIST) {
				for (const parent of spec.inheritsFrom) {
					expect(TYPOGRAPHY_ROOTS).toContain(parent);
				}
			}
		});
		it('never lets a surface inherit from itself', () => {
			for (const spec of TYPOGRAPHY_SURFACE_LIST) {
				expect(spec.inheritsFrom).not.toContain(spec.id);
			}
		});
		it('keeps the ordered list and the spec map in agreement', () => {
			expect(TYPOGRAPHY_SURFACE_LIST.map((s) => s.id)).toEqual([...TYPOGRAPHY_SURFACES]);
			for (const id of TYPOGRAPHY_SURFACES) {
				expect(TYPOGRAPHY_SURFACE_SPECS[id].id).toBe(id);
			}
		});
		it('does not let an alias collide with another surface id', () => {
			const ids = new Set<string>(TYPOGRAPHY_SURFACES);
			for (const spec of TYPOGRAPHY_SURFACE_LIST) {
				for (const alias of spec.aliases) {
					expect(ids.has(alias)).toBe(false);
				}
			}
		});
	});
	describe('resolveTypographySurface', () => {
		it('resolves by id, alias, and label spelling', () => {
			expect(resolveTypographySurface('filePreview')?.id).toBe('filePreview');
			expect(resolveTypographySurface('preview')?.id).toBe('filePreview');
			expect(resolveTypographySurface('ui')?.id).toBe('interface');
		});
		it('ignores case, spaces, hyphens, and underscores', () => {
			// A CLI user types file-preview or file_preview at least as often as the
			// camelCase key, and rejecting those is pure friction.
			for (const spelling of ['File Preview', 'file-preview', 'FILE_PREVIEW', ' filepreview ']) {
				expect(resolveTypographySurface(spelling)?.id).toBe('filePreview');
			}
		});
		it('returns null for an unknown surface rather than guessing', () => {
			expect(resolveTypographySurface('sidebar')).toBeNull();
			expect(resolveTypographySurface('')).toBeNull();
		});
	});
	describe('clampFontZoom', () => {
		it('clamps to the supported range', () => {
			expect(clampFontZoom(99)).toBe(FONT_ZOOM_MAX);
			expect(clampFontZoom(0.01)).toBe(FONT_ZOOM_MIN);
		});
		it('falls back to 100% for a non-finite value', () => {
			// A corrupted setting must not render the app at NaN pixels. Any
			// non-finite value is treated as corruption and returns the default
			// rather than being clamped to an extreme.
			expect(clampFontZoom(NaN)).toBe(FONT_ZOOM_DEFAULT);
			expect(clampFontZoom(Infinity)).toBe(FONT_ZOOM_DEFAULT);
			expect(clampFontZoom(-Infinity)).toBe(FONT_ZOOM_DEFAULT);
		});
		it('rounds to two decimals so repeated steps do not drift', () => {
			expect(clampFontZoom(1.0000001)).toBe(1);
			expect(clampFontZoom(1.2349)).toBe(1.23);
		});
	});
	describe('clampSurfaceFontSize', () => {
		it('treats zero and negatives as "inherit"', () => {
			expect(clampSurfaceFontSize(0)).toBe(0);
			expect(clampSurfaceFontSize(-4)).toBe(0);
		});
		it('clamps a real size into range', () => {
			expect(clampSurfaceFontSize(999)).toBe(SURFACE_FONT_SIZE_MAX);
			expect(clampSurfaceFontSize(1)).toBe(SURFACE_FONT_SIZE_MIN);
		});
	});
	describe('resolveSurfaceFontSize', () => {
		it('falls back to the base size when the surface has none', () => {
			expect(resolveSurfaceFontSize(0, 15, 1)).toBe(15);
			expect(resolveSurfaceFontSize(undefined, 15, 1)).toBe(15);
		});
		it('prefers the surface size over the base', () => {
			expect(resolveSurfaceFontSize(13, 15, 1)).toBe(13);
		});
		it('scales every surface by the same ratio, preserving their proportions', () => {
			// This is the property that makes zoom safe: a user who set the terminal
			// smaller than the chat keeps that relationship at every zoom level.
			const chat = resolveSurfaceFontSize(16, 16, 1.5);
			const terminal = resolveSurfaceFontSize(12, 16, 1.5);
			expect(chat / terminal).toBeCloseTo(16 / 12, 5);
		});
		it('is reversible, so zooming out returns to the original size', () => {
			// Pushing the base around instead would clamp and lose the value.
			const base = 15;
			expect(resolveSurfaceFontSize(base, base, 2)).toBe(30);
			expect(resolveSurfaceFontSize(base, base, 1)).toBe(base);
		});
		it('keeps one decimal so consecutive zoom steps stay distinguishable', () => {
			// Whole-pixel rounding makes 1.0 and 1.05 both land on 11px at small
			// sizes, so a keypress appears to do nothing.
			expect(resolveSurfaceFontSize(11, 11, 1)).toBe(11);
			expect(resolveSurfaceFontSize(11, 11, 1.05)).toBe(11.6);
		});
		it('survives a zero or corrupted base', () => {
			expect(resolveSurfaceFontSize(0, 0, 1)).toBeGreaterThan(0);
		});
	});
	describe('two-root inheritance', () => {
		const roots = { interface: 'Inter', terminal: 'JetBrains Mono' };
		it('treats the empty string as "follow the interface"', () => {
			// Every existing install stores '' on surfaces it never customized, so
			// this meaning must not move.
			expect(resolveInheritedFont('', roots)).toBe('Inter');
			expect(resolveInheritRoot('')).toBe('interface');
		});
		it('follows the terminal when pointed at it', () => {
			expect(resolveInheritedFont(INHERIT_TERMINAL, roots)).toBe('JetBrains Mono');
			expect(resolveInheritRoot(INHERIT_TERMINAL)).toBe('terminal');
		});
		it('prefers a font of its own over either root', () => {
			expect(resolveInheritedFont('Georgia', roots)).toBe('Georgia');
			expect(resolveInheritRoot('Georgia')).toBeNull();
		});
		it('falls through to the interface when the terminal itself inherits', () => {
			// The second and final hop. Returning empty here would leave the surface
			// with no font at all.
			expect(resolveInheritedFont(INHERIT_TERMINAL, { interface: 'Inter', terminal: '' })).toBe(
				'Inter'
			);
		});
		it('cannot loop, even if the terminal somehow stored the sentinel itself', () => {
			// Defensive: the UI cannot produce this, but a hand-edited settings file
			// could, and it must terminate rather than recurse.
			expect(
				resolveInheritedFont(INHERIT_TERMINAL, {
					interface: 'Inter',
					terminal: INHERIT_TERMINAL,
				})
			).toBe('Inter');
		});
		it('ignores surrounding whitespace on a stored value', () => {
			expect(resolveInheritedFont('   ', roots)).toBe('Inter');
			expect(resolveInheritedFont(` ${INHERIT_TERMINAL} `, roots)).toBe('JetBrains Mono');
		});
		it('uses a sentinel no real font name can collide with', () => {
			// A CSS font-family cannot begin with '@', so a user typing a name into
			// the custom-font box can never accidentally produce this value.
			expect(INHERIT_TERMINAL.startsWith('@')).toBe(true);
		});
		describe('picker options', () => {
			it('offers both roots to a dependent surface', () => {
				const options = inheritOptionsForSurface(TYPOGRAPHY_SURFACE_SPECS.chat);
				expect(options.map((o) => o.root)).toEqual(['interface', 'terminal']);
				expect(options.map((o) => o.value)).toEqual(['', INHERIT_TERMINAL]);
			});
			it('offers only the interface to the terminal', () => {
				// Terminal is a root; letting it follow another surface is what would
				// open the door to a cycle.
				const options = inheritOptionsForSurface(TYPOGRAPHY_SURFACE_SPECS.terminal);
				expect(options.map((o) => o.root)).toEqual(['interface']);
			});
			it('offers nothing to the interface', () => {
				expect(inheritOptionsForSurface(TYPOGRAPHY_SURFACE_SPECS.interface)).toEqual([]);
			});
			it('labels each option after the surface it follows', () => {
				const options = inheritOptionsForSurface(TYPOGRAPHY_SURFACE_SPECS.fileEditor);
				expect(options.map((o) => o.label)).toEqual([
					'Same as interface font',
					'Same as terminal font',
				]);
			});
		});
	});
	describe('document graph surface', () => {
		it('is registered like any other surface', () => {
			// The canvas cannot read a CSS variable, but the SETTING is ordinary: the
			// registry is what makes the picker, the CLI verb, and the CSS variable
			// appear without touching any of them individually.
			const spec = TYPOGRAPHY_SURFACE_SPECS.documentGraph;
			expect(spec.fontKey).toBe('documentGraphFontFamily');
			expect(spec.sizeKey).toBe('documentGraphFontSize');
		});
		it('may follow either root', () => {
			expect(TYPOGRAPHY_SURFACE_SPECS.documentGraph.inheritsFrom).toEqual([
				'interface',
				'terminal',
			]);
		});
		it('makes six surfaces, which fills a two-column grid evenly', () => {
			expect(TYPOGRAPHY_SURFACES).toHaveLength(6);
			expect(TYPOGRAPHY_SURFACES.length % 2).toBe(0);
		});
		it('is reachable from the CLI by its aliases', () => {
			for (const name of ['documentGraph', 'graph', 'mindmap', 'docgraph', 'document-graph']) {
				expect(resolveTypographySurface(name)?.id).toBe('documentGraph');
			}
		});
	});
});
// Source: src/__tests__/shared/stringUtils.test.ts
describe('', () => {
	describe('stripAnsiCodes', () => {
		it('should return empty string for empty input', () => {
			expect(stripAnsiCodes('')).toBe('');
		});
		it('should return text unchanged when no ANSI codes present', () => {
			expect(stripAnsiCodes('Hello, World!')).toBe('Hello, World!');
			expect(stripAnsiCodes('No escape codes here')).toBe('No escape codes here');
		});
		it('should strip basic color codes', () => {
			// Red text
			expect(stripAnsiCodes('\x1b[31mRed text\x1b[0m')).toBe('Red text');
			// Green text
			expect(stripAnsiCodes('\x1b[32mGreen text\x1b[0m')).toBe('Green text');
			// Blue text
			expect(stripAnsiCodes('\x1b[34mBlue text\x1b[0m')).toBe('Blue text');
		});
		it('should strip reset codes', () => {
			expect(stripAnsiCodes('\x1b[0mReset')).toBe('Reset');
			expect(stripAnsiCodes('Text\x1b[0m')).toBe('Text');
		});
		it('should strip bold and other style codes', () => {
			// Bold
			expect(stripAnsiCodes('\x1b[1mBold\x1b[0m')).toBe('Bold');
			// Italic
			expect(stripAnsiCodes('\x1b[3mItalic\x1b[0m')).toBe('Italic');
			// Underline
			expect(stripAnsiCodes('\x1b[4mUnderline\x1b[0m')).toBe('Underline');
		});
		it('should strip combined style and color codes', () => {
			// Bold + Red
			expect(stripAnsiCodes('\x1b[1;31mBold Red\x1b[0m')).toBe('Bold Red');
			// Bold + Green + Underline
			expect(stripAnsiCodes('\x1b[1;32;4mStyled\x1b[0m')).toBe('Styled');
		});
		it('should strip multiple codes in sequence', () => {
			const input = '\x1b[32mGreen\x1b[0m and \x1b[34mBlue\x1b[0m text';
			expect(stripAnsiCodes(input)).toBe('Green and Blue text');
		});
		it('should strip codes at various positions', () => {
			// Code at start
			expect(stripAnsiCodes('\x1b[31mStart')).toBe('Start');
			// Code at end
			expect(stripAnsiCodes('End\x1b[0m')).toBe('End');
			// Code in middle
			expect(stripAnsiCodes('Before\x1b[31mAfter')).toBe('BeforeAfter');
		});
		it('should strip 256-color codes', () => {
			// Foreground 256 color
			expect(stripAnsiCodes('\x1b[38;5;196mRed 256\x1b[0m')).toBe('Red 256');
			// Background 256 color
			expect(stripAnsiCodes('\x1b[48;5;21mBg Blue\x1b[0m')).toBe('Bg Blue');
		});
		it('should strip RGB/true color codes', () => {
			// RGB foreground
			expect(stripAnsiCodes('\x1b[38;2;255;0;0mRGB Red\x1b[0m')).toBe('RGB Red');
			// RGB background
			expect(stripAnsiCodes('\x1b[48;2;0;0;255mRGB Bg\x1b[0m')).toBe('RGB Bg');
		});
		it('should strip cursor movement codes', () => {
			// Cursor up
			expect(stripAnsiCodes('\x1b[2AUp')).toBe('Up');
			// Cursor down
			expect(stripAnsiCodes('\x1b[3BDown')).toBe('Down');
			// Cursor forward
			expect(stripAnsiCodes('\x1b[4CForward')).toBe('Forward');
			// Cursor back
			expect(stripAnsiCodes('\x1b[5DBack')).toBe('Back');
		});
		it('should strip erase codes', () => {
			// Erase line
			expect(stripAnsiCodes('\x1b[2KLine')).toBe('Line');
			// Erase screen
			expect(stripAnsiCodes('\x1b[2JScreen')).toBe('Screen');
		});
		it('should handle real terminal output scenarios', () => {
			// npm/yarn style progress
			const npmOutput = '\x1b[32m✓\x1b[0m Package installed successfully';
			expect(stripAnsiCodes(npmOutput)).toBe('✓ Package installed successfully');
			// Git diff style
			const gitDiff = '\x1b[32m+added line\x1b[0m\n\x1b[31m-removed line\x1b[0m';
			expect(stripAnsiCodes(gitDiff)).toBe('+added line\n-removed line');
			// Error message with color
			const error = '\x1b[31mError:\x1b[0m Something went wrong';
			expect(stripAnsiCodes(error)).toBe('Error: Something went wrong');
		});
		it('should preserve newlines and whitespace', () => {
			const input = '\x1b[32mLine 1\x1b[0m\n\x1b[32mLine 2\x1b[0m\n  Indented';
			expect(stripAnsiCodes(input)).toBe('Line 1\nLine 2\n  Indented');
		});
		it('should handle empty escape sequences', () => {
			// Just ESC[ with immediate command (edge case)
			expect(stripAnsiCodes('\x1b[mText')).toBe('Text');
		});
		it('should strip DEC private mode and keypad control sequences', () => {
			const input = '\x1b[?1h\x1b=\x1b[?2004hRemote ready\x1b[?2004l\x1b>';
			expect(stripAnsiCodes(input)).toBe('Remote ready');
		});
		it('should preserve unicode characters', () => {
			expect(stripAnsiCodes('\x1b[32m🚀 Rocket\x1b[0m')).toBe('🚀 Rocket');
			expect(stripAnsiCodes('\x1b[31m日本語\x1b[0m')).toBe('日本語');
		});
		it('should handle consecutive escape sequences', () => {
			expect(stripAnsiCodes('\x1b[0m\x1b[1m\x1b[32mText')).toBe('Text');
			expect(stripAnsiCodes('\x1b[31m\x1b[32m\x1b[34mBlue')).toBe('Blue');
		});
		// iTerm2/SSH shell integration sequence tests
		describe('iTerm2 shell integration sequences', () => {
			it('should strip bare ]1337; sequences chained together (SSH output)', () => {
				// Real example from SSH connections - sequences without ESC prefix, chained together
				const input =
					']1337;RemoteHost=pedram@PedTome.local]1337;CurrentDir=/Users/pedram]1337;ShellIntegrationVersion=13;shell=zsh/opt/homebrew/bin/codex';
				expect(stripAnsiCodes(input)).toBe('/opt/homebrew/bin/codex');
			});
			it('should strip ]1337; sequences with ESC prefix and BEL terminator', () => {
				const input = '\x1b]1337;RemoteHost=user@host\x07/usr/bin/claude';
				expect(stripAnsiCodes(input)).toBe('/usr/bin/claude');
			});
			it('should strip ]1337;CurrentDir sequences with BEL terminator', () => {
				const input = ']1337;CurrentDir=/home/user\x07/usr/local/bin/codex';
				expect(stripAnsiCodes(input)).toBe('/usr/local/bin/codex');
			});
			it('should strip multiple chained sequences with different keys', () => {
				const input =
					']1337;RemoteHost=user@host]1337;CurrentDir=/home/user]1337;ShellIntegrationVersion=13;shell=bash/path/to/binary';
				expect(stripAnsiCodes(input)).toBe('/path/to/binary');
			});
			it('should strip sequences mixed with ANSI color codes', () => {
				const input = '\x1b[32m\x1b]1337;CurrentDir=/home\x07\x1b[0m/usr/bin/test';
				expect(stripAnsiCodes(input)).toBe('/usr/bin/test');
			});
			it('should handle standalone iTerm2 sequences', () => {
				// Sequence followed by nothing
				const input = ']1337;RemoteHost=user@host';
				expect(stripAnsiCodes(input)).toBe('');
			});
			it('should strip sequences with only terminators', () => {
				const input = '\x1b]1337;RemoteHost=user@host\x07\x1b]1337;CurrentDir=/home\x07';
				expect(stripAnsiCodes(input)).toBe('');
			});
			it('should handle VSCode shell integration sequences (]133;)', () => {
				const input = ']133;A\x07prompt\x1b]133;B\x07output';
				expect(stripAnsiCodes(input)).toBe('promptoutput');
			});
			it('should handle current directory sequences (]7;)', () => {
				const input = ']7;file:///home/user/project\x07content';
				expect(stripAnsiCodes(input)).toBe('content');
			});
			it('should handle sequences on multiple lines', () => {
				const input =
					'\x1b]1337;CurrentDir=/home\x07/usr/bin/codex\n\x1b]1337;CurrentDir=/home\x07/usr/bin/claude';
				expect(stripAnsiCodes(input)).toBe('/usr/bin/codex\n/usr/bin/claude');
			});
			it('should strip BEL character alone', () => {
				expect(stripAnsiCodes('Text\x07More')).toBe('TextMore');
			});
			it('should handle real SSH session init output', () => {
				// Simulates what appears when SSH shell integration emits sequences at session start
				const input =
					']1337;RemoteHost=pedram@PedTome.local]1337;CurrentDir=/Users/pedram]1337;ShellIntegrationVersion=13;shell=zsh{"type":"system","subtype":"init"}';
				expect(stripAnsiCodes(input)).toBe('{"type":"system","subtype":"init"}');
			});
		});
		describe('safeDecodeURIComponent', () => {
			it('decodes well-formed percent escapes', () => {
				expect(safeDecodeURIComponent('my%20file.ts')).toBe('my file.ts');
				expect(safeDecodeURIComponent('%E4%B8%AD%E6%96%87.md')).toBe('\u4e2d\u6587.md');
			});
			it('returns the raw string for malformed escapes instead of throwing', () => {
				// decodeURIComponent throws URIError on each of these. A stray '%' is
				// ordinary prose ("100% done"), so markdown link targets hit it. MAESTRO-XS
				expect(safeDecodeURIComponent('100% done.md')).toBe('100% done.md');
				expect(safeDecodeURIComponent('%')).toBe('%');
				expect(safeDecodeURIComponent('%ZZ')).toBe('%ZZ');
				expect(safeDecodeURIComponent('%E0%A4%A')).toBe('%E0%A4%A');
			});
			it('leaves strings with no escapes untouched', () => {
				expect(safeDecodeURIComponent('plain.md')).toBe('plain.md');
				expect(safeDecodeURIComponent('')).toBe('');
			});
			it('terminates (guards against a self-recursive implementation)', () => {
				// A previous copy of this helper called itself instead of
				// decodeURIComponent, blowing the stack and silently returning the
				// undecoded input via its own catch.
				expect(safeDecodeURIComponent('a%20b')).toBe('a b');
			});
		});
	});
	describe('safeDecodeURIComponent', () => {
		it('should decode well-formed percent encoding', () => {
			expect(safeDecodeURIComponent('my%20file.md')).toBe('my file.md');
			expect(safeDecodeURIComponent('%2Fa%2Fb.md')).toBe('/a/b.md');
			expect(safeDecodeURIComponent('caf%C3%A9')).toBe('café');
		});
		it('should return the original value for malformed percent encoding', () => {
			expect(safeDecodeURIComponent('100%')).toBe('100%');
			expect(safeDecodeURIComponent('%')).toBe('%');
			expect(safeDecodeURIComponent('%zz')).toBe('%zz');
			expect(safeDecodeURIComponent('%E0%A4%A')).toBe('%E0%A4%A');
			expect(safeDecodeURIComponent('C:\\temp\\50%off')).toBe('C:\\temp\\50%off');
		});
		it('should pass through strings with nothing to decode', () => {
			expect(safeDecodeURIComponent('')).toBe('');
			expect(safeDecodeURIComponent('plain-text')).toBe('plain-text');
		});
		// Only URIError means "this was not valid encoding". Anything else is a real
		// fault and must reach Sentry rather than be silently returned as the input.
		it('rethrows a non-URIError so it is not silently swallowed', () => {
			const boom = new RangeError('unexpected');
			const spy = vi.spyOn(globalThis, 'decodeURIComponent').mockImplementation(() => {
				throw boom;
			});
			try {
				expect(() => safeDecodeURIComponent('anything')).toThrow(boom);
			} finally {
				spy.mockRestore();
			}
		});
	});
});
// Source: src/__tests__/shared/emojiUtils.test.ts
describe('', () => {
	describe('emojiUtils', () => {
		describe('stripLeadingEmojis', () => {
			describe('basic emoji handling', () => {
				it('should strip single emoji at the start', () => {
					expect(stripLeadingEmojis('🎉 Party')).toBe('Party');
				});
				it('should strip emoji without space after', () => {
					expect(stripLeadingEmojis('🎉Party')).toBe('Party');
				});
				it('should strip multiple emojis at the start', () => {
					expect(stripLeadingEmojis('🎉🎊🎁 Celebration')).toBe('Celebration');
				});
				it('should return text unchanged if no leading emoji', () => {
					expect(stripLeadingEmojis('No emoji here')).toBe('No emoji here');
				});
				it('should preserve emojis in the middle of text', () => {
					expect(stripLeadingEmojis('Hello 🎉 World')).toBe('Hello 🎉 World');
				});
				it('should preserve emojis at the end of text', () => {
					expect(stripLeadingEmojis('Hello World 🎉')).toBe('Hello World 🎉');
				});
				it('should handle empty string', () => {
					expect(stripLeadingEmojis('')).toBe('');
				});
				it('should handle string with only emojis', () => {
					expect(stripLeadingEmojis('🎉🎊🎁')).toBe('');
				});
				it('should handle string with only whitespace', () => {
					expect(stripLeadingEmojis('   ')).toBe('');
				});
			});
			describe('complex emoji sequences', () => {
				it('should handle emoji with variation selector (emoji presentation)', () => {
					// Some emojis have variation selectors to ensure emoji presentation
					expect(stripLeadingEmojis('☺️ Smile')).toBe('Smile');
				});
				it('should strip the whole ZWJ sequence, not just its first codepoint', () => {
					// The ZWJ (U+200D) used to stop the match, leaving the tail of the
					// sequence glued to the name and poisoning the sort key.
					expect(stripLeadingEmojis('👨‍👩‍👧‍👦 Family')).toBe('Family');
					expect(stripLeadingEmojis('🧑‍💼 A&C Overlord')).toBe('A&C Overlord');
				});
				it('should handle skin tone modifiers', () => {
					expect(stripLeadingEmojis('👋🏽 Wave')).toBe('Wave');
				});
				it('should handle flag emojis', () => {
					expect(stripLeadingEmojis('🇺🇸 USA')).toBe('USA');
				});
				it('should handle keycap emojis - may have partial stripping', () => {
					// Note: Keycap emojis (1️⃣) combine digit + variation selector + combining enclosing keycap
					// The regex may not strip all parts perfectly
					const result = stripLeadingEmojis('1️⃣ First');
					expect(result).toContain('First');
				});
			});
			describe('edge cases', () => {
				it('should trim leading whitespace after emoji removal', () => {
					expect(stripLeadingEmojis('🎉   Lots of space')).toBe('Lots of space');
				});
				it('should trim trailing whitespace', () => {
					expect(stripLeadingEmojis('🎉 Trailing   ')).toBe('Trailing');
				});
				it('should handle mixed whitespace', () => {
					expect(stripLeadingEmojis('🎉 \t Tab')).toBe('Tab');
				});
				it('should handle numbers after emoji', () => {
					expect(stripLeadingEmojis('🔢 12345')).toBe('12345');
				});
				it('should handle special characters after emoji', () => {
					expect(stripLeadingEmojis('🎉 @#$%')).toBe('@#$%');
				});
				it('should leave a leading digit alone', () => {
					// ASCII digits carry Emoji=Yes, so the old \p{Emoji} pattern ate the
					// "0" and filed the agent under "D".
					expect(stripLeadingEmojis('0DIN Loki')).toBe('0DIN Loki');
					expect(stripLeadingEmojis('#1 Agent')).toBe('#1 Agent');
				});
				it('should handle Unicode letters after emoji', () => {
					expect(stripLeadingEmojis('🎉 café')).toBe('café');
				});
				it('should handle CJK characters after emoji', () => {
					expect(stripLeadingEmojis('🎉 日本語')).toBe('日本語');
				});
				it('should NOT strip a leading ASCII digit (digits are keycap-emoji bases)', () => {
					// Regression: ASCII digits 0-9 carry Unicode Emoji=Yes, so an optional
					// variation selector in the regex used to eat the leading digit and
					// mis-sort names like "0DIN Weekly" under "D".
					expect(stripLeadingEmojis('0DIN Weekly')).toBe('0DIN Weekly');
					expect(stripLeadingEmojis('9Lives')).toBe('9Lives');
				});
				it('should NOT strip a leading # or * (also keycap-emoji bases)', () => {
					expect(stripLeadingEmojis('#tag')).toBe('#tag');
					expect(stripLeadingEmojis('*star')).toBe('*star');
				});
			});
		});
		describe('nameSortKey', () => {
			it('starts the key at the first alphanumeric character', () => {
				expect(nameSortKey('🧑‍💼 A&C Overlord')).toBe('A&C Overlord');
				expect(nameSortKey('👀 A&C Overwatch')).toBe('A&C Overwatch');
				expect(nameSortKey('0DIN Loki')).toBe('0DIN Loki');
				expect(nameSortKey('  ...Alpha')).toBe('Alpha');
			});
			it('falls back to the emoji-stripped name when there is no alphanumeric', () => {
				expect(nameSortKey('🎉 @#$%')).toBe('@#$%');
				expect(nameSortKey('🎉🎊🎁')).toBe('');
			});
		});
		describe('compareNamesIgnoringEmojis', () => {
			describe('basic comparisons', () => {
				it('should compare names with emojis alphabetically', () => {
					expect(compareNamesIgnoringEmojis('🍎 Apple', '🍌 Banana')).toBeLessThan(0);
				});
				it('should compare names where emoji would affect sort', () => {
					// Without stripping, 🎉 Zebra would sort before Alpha because of emoji code point
					expect(compareNamesIgnoringEmojis('🎉 Zebra', 'Alpha')).toBeGreaterThan(0);
				});
				it('should return 0 for identical names', () => {
					expect(compareNamesIgnoringEmojis('🎉 Same', '🎊 Same')).toBe(0);
				});
				it('should compare names without emojis normally', () => {
					expect(compareNamesIgnoringEmojis('Apple', 'Banana')).toBeLessThan(0);
				});
				it('should compare mixed emoji and non-emoji names', () => {
					expect(compareNamesIgnoringEmojis('🎉 Apple', 'Banana')).toBeLessThan(0);
					expect(compareNamesIgnoringEmojis('Apple', '🎉 Banana')).toBeLessThan(0);
				});
			});
			describe('case sensitivity', () => {
				it('should use default localeCompare (case-sensitive by default)', () => {
					// localeCompare by default is case-sensitive in most environments
					// 'Apple' comes before 'apple' because uppercase sorts first
					const result = compareNamesIgnoringEmojis('apple', 'Apple');
					// Don't assert exact value - just that comparison works consistently
					expect(typeof result).toBe('number');
				});
				it('should handle uppercase names', () => {
					expect(compareNamesIgnoringEmojis('🎉 APPLE', '🍌 BANANA')).toBeLessThan(0);
				});
			});
			describe('sorting arrays', () => {
				it('files an emoji-prefixed name under its first letter', () => {
					const names = [
						'🧑‍💼 A&C Overlord',
						'0DIN Loki',
						'0DIN.ai',
						'👀 A&C Overwatch',
						'📷 ATX Sentinel',
					];
					expect([...names].sort(compareNamesIgnoringEmojis)).toEqual([
						'0DIN Loki',
						'0DIN.ai',
						'🧑‍💼 A&C Overlord',
						'👀 A&C Overwatch',
						'📷 ATX Sentinel',
					]);
				});
				it('should sort array of names with emojis correctly', () => {
					const names = ['🍎 Apple', '🎉 Zebra', '🔥 Fire', '🌟 Star', 'Alpha', '🐝 Bee'];
					const sorted = [...names].sort(compareNamesIgnoringEmojis);
					expect(sorted).toEqual(['Alpha', '🍎 Apple', '🐝 Bee', '🔥 Fire', '🌟 Star', '🎉 Zebra']);
				});
				it('should handle empty names in array', () => {
					const names = ['🎉 Test', '', 'Alpha'];
					const sorted = [...names].sort(compareNamesIgnoringEmojis);
					expect(sorted).toEqual(['', 'Alpha', '🎉 Test']);
				});
				it('should sort a digit-prefixed name by its digit, not the following letter', () => {
					// Regression: "0DIN Weekly" must sort ahead of "Cyber Stocks"/"Maestro"
					// instead of landing under "D" from a stripped leading "0".
					const names = ['Cyber Stocks', '0DIN Weekly', 'Maestro', 'BJJ Sensei'];
					const sorted = [...names].sort(compareNamesIgnoringEmojis);
					expect(sorted).toEqual(['0DIN Weekly', 'BJJ Sensei', 'Cyber Stocks', 'Maestro']);
				});
			});
			describe('edge cases', () => {
				it('should handle empty strings', () => {
					expect(compareNamesIgnoringEmojis('', '')).toBe(0);
					expect(compareNamesIgnoringEmojis('', 'A')).toBeLessThan(0);
					expect(compareNamesIgnoringEmojis('A', '')).toBeGreaterThan(0);
				});
				it('should handle strings that are only emojis', () => {
					expect(compareNamesIgnoringEmojis('🎉', '🎊')).toBe(0); // Both become empty
					expect(compareNamesIgnoringEmojis('🎉', 'Alpha')).toBeLessThan(0); // Empty < Alpha
				});
				it('should handle special characters', () => {
					// Just verify it returns a consistent comparison value
					// Special character ordering depends on locale
					const result = compareNamesIgnoringEmojis('🎉 @test', '🎊 #test');
					expect(typeof result).toBe('number');
				});
			});
		});
	});
});
// Source: src/__tests__/shared/symphony-types.test.ts
describe('', () => {
	// Local aliases mirroring (now-internal) shared/symphony-types definitions.
	// Kept in sync manually; failures here are a signal the source types changed.
	type SymphonyErrorType = ConstructorParameters<typeof SymphonyError>[1];
	type SymphonyLabel = SymphonyIssue['labels'][number];
	describe('shared/symphony-types', () => {
		// ==========================================================================
		// SymphonyError Class Tests
		// ==========================================================================
		describe('SymphonyError', () => {
			it('should set message correctly', () => {
				const error = new SymphonyError('Test error message', 'network');
				expect(error.message).toBe('Test error message');
			});
			it('should set type property', () => {
				const error = new SymphonyError('Test error', 'github_api');
				expect(error.type).toBe('github_api');
			});
			it('should set cause property', () => {
				const originalError = new Error('Original error');
				const error = new SymphonyError('Wrapped error', 'git', originalError);
				expect(error.cause).toBe(originalError);
			});
			it('should have name as "SymphonyError"', () => {
				const error = new SymphonyError('Test', 'network');
				expect(error.name).toBe('SymphonyError');
			});
			it('should be instanceof Error', () => {
				const error = new SymphonyError('Test', 'network');
				expect(error).toBeInstanceOf(Error);
			});
			it('should be instanceof SymphonyError', () => {
				const error = new SymphonyError('Test', 'network');
				expect(error).toBeInstanceOf(SymphonyError);
			});
			it('should work without cause parameter', () => {
				const error = new SymphonyError('No cause', 'parse');
				expect(error.cause).toBeUndefined();
			});
			it('should preserve stack trace', () => {
				const error = new SymphonyError('Test', 'network');
				expect(error.stack).toBeDefined();
				expect(error.stack).toContain('SymphonyError');
			});
			describe('error type values', () => {
				const errorTypes: SymphonyErrorType[] = [
					'network',
					'github_api',
					'git',
					'parse',
					'pr_creation',
					'autorun',
					'cancelled',
				];
				it.each(errorTypes)('should accept "%s" as a valid error type', (errorType) => {
					const error = new SymphonyError(`Error of type ${errorType}`, errorType);
					expect(error.type).toBe(errorType);
				});
			});
		});
		// ==========================================================================
		// Type Validation Tests (compile-time checks with runtime verification)
		// ==========================================================================
		describe('SymphonyCategory type', () => {
			it('should accept any string as a category (extensible via registry)', () => {
				const known: SymphonyCategory = 'ai-ml';
				const custom: SymphonyCategory = 'my-custom-category';
				expect(known).toBe('ai-ml');
				expect(custom).toBe('my-custom-category');
			});
		});
		describe('ContributionStatus type', () => {
			const validStatuses: ContributionStatus[] = [
				'cloning',
				'creating_pr',
				'running',
				'paused',
				'completed',
				'completing',
				'ready_for_review',
				'failed',
				'cancelled',
			];
			it.each(validStatuses)('should accept "%s" as a valid contribution status', (status) => {
				const testStatus: ContributionStatus = status;
				expect(testStatus).toBe(status);
			});
			it('should have 9 valid contribution statuses', () => {
				expect(validStatuses).toHaveLength(9);
			});
		});
		describe('IssueStatus type', () => {
			const validStatuses: IssueStatus[] = ['available', 'in_progress', 'completed'];
			it.each(validStatuses)('should accept "%s" as a valid issue status', (status) => {
				const testStatus: IssueStatus = status;
				expect(testStatus).toBe(status);
			});
			it('should have 3 valid issue statuses', () => {
				expect(validStatuses).toHaveLength(3);
			});
		});
		describe('SymphonyErrorType type', () => {
			const validErrorTypes: SymphonyErrorType[] = [
				'network',
				'github_api',
				'git',
				'parse',
				'pr_creation',
				'autorun',
				'cancelled',
			];
			it.each(validErrorTypes)('should accept "%s" as a valid error type', (errorType) => {
				const testErrorType: SymphonyErrorType = errorType;
				expect(testErrorType).toBe(errorType);
			});
			it('should have 7 valid error types', () => {
				expect(validErrorTypes).toHaveLength(7);
			});
		});
		// ==========================================================================
		// SymphonyLabel Type Tests
		// ==========================================================================
		describe('SymphonyLabel type', () => {
			it('should accept valid label objects', () => {
				const label: SymphonyLabel = { name: 'blocking', color: 'e4e669' };
				expect(label.name).toBe('blocking');
				expect(label.color).toBe('e4e669');
			});
		});
		// ==========================================================================
		// SymphonyIssue labels field Tests
		// ==========================================================================
		describe('SymphonyIssue labels field', () => {
			it('should include labels in issue interface', () => {
				const issue: SymphonyIssue = {
					number: 1,
					title: 'Test',
					body: '',
					url: 'https://api.github.com/repos/owner/repo/issues/1',
					htmlUrl: 'https://github.com/owner/repo/issues/1',
					author: 'user',
					createdAt: '2024-01-01',
					updatedAt: '2024-01-01',
					documentPaths: [],
					labels: [{ name: 'blocking', color: 'e4e669' }],
					status: 'available',
				};
				expect(issue.labels).toHaveLength(1);
				expect(issue.labels[0].name).toBe('blocking');
			});
			it('should allow empty labels array', () => {
				const issue: SymphonyIssue = {
					number: 2,
					title: 'No labels',
					body: '',
					url: 'https://api.github.com/repos/owner/repo/issues/2',
					htmlUrl: 'https://github.com/owner/repo/issues/2',
					author: 'user',
					createdAt: '2024-01-01',
					updatedAt: '2024-01-01',
					documentPaths: [],
					labels: [],
					status: 'available',
				};
				expect(issue.labels).toEqual([]);
			});
		});
		// ==========================================================================
		// SymphonyCache Type Tests
		// ==========================================================================
		describe('SymphonyCache type', () => {
			it('should allow issueCounts field to be omitted (optional)', () => {
				const cache: SymphonyCache = { issues: {} };
				expect(cache.issueCounts).toBeUndefined();
			});
			it('should accept issueCounts with data, fetchedAt, and repoSlugs', () => {
				const cache: SymphonyCache = {
					issues: {},
					issueCounts: {
						data: { 'owner/repo': 5, 'owner/other': 0 },
						fetchedAt: 1700000000000,
						repoSlugs: ['owner/other', 'owner/repo'],
					},
				};
				expect(cache.issueCounts?.data['owner/repo']).toBe(5);
				expect(cache.issueCounts?.data['owner/other']).toBe(0);
				expect(cache.issueCounts?.fetchedAt).toBe(1700000000000);
				expect(cache.issueCounts?.repoSlugs).toEqual(['owner/other', 'owner/repo']);
			});
		});
	});
});
// Source: src/__tests__/shared/modelUsage.test.ts
describe('', () => {
	describe('ModelUsageAccumulator', () => {
		it('starts empty and reports isEmpty', () => {
			const acc = new ModelUsageAccumulator();
			expect(acc.isEmpty).toBe(true);
			expect(acc.finalize()).toEqual([]);
		});
		it('is no longer empty once a record is added', () => {
			const acc = new ModelUsageAccumulator();
			acc.add('claude-opus-4-8', { inputTokens: 1, outputTokens: 0 });
			expect(acc.isEmpty).toBe(false);
		});
		it('sums all four token fields for the same model across records', () => {
			const acc = new ModelUsageAccumulator();
			acc.add('claude-opus-4-8', {
				inputTokens: 100,
				outputTokens: 10,
				cacheReadTokens: 5,
				cacheCreationTokens: 2,
			});
			acc.add('claude-opus-4-8', {
				inputTokens: 200,
				outputTokens: 20,
				cacheReadTokens: 5,
				cacheCreationTokens: 3,
			});
			const [bucket] = acc.finalize();
			expect(bucket).toMatchObject({
				model: 'claude-opus-4-8',
				inputTokens: 300,
				outputTokens: 30,
				cacheReadTokens: 10,
				cacheCreationTokens: 5,
			});
		});
		it('merges records whose raw model id normalizes to the same value', () => {
			const acc = new ModelUsageAccumulator();
			// [1m] marker and an 8-digit date suffix both normalize away.
			acc.add('claude-opus-4-8[1m]', { inputTokens: 100, outputTokens: 0 });
			acc.add('claude-opus-4-8-20260101', { inputTokens: 50, outputTokens: 0 });
			const finalized = acc.finalize();
			expect(finalized).toHaveLength(1);
			expect(finalized[0].model).toBe('claude-opus-4-8');
			expect(finalized[0].inputTokens).toBe(150);
		});
		it('keeps distinct models in separate buckets', () => {
			const acc = new ModelUsageAccumulator();
			acc.add('claude-opus-4-8', { inputTokens: 1000000, outputTokens: 0 });
			acc.add('claude-fable-5', { inputTokens: 0, outputTokens: 1000000 });
			const finalized = acc.finalize();
			expect(finalized).toHaveLength(2);
			expect(finalized.map((m) => m.model).sort()).toEqual(['claude-fable-5', 'claude-opus-4-8']);
		});
		it('buckets a null/undefined model id under the empty-string key', () => {
			const acc = new ModelUsageAccumulator();
			acc.add(undefined, { inputTokens: 10, outputTokens: 0 });
			acc.add(null, { inputTokens: 5, outputTokens: 0 });
			const finalized = acc.finalize();
			expect(finalized).toHaveLength(1);
			expect(finalized[0].model).toBe('');
			expect(finalized[0].inputTokens).toBe(15);
		});
		it('estimates cost from the rate table when no cost is reported', () => {
			const acc = new ModelUsageAccumulator();
			acc.add('claude-opus-4-8', { inputTokens: 1000000, outputTokens: 0 });
			const [bucket] = acc.finalize();
			expect(bucket.costEstimated).toBe(true);
			expect(bucket.costUsd).toBeCloseTo(
				calculateModelCost({ inputTokens: 1000000, outputTokens: 0 }, 'claude-opus-4-8'),
				10
			);
		});
		it('trusts a provider-reported cost and marks the bucket not estimated', () => {
			const acc = new ModelUsageAccumulator();
			acc.add('some-model', { inputTokens: 1000000, outputTokens: 0 }, 0.42);
			const [bucket] = acc.finalize();
			expect(bucket.costEstimated).toBe(false);
			expect(bucket.costUsd).toBeCloseTo(0.42, 10);
		});
		it('sums multiple reported costs for the same model', () => {
			const acc = new ModelUsageAccumulator();
			acc.add('m', { inputTokens: 1, outputTokens: 0 }, 0.1);
			acc.add('m', { inputTokens: 1, outputTokens: 0 }, 0.25);
			const [bucket] = acc.finalize();
			expect(bucket.costEstimated).toBe(false);
			expect(bucket.costUsd).toBeCloseTo(0.35, 10);
		});
		it('marks a bucket as reported once any contributing record carried a cost', () => {
			const acc = new ModelUsageAccumulator();
			acc.add('m', { inputTokens: 1000000, outputTokens: 0 }); // no cost
			acc.add('m', { inputTokens: 0, outputTokens: 0 }, 1.0); // reported
			const [bucket] = acc.finalize();
			expect(bucket.costEstimated).toBe(false);
			expect(bucket.costUsd).toBeCloseTo(1.0, 10);
		});
		it('ignores a non-finite reported cost and falls back to estimation', () => {
			const acc = new ModelUsageAccumulator();
			acc.add('claude-opus-4-8', { inputTokens: 1000000, outputTokens: 0 }, NaN);
			const [bucket] = acc.finalize();
			expect(bucket.costEstimated).toBe(true);
			expect(bucket.costUsd).toBeGreaterThan(0);
		});
	});
	describe('claudeModelUsage', () => {
		it('maps the rate-table split to token usage, flagging every bucket estimated', () => {
			const byModel: ModelCost[] = [
				{
					model: 'claude-opus-4-8[1m]',
					inputTokens: 100,
					outputTokens: 20,
					cacheReadTokens: 5,
					cacheCreationTokens: 3,
					costUsd: 1.23,
				},
			];
			const usage = claudeModelUsage(byModel);
			expect(usage).toEqual([
				{
					model: 'claude-opus-4-8', // normalized ([1m] stripped)
					inputTokens: 100,
					outputTokens: 20,
					cacheReadTokens: 5,
					cacheCreationTokens: 3,
					costUsd: 1.23,
					costEstimated: true,
				},
			]);
		});
		it('returns an empty array for an empty split', () => {
			expect(claudeModelUsage([])).toEqual([]);
		});
	});
});

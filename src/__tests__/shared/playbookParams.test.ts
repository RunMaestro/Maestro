import { describe, expect, it } from 'vitest';
import {
	PLACEHOLDER_PR_URL,
	applyPlaybookParamsToPrompt,
	restatePlaybookParameterForm,
	assertNoSurvivingParams,
	buildResolvedConfigurationTable,
	collectUnresolvedRequired,
	compactPlaybookParamValues,
	describeMissingRequiredParams,
	describePlaybookParamProvenance,
	describeSurvivingParams,
	expandPlaybookParamTemplates,
	isPlaceholderDefault,
	isPlaybookParamType,
	mergePlaybookParams,
	mergeProposedParamValues,
	parsePlaybookParameterForm,
	proposeFromFacts,
	readPlaybookParamOverlay,
	readPlaybookParamValues,
	resolvePlaybookParamSpecs,
	splitMultiEnumValue,
	substitutePlaybookParams,
	validatePlaybookParamValue,
	type PlaybookParamOverlay,
	type PlaybookParamSpec,
} from '../../shared/playbookParams';
import { resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';
import type { PlaybookFacts } from '../../shared/playbookFacts';
import {
	ASSISTANTS_MESSAGE_BUS_PROMPT,
	RESEARCH_CORPUS_PROMPT,
	REPO_PARAM_NAMES,
	RESEARCH_MARKET_PROMPT,
} from './fixtures/playbookParamPrompts';

function byName(specs: PlaybookParamSpec[]): Record<string, PlaybookParamSpec> {
	return Object.fromEntries(specs.map((spec) => [spec.name, spec]));
}

describe('isPlaceholderDefault', () => {
	it('treats the UNSET sentinel and the placeholder PR URL as no default', () => {
		expect(isPlaceholderDefault('<UNSET - describe the market>')).toBe(true);
		expect(isPlaceholderDefault('<UNSET>')).toBe(true);
		expect(isPlaceholderDefault(PLACEHOLDER_PR_URL)).toBe(true);
		expect(isPlaceholderDefault('https://github.com/acme/app/pull/12')).toBe(false);
		expect(isPlaceholderDefault('all')).toBe(false);
		expect(isPlaceholderDefault('')).toBe(false);
	});
});

describe('parsePlaybookParameterForm', () => {
	it('reads the Research/Market form', () => {
		const specs = parsePlaybookParameterForm(RESEARCH_MARKET_PROMPT);
		expect(specs.map((spec) => spec.name)).toEqual([
			'MARKET_TOPIC',
			'SCOPE_IN',
			'SCOPE_OUT',
			'DOMAIN_ENTITY',
			'SEED_SOURCE',
			'OUTPUT_FOLDER',
			'MAX_ENTITIES',
			'DEPTH_BATCH',
			'SWEEP_EVERY',
			'COVERAGE_TARGET',
		]);
		const spec = byName(specs);

		expect(spec.MARKET_TOPIC).toEqual({
			name: 'MARKET_TOPIC',
			type: 'string',
			required: true,
			source: 'prose',
			help: 'what market to research. Be specific: a narrow market yields a far better vault than a broad one.',
			options: [
				'Electric Vehicle Charging Infrastructure',
				'AI-Powered Developer Tools',
				'Plant-Based Meat Alternatives',
				'Enterprise Kubernetes Platforms',
				'Direct-to-Consumer Hearing Aids',
				'Carbon Capture Technologies',
			],
		});

		// One CONFIGURE comment declares both halves of the boundary. Their
		// UNSET defaults are no default, but the qualifier says optional.
		for (const name of ['SCOPE_IN', 'SCOPE_OUT']) {
			expect(spec[name].default).toBeUndefined();
			expect(spec[name].required).toBe(false);
			expect(spec[name].help).toMatch(/^if you leave these unset, 0_CONFIGURE proposes a pair/);
		}
		// The worked-examples comment has no bullets, so it adds no hints.
		expect(spec.SCOPE_OUT.options).toBeUndefined();

		expect(spec.DOMAIN_ENTITY.required).toBe(false);
		expect(spec.DOMAIN_ENTITY.default).toBeUndefined();
		expect(spec.DOMAIN_ENTITY.options?.[0]).toBe('Regulated finance ....... Charter / Regulator');
		expect(spec.SEED_SOURCE).toMatchObject({ required: false });
		expect(spec.SEED_SOURCE.default).toBeUndefined();

		expect(spec.OUTPUT_FOLDER).toMatchObject({
			default: '{{AUTORUN_FOLDER}}/vault',
			required: false,
		});
		expect(spec.MAX_ENTITIES.default).toBe('60');
		expect(spec.DEPTH_BATCH.default).toBe('3');
		expect(spec.SWEEP_EVERY.default).toBe('4');
		expect(spec.COVERAGE_TARGET).toMatchObject({ default: '90', required: false });
		expect(spec.COVERAGE_TARGET.help).toMatch(/^percentage of cards that must carry/);
	});

	it('reads the Research/Corpus form', () => {
		const specs = parsePlaybookParameterForm(RESEARCH_CORPUS_PROMPT);
		expect(specs.map((spec) => spec.name)).toEqual([
			'CORPUS_SOURCE',
			'CORPUS_KIND',
			'ANALYTICAL_LENS',
			'OUTPUT_FOLDER',
			'BATCH_SIZE',
			'MAX_ITEMS',
		]);
		const spec = byName(specs);

		expect(spec.CORPUS_SOURCE).toMatchObject({
			required: true,
			help: 'What you want processed. One source, not a list.',
		});
		expect(spec.CORPUS_SOURCE.default).toBeUndefined();
		// Bullets keep only the text before the explanation column.
		expect(spec.CORPUS_SOURCE.options).toEqual([
			'https://www.youtube.com/playlist?list=PLjmt1tu85IhAiVPugOjP-7Cy0Oemi3m7z',
			'~/Downloads/due-diligence-pdfs',
			'{{AGENT_PATH}}/sources.txt',
			'~/Documents/subscriptions.opml',
			'https://github.com/someorg/somerepo',
		]);
		expect(spec.CORPUS_KIND).toMatchObject({ default: 'auto', required: false });
		expect(spec.CORPUS_KIND.options).toEqual([
			'auto',
			'youtube-playlist',
			'url-list',
			'local-files',
			'opml',
			'single-url',
		]);
		expect(spec.ANALYTICAL_LENS.default).toBe(
			'Extract the core thesis, the key claims with supporting evidence, notable metrics, and quotable lines.'
		);
		expect(spec.ANALYTICAL_LENS.options).toHaveLength(4);
		expect(spec.OUTPUT_FOLDER.default).toBe('{{AUTORUN_FOLDER}}/corpus');
		expect(spec.BATCH_SIZE.default).toBe('8');
		expect(spec.MAX_ITEMS).toMatchObject({ default: 'all', required: false, type: 'string' });
	});

	it('reads the Assistants/Message-Bus form', () => {
		const specs = parsePlaybookParameterForm(ASSISTANTS_MESSAGE_BUS_PROMPT);
		expect(specs.map((spec) => spec.name)).toEqual([
			'HANDLER_AGENT_ID',
			'TRIGGER_MARKER',
			'ALLOWED_SENDERS',
			'ARM_ON_INSTALL',
			'POLL_MINUTES',
			'WORK_DIR',
			'INSTALL_DIR',
		]);
		const spec = byName(specs);

		expect(spec.HANDLER_AGENT_ID.default).toBe('self');
		// A single-line examples comment is split on commas.
		expect(spec.TRIGGER_MARKER).toMatchObject({
			default: '@maestro',
			options: ['@maestro', '@jarvis', '@bus', '++do'],
		});
		expect(spec.ALLOWED_SENDERS.options).toEqual(['self', '+15125551212,someone@example.com']);
		expect(spec.ARM_ON_INSTALL.options).toEqual(['manual', 'auto']);
		expect(spec.POLL_MINUTES.default).toBe('3');
		expect(spec.POLL_MINUTES.options).toBeUndefined();
		expect(spec.WORK_DIR.default).toBe('{{AGENT_PATH}}');
		expect(spec.INSTALL_DIR.default).toBe('~/bin/maestro-message-bus');
		expect(specs.every((s) => !s.required && s.source === 'prose' && s.type === 'string')).toBe(
			true
		);
	});

	it('returns no specs for a prompt with no form', () => {
		expect(parsePlaybookParameterForm('')).toEqual([]);
		expect(
			parsePlaybookParameterForm(
				'# Agent Prompt\n\n**IMPORTANT:** `read this`\n\nReference [MAX_ITEMS] somewhere.\n'
			)
		).toEqual([]);
	});

	it('ignores a form inside a fenced code block', () => {
		const prompt = [
			'# Prompt',
			'',
			'```markdown',
			'<!-- CONFIGURE: How many items -->',
			'**MAX_ITEMS:** `25`',
			'```',
			'',
			'~~~',
			'<!-- CONFIGURE: Where -->',
			'**OUTPUT_FOLDER:** `out`',
			'~~~',
			'',
			'<!-- CONFIGURE: The real one -->',
			'**REAL_PARAM:** `yes`',
		].join('\n');
		expect(parsePlaybookParameterForm(prompt)).toEqual([
			{
				name: 'REAL_PARAM',
				type: 'string',
				required: false,
				source: 'prose',
				help: 'The real one',
				default: 'yes',
			},
		]);
	});

	it('treats the placeholder PR URL as a required parameter with no default', () => {
		const prompt = `<!-- CONFIGURE: The pull request to review -->\n**PR_URL:** \`${PLACEHOLDER_PR_URL}\`\n`;
		expect(parsePlaybookParameterForm(prompt)).toEqual([
			{
				name: 'PR_URL',
				type: 'string',
				required: true,
				source: 'prose',
				help: 'The pull request to review',
			},
		]);
	});

	it('skips illegal names, undeclared lines, and repeated names', () => {
		const prompt = [
			'**ORPHAN:** `no CONFIGURE comment above`',
			'',
			'<!-- CONFIGURE: too short -->',
			'**X:** `1`',
			'',
			'<!-- CONFIGURE: lowercase -->',
			'**max_items:** `1`',
			'',
			'<!-- CONFIGURE: first -->',
			'**MAX_ITEMS:** `25`',
			'',
			'<!-- CONFIGURE: second -->',
			'**MAX_ITEMS:** `50`',
			'',
			'<!-- CONFIGURE: interrupted -->',
			'Some prose closes the declaration.',
			'**LATE_PARAM:** `x`',
		].join('\n');
		expect(parsePlaybookParameterForm(prompt)).toEqual([
			{
				name: 'MAX_ITEMS',
				type: 'string',
				required: false,
				source: 'prose',
				help: 'first',
				default: '25',
			},
		]);
	});

	it('treats an empty default as no default and handles CRLF', () => {
		const prompt =
			'<!-- CONFIGURE: Filter -->\r\n**FILTER:** ``\r\n\r\n<!-- CONFIGURE (optional): Tag -->\r\n**TAG:** ` `\r\n';
		expect(parsePlaybookParameterForm(prompt)).toEqual([
			{ name: 'FILTER', type: 'string', required: true, source: 'prose', help: 'Filter' },
			{ name: 'TAG', type: 'string', required: false, source: 'prose', help: 'Tag' },
		]);
	});
});

describe('mergePlaybookParams', () => {
	const prose: PlaybookParamSpec[] = [
		{
			name: 'PR_URL',
			type: 'string',
			required: true,
			source: 'prose',
			help: 'The pull request to review',
		},
		{
			name: 'MAX_ITEMS',
			type: 'string',
			required: false,
			source: 'prose',
			help: 'How many items',
			default: '25',
			options: ['25', 'all'],
		},
		{
			name: 'AUTO_FIX_SEVERITY',
			type: 'string',
			required: false,
			source: 'prose',
			help: 'Severities to fix',
			default: 'CRITICAL,HIGH',
		},
	];

	it('keeps prose specs untouched when there is no overlay', () => {
		const merged = mergePlaybookParams(prose, []);
		expect(merged).toEqual(prose);
		expect(merged[1]).not.toBe(prose[1]);
		expect(merged[1].options).not.toBe(prose[1].options);
	});

	it('lets the overlay win for exactly the fields it declares', () => {
		const overlay: PlaybookParamOverlay[] = [
			{ name: 'PR_URL', type: 'url' },
			{
				name: 'AUTO_FIX_SEVERITY',
				type: 'multi-enum',
				options: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
			},
			{ name: 'MAX_ITEMS', required: true, min: 1, max: 500, pattern: '[0-9]+|all' },
		];
		const merged = mergePlaybookParams(prose, overlay);
		expect(merged).toEqual([
			{
				name: 'PR_URL',
				type: 'url',
				required: true,
				source: 'both',
				help: 'The pull request to review',
			},
			{
				name: 'MAX_ITEMS',
				type: 'string',
				required: true,
				source: 'both',
				help: 'How many items',
				default: '25',
				options: ['25', 'all'],
				pattern: '[0-9]+|all',
				min: 1,
				max: 500,
			},
			{
				name: 'AUTO_FIX_SEVERITY',
				type: 'multi-enum',
				required: false,
				source: 'both',
				help: 'Severities to fix',
				default: 'CRITICAL,HIGH',
				options: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
			},
		]);
		// The overlay's options array is copied, not shared.
		expect(merged[2].options).not.toBe(overlay[1].options);
		// Inputs are not mutated.
		expect(prose[0].type).toBe('string');
		expect(prose[0].source).toBe('prose');
	});

	it('surfaces an overlay-only name with label = name and no default', () => {
		const merged = mergePlaybookParams(prose.slice(0, 1), [
			{ name: 'TARGET_BRANCH', pattern: '[A-Za-z0-9._/-]+' },
			{ name: 'BATCH_SIZE', type: 'number', required: false, min: 1 },
		]);
		expect(merged.slice(1)).toEqual([
			{
				name: 'TARGET_BRANCH',
				label: 'TARGET_BRANCH',
				type: 'string',
				required: true,
				source: 'overlay',
				pattern: '[A-Za-z0-9._/-]+',
			},
			{
				name: 'BATCH_SIZE',
				label: 'BATCH_SIZE',
				type: 'number',
				required: false,
				source: 'overlay',
				min: 1,
			},
		]);
		expect(merged[1]).not.toHaveProperty('default');
	});

	it('ignores overlay entries with an illegal or repeated name', () => {
		const merged = mergePlaybookParams(
			[],
			[
				{ name: 'lowercase', type: 'url' },
				{ name: 'X', type: 'url' },
				{ name: 'REPORT_URL', type: 'url' },
				{ name: 'REPORT_URL', type: 'number' },
			]
		);
		expect(merged.map((spec) => [spec.name, spec.type])).toEqual([['REPORT_URL', 'url']]);
	});

	it('merges the parsed Research/Corpus form with a partial overlay', () => {
		const parsed = parsePlaybookParameterForm(RESEARCH_CORPUS_PROMPT);
		const merged = mergePlaybookParams(parsed, [{ name: 'MAX_LOOPS_HINT', type: 'number' }]);
		expect(merged.slice(0, parsed.length).map((spec) => spec.source)).toEqual(
			parsed.map(() => 'prose')
		);
		expect(merged[merged.length - 1]).toMatchObject({ name: 'MAX_LOOPS_HINT', source: 'overlay' });
	});
});

describe('splitMultiEnumValue', () => {
	it('splits on commas, trims, and drops blanks', () => {
		expect(splitMultiEnumValue(' CRITICAL , HIGH,,')).toEqual(['CRITICAL', 'HIGH']);
		expect(splitMultiEnumValue('')).toEqual([]);
	});
});

describe('validatePlaybookParamValue', () => {
	const spec = (overrides: Partial<PlaybookParamSpec>): PlaybookParamSpec => ({
		name: 'PARAM',
		type: 'string',
		required: false,
		source: 'overlay',
		...overrides,
	});

	it('fails a blank value only when the spec is required', () => {
		expect(validatePlaybookParamValue(spec({ required: true }), '  ')).toBe('PARAM is required.');
		expect(validatePlaybookParamValue(spec({ type: 'number', min: 1 }), '')).toBeNull();
	});

	it('accepts any string, and rejects a leftover UNSET sentinel', () => {
		expect(validatePlaybookParamValue(spec({}), 'anything at all')).toBeNull();
		expect(validatePlaybookParamValue(spec({}), '<UNSET - describe it>')).toMatch(/placeholder/);
	});

	it('validates url values, rejecting the PR_URL placeholder', () => {
		const prUrl = spec({ name: 'PR_URL', type: 'url', required: true });
		expect(validatePlaybookParamValue(prUrl, 'https://github.com/acme/app/pull/12')).toBeNull();
		expect(validatePlaybookParamValue(prUrl, 'http://localhost:3000/x')).toBeNull();
		expect(validatePlaybookParamValue(prUrl, PLACEHOLDER_PR_URL)).toMatch(
			/PR_URL is still a placeholder/
		);
		expect(validatePlaybookParamValue(prUrl, 'github.com/acme/app/pull/12')).toMatch(
			/must be a URL/
		);
		expect(validatePlaybookParamValue(prUrl, 'ftp://example.com/file')).toMatch(/http or https/);
		expect(validatePlaybookParamValue(prUrl, 'javascript:alert(1)')).toMatch(/http or https/);
	});

	it('validates number values against min and max', () => {
		const loops = spec({ name: 'MAX_LOOPS', type: 'number', min: 1, max: 30 });
		expect(validatePlaybookParamValue(loops, '30')).toBeNull();
		expect(validatePlaybookParamValue(loops, ' 1 ')).toBeNull();
		expect(validatePlaybookParamValue(loops, '2.5')).toBeNull();
		expect(validatePlaybookParamValue(loops, 'ten')).toBe('MAX_LOOPS must be a number.');
		expect(validatePlaybookParamValue(loops, 'Infinity')).toBe('MAX_LOOPS must be a number.');
		expect(validatePlaybookParamValue(loops, '0')).toBe('MAX_LOOPS must be at least 1.');
		expect(validatePlaybookParamValue(loops, '300')).toBe('MAX_LOOPS must be at most 30.');
	});

	it('validates multi-enum tokens case-sensitively against options', () => {
		const severity = spec({
			name: 'AUTO_FIX_SEVERITY',
			type: 'multi-enum',
			options: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
		});
		expect(validatePlaybookParamValue(severity, 'CRITICAL, HIGH')).toBeNull();
		expect(validatePlaybookParamValue(severity, 'Critical,SEV1')).toBe(
			'AUTO_FIX_SEVERITY does not allow "Critical", "SEV1". Choose from: CRITICAL, HIGH, MEDIUM, LOW.'
		);
		expect(validatePlaybookParamValue({ ...severity, required: true }, ' , ')).toBe(
			'AUTO_FIX_SEVERITY is required.'
		);
		// With no declared options there is nothing to enforce.
		expect(validatePlaybookParamValue(spec({ type: 'multi-enum' }), 'anything')).toBeNull();
	});

	it('applies pattern as a full match', () => {
		const branch = spec({ name: 'BRANCH', pattern: 'feat/[a-z-]+' });
		expect(validatePlaybookParamValue(branch, 'feat/new-thing')).toBeNull();
		expect(validatePlaybookParamValue(branch, 'xfeat/new-thing')).toBe(
			'BRANCH must match the pattern feat/[a-z-]+.'
		);
		expect(validatePlaybookParamValue(spec({ pattern: 'a|b' }), 'ab')).toMatch(/must match/);
		expect(validatePlaybookParamValue(spec({ pattern: '(' }), 'x')).toMatch(/invalid pattern/);
	});
});

function spec(name: string, extra: Partial<PlaybookParamSpec> = {}): PlaybookParamSpec {
	return { name, type: 'string', required: false, source: 'prose', ...extra };
}

describe('substitutePlaybookParams', () => {
	it('substitutes the answer, then the default, and leaves a value-less name in place', () => {
		const specs = [
			spec('MAX_ITEMS', { default: '25' }),
			spec('BASE_BRANCH', { default: 'main' }),
			spec('PR_URL', { required: true }),
		];
		const result = substitutePlaybookParams(
			'Process [MAX_ITEMS] items on [BASE_BRANCH] for [PR_URL], then [MAX_ITEMS] more.',
			specs,
			{ MAX_ITEMS: '10' }
		);
		expect(result.text).toBe('Process 10 items on main for [PR_URL], then 10 more.');
		expect(result.substituted).toEqual(['MAX_ITEMS', 'BASE_BRANCH']);
		expect(result.unresolved).toEqual(['PR_URL']);
	});

	it('never substitutes an empty string: a blank or placeholder answer falls back to the default', () => {
		const specs = [spec('SCOPE_IN', { default: 'everything' }), spec('PR_URL')];
		const result = substitutePlaybookParams('[SCOPE_IN] / [PR_URL]', specs, {
			SCOPE_IN: '   ',
			PR_URL: PLACEHOLDER_PR_URL,
		});
		expect(result.text).toBe('everything / [PR_URL]');
		expect(result.unresolved).toEqual(['PR_URL']);
	});

	it('trims the answer and inserts dollar sequences literally', () => {
		const result = substitutePlaybookParams('cost: [PRICE]', [spec('PRICE')], {
			PRICE: '  $& and $1  ',
		});
		expect(result.text).toBe('cost: $& and $1');
	});

	it('spares wiki links, markdown links, reference links, and undeclared names', () => {
		const specs = [spec('NAME', { default: 'x-value' })];
		const text = [
			'[[NAME]] is a wiki link.',
			'[NAME](https://example.com) is a link.',
			'[NAME][ref] is a reference link.',
			'[OTHER] is not declared.',
			'[NAME] is a reference.',
		].join('\n');
		const result = substitutePlaybookParams(text, specs, {});
		expect(result.text).toBe(
			[
				'[[NAME]] is a wiki link.',
				'[NAME](https://example.com) is a link.',
				'[NAME][ref] is a reference link.',
				'[OTHER] is not declared.',
				'x-value is a reference.',
			].join('\n')
		);
		expect(result.substituted).toEqual(['NAME']);
	});

	it('is case-sensitive, so [date] in prose is untouched', () => {
		const specs = [spec('DATE', { default: '2026-01-01' })];
		const result = substitutePlaybookParams('Write [date] and [Date], not [DATE].', specs, {});
		expect(result.text).toBe('Write [date] and [Date], not 2026-01-01.');
	});

	it('matches the longest name first and does not touch a prefix inside a longer reference', () => {
		const specs = [
			spec('PR', { default: 'short' }),
			spec('PR_URL', { default: 'long' }),
			spec('PR_A_URL', { default: 'longest' }),
		];
		const result = substitutePlaybookParams('[PR] [PR_URL] [PR_A_URL] [PR_B_URL]', specs, {});
		expect(result.text).toBe('short long longest [PR_B_URL]');
	});

	it('never matches a task checkbox, even with every name in the repo declared', () => {
		const specs = REPO_PARAM_NAMES.map((name) => spec(name, { default: 'VALUE' }));
		// Single-character names are illegal; declaring them anyway must not widen the match.
		specs.push(
			spec('X', { default: 'VALUE' }),
			spec('x', { default: 'VALUE' }),
			spec(' ', { default: 'VALUE' })
		);
		const checklist = [
			'- [ ] open task',
			'- [x] done task',
			'- [X] done task',
			'* [ ] star task',
			'1. [ ] numbered',
		].join('\n');
		const result = substitutePlaybookParams(checklist, specs, {});
		expect(result.text).toBe(checklist);
		expect(result.substituted).toEqual([]);
		expect(assertNoSurvivingParams(checklist, specs)).toEqual([]);
	});

	it('does not apply {{TEMPLATE}} substitution', () => {
		const result = substitutePlaybookParams('{{DATE}} [MAX_ITEMS]', [spec('MAX_ITEMS')], {
			MAX_ITEMS: '{{AGENT_NAME}}',
		});
		expect(result.text).toBe('{{DATE}} {{AGENT_NAME}}');
	});

	it('returns the text unchanged when no name is declared', () => {
		expect(substitutePlaybookParams('[MAX_ITEMS]', [], {})).toEqual({
			text: '[MAX_ITEMS]',
			substituted: [],
			unresolved: [],
		});
	});

	it('substitutes a parsed form across a document', () => {
		const specs = parsePlaybookParameterForm(RESEARCH_CORPUS_PROMPT);
		const names = specs.map((parsed) => parsed.name);
		const document = `- [ ] Process ${names.map((name) => `[${name}]`).join(' ')}`;
		const values = Object.fromEntries(names.map((name) => [name, `v-${name}`]));
		const result = substitutePlaybookParams(document, specs, values);
		expect(result.unresolved).toEqual([]);
		expect(result.substituted).toEqual(names);
		expect(assertNoSurvivingParams(result.text, specs)).toEqual([]);
		expect(result.text.startsWith('- [ ] Process ')).toBe(true);
	});
});

describe('assertNoSurvivingParams', () => {
	it('reports each declared reference still present, once, in order', () => {
		const specs = [spec('PR_URL'), spec('MAX_ITEMS'), spec('BASE_BRANCH')];
		expect(
			assertNoSurvivingParams(
				'[MAX_ITEMS] then [PR_URL] then [MAX_ITEMS] and [[BASE_BRANCH]]',
				specs
			)
		).toEqual(['MAX_ITEMS', 'PR_URL']);
	});

	it('returns nothing for clean text or no declarations', () => {
		expect(assertNoSurvivingParams('all resolved', [spec('PR_URL')])).toEqual([]);
		expect(assertNoSurvivingParams('[PR_URL]', [])).toEqual([]);
	});
});

describe('collectUnresolvedRequired', () => {
	it('returns only required specs with no answer and no default', () => {
		const specs = [
			spec('PR_URL', { required: true }),
			spec('MARKET_TOPIC', { required: true }),
			spec('BASE_BRANCH', { required: true, default: 'main' }),
			spec('SCOPE_IN'),
		];
		const missing = collectUnresolvedRequired(specs, { MARKET_TOPIC: 'EV chargers', PR_URL: '  ' });
		expect(missing.map((missingSpec) => missingSpec.name)).toEqual(['PR_URL']);
	});

	it('treats a placeholder answer as missing', () => {
		const specs = [spec('PR_URL', { required: true })];
		expect(collectUnresolvedRequired(specs, { PR_URL: PLACEHOLDER_PR_URL })).toHaveLength(1);
		expect(
			collectUnresolvedRequired(specs, { PR_URL: 'https://github.com/acme/app/pull/12' })
		).toEqual([]);
	});

	it('flags the parsed Research/Market topic until it is answered', () => {
		const specs = parsePlaybookParameterForm(RESEARCH_MARKET_PROMPT);
		expect(collectUnresolvedRequired(specs, {}).map((missing) => missing.name)).toEqual([
			'MARKET_TOPIC',
		]);
		expect(collectUnresolvedRequired(specs, { MARKET_TOPIC: 'EV chargers' })).toEqual([]);
	});
});

describe('buildResolvedConfigurationTable', () => {
	it('lists each parameter with its resolved value, UNSET when it has none', () => {
		const specs = [
			spec('MAX_ITEMS', { default: '25' }),
			spec('SCOPE_IN'),
			spec('SEARCH', { default: 'a' }),
			spec('MAX_ITEMS', { default: 'ignored repeat' }),
		];
		expect(buildResolvedConfigurationTable(specs, { SEARCH: 'a | b\nc' })).toBe(
			[
				'## Resolved Configuration',
				'',
				'| Parameter | Value |',
				'| --- | --- |',
				'| `MAX_ITEMS` | 25 |',
				'| `SCOPE_IN` | `<UNSET>` |',
				'| `SEARCH` | a \\| b<br>c |',
			].join('\n')
		);
	});

	it('never writes a bracketed reference that would trip the assertion', () => {
		const specs = parsePlaybookParameterForm(ASSISTANTS_MESSAGE_BUS_PROMPT);
		const table = buildResolvedConfigurationTable(specs, {});
		expect(assertNoSurvivingParams(table, specs)).toEqual([]);
	});

	it('returns an empty string when there are no specs', () => {
		expect(buildResolvedConfigurationTable([], {})).toBe('');
	});
});

describe('isPlaybookParamType', () => {
	it('accepts the four declared types only', () => {
		for (const type of ['string', 'url', 'number', 'multi-enum']) {
			expect(isPlaybookParamType(type)).toBe(true);
		}
		for (const type of ['String', 'enum', 'decimal', '', undefined, 1]) {
			expect(isPlaybookParamType(type)).toBe(false);
		}
	});
});

describe('readPlaybookParamOverlay', () => {
	it('keeps well-formed entries field by field', () => {
		expect(
			readPlaybookParamOverlay([
				{
					name: 'SCOPE',
					type: 'multi-enum',
					required: false,
					options: ['repo', 'org'],
					pattern: '[a-z,]+',
					min: 1,
					max: 3,
					default: 'repo',
					help: 'ignored: prose owns it',
				},
			])
		).toEqual([
			{
				name: 'SCOPE',
				type: 'multi-enum',
				required: false,
				options: ['repo', 'org'],
				pattern: '[a-z,]+',
				min: 1,
				max: 3,
			},
		]);
	});

	it('drops illegal names and malformed fields instead of storing them', () => {
		expect(
			readPlaybookParamOverlay([
				null,
				'TOPIC',
				{ name: 'x' },
				{ name: 42 },
				{
					name: 'DEPTH',
					type: 'decimal',
					required: 'yes',
					options: ['a', 2],
					pattern: /x/,
					min: Number.NaN,
					max: '5',
				},
			])
		).toEqual([{ name: 'DEPTH' }]);
	});

	it('returns undefined for a non-array or an overlay with nothing usable', () => {
		expect(readPlaybookParamOverlay(undefined)).toBeUndefined();
		expect(readPlaybookParamOverlay({ name: 'TOPIC' })).toBeUndefined();
		expect(readPlaybookParamOverlay([{ name: 'bad' }])).toBeUndefined();
	});
});

describe('readPlaybookParamValues', () => {
	it('keeps legal names with string values, numbers included as text', () => {
		expect(readPlaybookParamValues({ TOPIC: 'EV chargers', DEPTH: '3' })).toEqual({
			TOPIC: 'EV chargers',
			DEPTH: '3',
		});
	});

	it('drops non-string values and illegal names', () => {
		expect(readPlaybookParamValues({ TOPIC: 42, lower: 'x', A: 'one char', GOOD: 'kept' })).toEqual(
			{ GOOD: 'kept' }
		);
	});

	it('returns undefined for a non-object or nothing usable', () => {
		expect(readPlaybookParamValues(undefined)).toBeUndefined();
		expect(readPlaybookParamValues(['TOPIC'])).toBeUndefined();
		expect(readPlaybookParamValues('TOPIC=x')).toBeUndefined();
		expect(readPlaybookParamValues({ TOPIC: 1 })).toBeUndefined();
	});
});

describe('resolvePlaybookParamSpecs', () => {
	const prompt = '<!-- CONFIGURE: How many -->\n**MAX_ITEMS:** `25`\n';

	it('merges the prompt prose with the overlay', () => {
		const [spec] = resolvePlaybookParamSpecs(prompt, [{ name: 'MAX_ITEMS', type: 'number' }]);
		expect(spec).toMatchObject({
			name: 'MAX_ITEMS',
			type: 'number',
			default: '25',
			source: 'both',
		});
	});

	it('reads the prose alone when there is no overlay', () => {
		const [spec] = resolvePlaybookParamSpecs(prompt, undefined);
		expect(spec).toMatchObject({ name: 'MAX_ITEMS', type: 'string', source: 'prose' });
	});
});

describe('expandPlaybookParamTemplates', () => {
	const spec = (name: string, def?: string): PlaybookParamSpec => ({
		name,
		type: 'string',
		required: def === undefined,
		source: 'prose',
		...(def !== undefined && { default: def }),
	});

	it('expands template variables in defaults and answers without mutating the inputs', () => {
		const specs = [spec('ROOT', '{{AGENT_PATH}}/src'), spec('TOPIC')];
		const values = { TOPIC: 'about {{AGENT_NAME}}' };
		const expand = (text: string) =>
			text.replace('{{AGENT_PATH}}', '/repo').replace('{{AGENT_NAME}}', 'Ada');

		const expanded = expandPlaybookParamTemplates({ specs, values }, expand);

		expect(expanded.specs[0].default).toBe('/repo/src');
		expect(expanded.specs[1]).toBe(specs[1]);
		expect(expanded.values).toEqual({ TOPIC: 'about Ada' });
		expect(specs[0].default).toBe('{{AGENT_PATH}}/src');
		expect(values.TOPIC).toBe('about {{AGENT_NAME}}');
	});
});

describe('applyPlaybookParamsToPrompt', () => {
	const specs: PlaybookParamSpec[] = [
		{ name: 'MAX_ITEMS', type: 'string', default: '25', required: false, source: 'prose' },
		{ name: 'PR_URL', type: 'url', required: true, source: 'prose' },
	];

	it('substitutes the prompt and appends the Resolved Configuration table', () => {
		const result = applyPlaybookParamsToPrompt('Process [MAX_ITEMS] items for [PR_URL].', '', {
			specs,
			values: { PR_URL: 'https://github.com/acme/app/pull/7' },
		});

		expect(
			result.prompt.startsWith('Process 25 items for https://github.com/acme/app/pull/7.')
		).toBe(true);
		expect(result.prompt).toContain('## Resolved Configuration');
		expect(result.surviving).toEqual([]);
	});

	it('reports tokens surviving in the document or the prompt, each once', () => {
		const result = applyPlaybookParamsToPrompt(
			'Open [PR_URL].',
			'Review [PR_URL] twice: [PR_URL]',
			{
				specs,
				values: {},
			}
		);
		expect(result.surviving).toEqual(['PR_URL']);
	});

	it('passes the prompt through unchanged when there are no specs', () => {
		expect(applyPlaybookParamsToPrompt('Keep [MAX_ITEMS].', '', { specs: [], values: {} })).toEqual(
			{
				prompt: 'Keep [MAX_ITEMS].',
				surviving: [],
			}
		);
	});
});

describe('restatePlaybookParameterForm', () => {
	const marker: PlaybookParamSpec = {
		name: 'TRIGGER_MARKER',
		type: 'string',
		default: '@maestro',
		required: true,
		source: 'prose',
	};
	const dir: PlaybookParamSpec = {
		name: 'INSTALL_DIR',
		type: 'string',
		default: '~/bin/bus',
		required: false,
		source: 'prose',
	};
	const form = [
		'<!-- CONFIGURE: The trigger marker -->',
		'**TRIGGER_MARKER:** `@maestro`',
		'',
		'<!-- CONFIGURE: Where it goes -->',
		'**INSTALL_DIR:** `~/bin/bus`',
	].join('\n');

	it('restates each declaration with the answer the run resolved', () => {
		const out = restatePlaybookParameterForm(form, [marker, dir], { TRIGGER_MARKER: '@pbxbus' });
		expect(out).toContain('**TRIGGER_MARKER:** `@pbxbus`');
		// A parameter on its default keeps the default.
		expect(out).toContain('**INSTALL_DIR:** `~/bin/bus`');
	});

	it('leaves fenced examples, undeclared names, and unsafe values alone', () => {
		const fenced = '```\n**TRIGGER_MARKER:** `@maestro`\n```\n**OTHER:** `x`';
		expect(restatePlaybookParameterForm(fenced, [marker], { TRIGGER_MARKER: '@pbxbus' })).toBe(
			fenced
		);
		expect(restatePlaybookParameterForm(form, [marker], { TRIGGER_MARKER: 'a`b' })).toBe(form);
	});

	it('runs inside applyPlaybookParamsToPrompt, so the agent reads one value', () => {
		const result = applyPlaybookParamsToPrompt(`${form}\n\nWatch for [TRIGGER_MARKER].`, '', {
			specs: [marker, dir],
			values: { TRIGGER_MARKER: '@pbxbus' },
		});
		expect(result.prompt).not.toContain('@maestro');
		expect(result.prompt).toContain('Watch for @pbxbus.');
	});
});

describe('describeSurvivingParams', () => {
	it('names every surviving token', () => {
		expect(describeSurvivingParams(['PR_URL', 'TOPIC'])).toBe(
			'Playbook parameters have no value: [PR_URL], [TOPIC]. Configure them, then resume.'
		);
	});
});

describe('describeMissingRequiredParams', () => {
	it('names every missing required parameter in spec order', () => {
		const specs = resolvePlaybookParamSpecs('', [{ name: 'PR_URL' }, { name: 'TOPIC' }]);
		expect(describeMissingRequiredParams(specs)).toBe('Missing required parameters: PR_URL, TOPIC');
	});
});

describe('mergeProposedParamValues', () => {
	it('fills only names the user has not answered, keeping a cleared answer', () => {
		const merged = mergeProposedParamValues(
			{ PR_URL: 'https://github.com/a/b/pull/1', BRANCH: '' },
			{
				PR_URL: { value: 'https://github.com/a/b/pull/9' },
				BRANCH: { value: 'main' },
				MAX_ITEMS: { value: '10', evidence: 'facts' },
			}
		);
		expect(merged).toEqual({
			PR_URL: 'https://github.com/a/b/pull/1',
			BRANCH: '',
			MAX_ITEMS: '10',
		});
	});

	it('returns a copy of the answers when there are no proposals', () => {
		const answers = { A_B: 'x' };
		const merged = mergeProposedParamValues(answers, undefined);
		expect(merged).toEqual(answers);
		expect(merged).not.toBe(answers);
	});
});

describe('describePlaybookParamProvenance', () => {
	const withDefault = spec('MAX_ITEMS', { default: '25' });
	const noDefault = spec('PR_URL', { required: true });

	it('is "you" for a usable answer', () => {
		expect(describePlaybookParamProvenance(withDefault, { MAX_ITEMS: '5' }, undefined)).toBe('you');
	});

	it('is "detected" for a proposal on an unanswered name', () => {
		expect(
			describePlaybookParamProvenance(noDefault, {}, { PR_URL: { value: 'https://x.dev/p/1' } })
		).toBe('detected');
	});

	it('ignores a proposal once the user has answered, even with a blank', () => {
		expect(
			describePlaybookParamProvenance(withDefault, { MAX_ITEMS: '' }, { MAX_ITEMS: { value: '9' } })
		).toBe('default');
	});

	it('falls back to "default", then "unresolved"', () => {
		expect(describePlaybookParamProvenance(withDefault, {}, undefined)).toBe('default');
		expect(describePlaybookParamProvenance(noDefault, {}, undefined)).toBe('unresolved');
	});

	it('treats a placeholder answer or proposal as no value', () => {
		expect(
			describePlaybookParamProvenance(noDefault, { PR_URL: PLACEHOLDER_PR_URL }, undefined)
		).toBe('unresolved');
		expect(
			describePlaybookParamProvenance(noDefault, {}, { PR_URL: { value: PLACEHOLDER_PR_URL } })
		).toBe('unresolved');
	});
});

describe('compactPlaybookParamValues', () => {
	it('drops blank answers and keeps the rest verbatim', () => {
		expect(compactPlaybookParamValues({ A_A: ' x ', B_B: '', C_C: '   ' })).toEqual({ A_A: ' x ' });
	});
});

describe('proposeFromFacts', () => {
	const spec = (name: string, type: PlaybookParamSpec['type'] = 'string'): PlaybookParamSpec => ({
		name,
		type,
		required: true,
		source: 'overlay',
	});
	const facts = (overrides: Partial<PlaybookFacts> = {}): PlaybookFacts => ({
		cwd: '/work/repo',
		isSshRemote: false,
		gitBranch: 'feat/x',
		gitRemoteUrl: 'https://github.com/acme/repo.git',
		openPrUrlsForBranch: ['https://github.com/acme/repo/pull/7'],
		hasGh: true,
		hasPython3: true,
		unknownProbes: [],
		encoreFlags: resolveEncoreFeatures(undefined),
		cueSubscriptionCount: 0,
		...overrides,
	});

	it('fills a PR url, the current branch, and the working directory', () => {
		const proposals = proposeFromFacts(
			[spec('PR_URL', 'url'), spec('BRANCH'), spec('WORK_DIR'), spec('CWD'), spec('WORKING_DIR')],
			facts()
		);
		expect(proposals).toEqual({
			PR_URL: {
				value: 'https://github.com/acme/repo/pull/7',
				evidence: 'Open pull request for branch feat/x',
			},
			BRANCH: { value: 'feat/x', evidence: 'Current git branch' },
			WORK_DIR: { value: '/work/repo', evidence: 'Agent working directory on this machine' },
			CWD: { value: '/work/repo', evidence: 'Agent working directory on this machine' },
			WORKING_DIR: { value: '/work/repo', evidence: 'Agent working directory on this machine' },
		});
	});

	it('names the SSH remote as the source of the working directory', () => {
		expect(proposeFromFacts([spec('WORK_DIR')], facts({ isSshRemote: true })).WORK_DIR).toEqual({
			value: '/work/repo',
			evidence: 'Agent working directory on the SSH remote',
		});
	});

	it('matches whole name segments, so PROJECT_URL is not a PR', () => {
		expect(
			proposeFromFacts([spec('PROJECT_URL', 'url'), spec('PREVIEW_URL', 'url')], facts())
		).toEqual({});
	});

	it('only proposes a PR into a url-typed parameter', () => {
		expect(proposeFromFacts([spec('PR_NUMBER', 'number'), spec('PR')], facts())).toEqual({});
	});

	it('never proposes the current branch for a base or target branch', () => {
		const names = [
			'BASE_BRANCH',
			'TARGET_BRANCH',
			'DEFAULT_BRANCH',
			'UPSTREAM_BRANCH',
			'MAIN_BRANCH',
		];
		expect(
			proposeFromFacts(
				names.map((name) => spec(name)),
				facts()
			)
		).toEqual({});
		expect(proposeFromFacts([spec('FEATURE_BRANCH')], facts()).FEATURE_BRANCH?.value).toBe(
			'feat/x'
		);
	});

	it('proposes nothing when the fact is missing', () => {
		expect(
			proposeFromFacts(
				[spec('PR_URL', 'url'), spec('BRANCH'), spec('WORK_DIR')],
				facts({ openPrUrlsForBranch: [], gitBranch: undefined, cwd: '' })
			)
		).toEqual({});
	});

	it('drops a proposal the spec would reject', () => {
		const strict: PlaybookParamSpec = { ...spec('BRANCH'), pattern: 'release/.*' };
		expect(proposeFromFacts([strict], facts())).toEqual({});
		expect(
			proposeFromFacts([spec('PR_URL', 'url')], facts({ openPrUrlsForBranch: ['not a url'] }))
		).toEqual({});
	});
});

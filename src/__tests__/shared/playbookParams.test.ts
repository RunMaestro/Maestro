import { describe, expect, it } from 'vitest';
import {
	PLACEHOLDER_PR_URL,
	isPlaceholderDefault,
	mergePlaybookParams,
	parsePlaybookParameterForm,
	splitMultiEnumValue,
	validatePlaybookParamValue,
	type PlaybookParamOverlay,
	type PlaybookParamSpec,
} from '../../shared/playbookParams';
import {
	ASSISTANTS_MESSAGE_BUS_PROMPT,
	RESEARCH_CORPUS_PROMPT,
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
		expect(spec.SEED_SOURCE).toMatchObject({ required: false, default: undefined });

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
			default: undefined,
			help: 'What you want processed. One source, not a list.',
		});
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

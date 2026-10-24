/**
 * Rendering contract for the corrective text TTSR feeds back to an agent
 * (finding AC1).
 *
 * Two properties matter here. Tool-sourced interrupts must contradict the
 * provider CLI's own "the tool use was rejected" claim and name the files the
 * already-executed tool touched. Prose-only interrupts must render exactly as
 * they always did, since nothing landed on disk for them.
 */

import { describe, it, expect } from 'vitest';
import { renderTtsrInterrupt, renderTtsrReminder } from '../../../main/ttsr/ttsr-injection';
import type { TtsrMatch } from '../../../main/ttsr/ttsr-manager';
import type { TtsrMatchSource } from '../../../main/ttsr/ttsr-matcher';
import type { LoadedTtsrRule } from '../../../shared/ttsr-types';

function makeRule(overrides: Partial<LoadedTtsrRule> = {}): LoadedTtsrRule {
	const condition = overrides.condition ?? ['console\\.log\\('];
	return {
		name: 'no-console-log',
		description: 'Flag stray console.log',
		condition,
		astCondition: [],
		scope: ['tool:write'],
		globs: [],
		interruptMode: 'always',
		repeatMode: 'after-gap',
		repeatGap: 3,
		agents: ['claude-code'],
		content: 'Use the project logger.',
		path: '.maestro/rules/no-console-log.md',
		compiledCondition: condition.map((source) => new RegExp(source)),
		...overrides,
	};
}

function makeMatch(
	source: TtsrMatchSource,
	filePath?: string,
	rule: LoadedTtsrRule = makeRule()
): TtsrMatch {
	return {
		rule,
		source,
		disposition: 'interrupt',
		matchedText: 'console.log(',
		...(filePath ? { filePath } : {}),
	};
}

/** What the renderer produced before AC1's fix, for the prose regression guard. */
const LEGACY_PROSE_BLOCK =
	'<system-interrupt reason="rule_violation" rule="no-console-log" path=".maestro/rules/no-console-log.md">\n' +
	'Use the project logger.\n' +
	'</system-interrupt>';

describe('renderTtsrInterrupt', () => {
	it('warns that a tool-sourced write already landed and names the file', () => {
		const block = renderTtsrInterrupt([makeMatch('tool:write', 'src/a.ts')]);
		expect(block).toContain('already run');
		expect(block).toContain('already applied on disk');
		expect(block).toContain('must be disregarded');
		expect(block).toContain('affected-files="src/a.ts"');
		// The preamble sits above the blocks so the agent reads it first.
		expect(block.indexOf('already applied on disk')).toBeLessThan(
			block.indexOf('<system-interrupt')
		);
	});

	it('aggregates every file one rule tripped on into a single block', () => {
		const rule = makeRule();
		const block = renderTtsrInterrupt([
			makeMatch('tool:write', 'src/a.ts', rule),
			makeMatch('tool:edit', 'src/b.ts', rule),
			// Repeat of a path already listed: named once, in fire order.
			makeMatch('tool:edit', 'src/a.ts', rule),
		]);
		expect(block.match(/<system-interrupt/g)).toHaveLength(1);
		expect(block).toContain('affected-files="src/a.ts, src/b.ts"');
	});

	it('renders a prose-only interrupt byte-identically to the pre-fix output', () => {
		expect(renderTtsrInterrupt([makeMatch('text')])).toBe(LEGACY_PROSE_BLOCK);
		expect(renderTtsrInterrupt([makeMatch('thinking')])).toBe(LEGACY_PROSE_BLOCK);
		const both = renderTtsrInterrupt([makeMatch('text'), makeMatch('thinking')]);
		expect(both).toBe(LEGACY_PROSE_BLOCK);
		expect(both).not.toContain('affected-files');
	});

	it('gives a bash match the preamble but no affected-files attribute', () => {
		const block = renderTtsrInterrupt([makeMatch('tool:bash')]);
		expect(block).toContain('already applied on disk');
		// The preamble names the attribute in prose; the tag must not carry it.
		expect(block).not.toContain('affected-files=');
	});

	it('escapes quotes and angle brackets in an affected path', () => {
		const block = renderTtsrInterrupt([makeMatch('tool:write', 'src/we"ird<x>.ts')]);
		expect(block).toContain('affected-files="src/we&quot;ird&lt;x>.ts"');
		expect(block).toContain('">\nUse the project logger.');
	});
});

describe('renderTtsrReminder', () => {
	it('names the path for a tool-source match without the interrupt preamble', () => {
		const reminder = renderTtsrReminder([
			{ ...makeMatch('tool:write', 'src/a.ts'), disposition: 'deferred-tool' },
		]);
		expect(reminder.startsWith('<system-reminder reason="rule_violation"')).toBe(true);
		expect(reminder).toContain('affected-files="src/a.ts"');
		expect(reminder).not.toContain('already applied on disk');
	});
});

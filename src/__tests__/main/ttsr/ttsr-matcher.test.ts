/**
 * Tests for the pure TTSR match predicates (Phase 2b/2c verification).
 *
 * Covers scope narrowing, the `agents` gate, the glob path gate (hit, miss,
 * absolute-path relativization, Windows separators), regex evaluation
 * including sticky/global `lastIndex` safety, and the
 * interruptMode x source classification table.
 */

import { describe, it, expect } from 'vitest';
import {
	classifyMatch,
	findRegexMatch,
	interruptModeAllows,
	isProseSource,
	matchesGlobs,
	ruleAppliesToContext,
} from '../../../main/ttsr/ttsr-matcher';
import type { LoadedTtsrRule } from '../../../shared/ttsr-types';

function makeRule(overrides: Partial<LoadedTtsrRule> = {}): LoadedTtsrRule {
	const condition = overrides.condition ?? ['console\\.log\\('];
	return {
		name: 'no-console-log',
		description: 'Flag stray console.log',
		condition,
		astCondition: [],
		scope: ['text', 'thinking'],
		globs: [],
		interruptMode: 'always',
		repeatMode: 'after-gap',
		repeatGap: 3,
		agents: ['claude-code', 'codex'],
		content: 'Use the project logger.',
		path: '.maestro/rules/no-console-log.md',
		compiledCondition: condition.map((source) => new RegExp(source)),
		...overrides,
	};
}

describe('isProseSource', () => {
	it('treats text and thinking as prose and tool sources as not', () => {
		expect(isProseSource('text')).toBe(true);
		expect(isProseSource('thinking')).toBe(true);
		expect(isProseSource('tool:edit')).toBe(false);
		expect(isProseSource('tool:write')).toBe(false);
	});
});

describe('interruptModeAllows', () => {
	it('covers the full mode x source table', () => {
		expect(interruptModeAllows('never', 'text')).toBe(false);
		expect(interruptModeAllows('never', 'tool:edit')).toBe(false);
		expect(interruptModeAllows('always', 'text')).toBe(true);
		expect(interruptModeAllows('always', 'tool:write')).toBe(true);
		expect(interruptModeAllows('prose-only', 'thinking')).toBe(true);
		expect(interruptModeAllows('prose-only', 'tool:edit')).toBe(false);
		expect(interruptModeAllows('tool-only', 'text')).toBe(false);
		expect(interruptModeAllows('tool-only', 'tool:edit')).toBe(true);
	});
});

describe('classifyMatch', () => {
	it('routes non-interrupting matches to the matching deferred bucket', () => {
		expect(classifyMatch(makeRule({ interruptMode: 'never' }), 'text')).toBe('deferred-prose');
		expect(classifyMatch(makeRule({ interruptMode: 'never' }), 'tool:edit')).toBe('deferred-tool');
		expect(classifyMatch(makeRule({ interruptMode: 'prose-only' }), 'tool:write')).toBe(
			'deferred-tool'
		);
		expect(classifyMatch(makeRule({ interruptMode: 'tool-only' }), 'thinking')).toBe(
			'deferred-prose'
		);
	});

	it('routes permitted matches to interrupt', () => {
		expect(classifyMatch(makeRule({ interruptMode: 'always' }), 'text')).toBe('interrupt');
		expect(classifyMatch(makeRule({ interruptMode: 'tool-only' }), 'tool:edit')).toBe('interrupt');
	});
});

describe('matchesGlobs', () => {
	it('treats an empty glob list as "any path"', () => {
		expect(matchesGlobs([], 'anywhere/at/all.ts')).toBe(true);
	});

	it('matches and rejects project-relative paths', () => {
		expect(matchesGlobs(['src/**/*.ts'], 'src/main/thing.ts')).toBe(true);
		expect(matchesGlobs(['src/**/*.ts'], 'docs/thing.md')).toBe(false);
	});

	it('relativizes absolute paths against the project root', () => {
		const cwd = process.platform === 'win32' ? 'C:\\repo' : '/repo';
		const file = process.platform === 'win32' ? 'C:\\repo\\src\\a.ts' : '/repo/src/a.ts';
		expect(matchesGlobs(['src/**/*.ts'], file, cwd)).toBe(true);
	});

	it('normalizes Windows separators before matching', () => {
		expect(matchesGlobs(['src/**/*.ts'], 'src\\main\\thing.ts')).toBe(true);
	});

	it('keeps the original path when the file lives outside the project root', () => {
		const cwd = process.platform === 'win32' ? 'C:\\repo' : '/repo';
		const file = process.platform === 'win32' ? 'C:\\other\\a.ts' : '/other/a.ts';
		expect(matchesGlobs(['src/**/*.ts'], file, cwd)).toBe(false);
	});
});

describe('ruleAppliesToContext', () => {
	it('applies the agents gate', () => {
		const rule = makeRule({ agents: ['claude-code'] });
		expect(ruleAppliesToContext(rule, { agentId: 'claude-code', source: 'text' })).toBe(true);
		expect(ruleAppliesToContext(rule, { agentId: 'codex', source: 'text' })).toBe(false);
	});

	it('narrows by scope', () => {
		const rule = makeRule({ scope: ['thinking'] });
		expect(ruleAppliesToContext(rule, { agentId: 'claude-code', source: 'thinking' })).toBe(true);
		expect(ruleAppliesToContext(rule, { agentId: 'claude-code', source: 'text' })).toBe(false);
	});

	it('gates tool sources on globs and requires a path when globs are declared', () => {
		const rule = makeRule({ scope: ['tool:edit'], globs: ['src/**/*.ts'] });
		expect(
			ruleAppliesToContext(rule, {
				agentId: 'claude-code',
				source: 'tool:edit',
				filePath: 'src/a.ts',
			})
		).toBe(true);
		expect(
			ruleAppliesToContext(rule, {
				agentId: 'claude-code',
				source: 'tool:edit',
				filePath: 'docs/a.md',
			})
		).toBe(false);
		expect(ruleAppliesToContext(rule, { agentId: 'claude-code', source: 'tool:edit' })).toBe(false);
	});

	it('ignores globs for prose sources', () => {
		const rule = makeRule({ scope: ['text'], globs: ['src/**/*.ts'] });
		expect(ruleAppliesToContext(rule, { agentId: 'claude-code', source: 'text' })).toBe(true);
	});
});

describe('findRegexMatch', () => {
	it('returns the matched substring for the first hitting pattern', () => {
		const rule = makeRule({ condition: ['nope', 'console\\.log\\('] });
		expect(findRegexMatch(rule, 'then console.log(x)')).toBe('console.log(');
	});

	it('returns null when nothing matches and for empty text', () => {
		expect(findRegexMatch(makeRule(), 'all clean here')).toBeNull();
		expect(findRegexMatch(makeRule(), '')).toBeNull();
	});

	it('does not let a global regex carry lastIndex between calls', () => {
		const rule = makeRule();
		rule.compiledCondition = [/console\.log\(/g];
		expect(findRegexMatch(rule, 'console.log(a)')).toBe('console.log(');
		expect(findRegexMatch(rule, 'console.log(b)')).toBe('console.log(');
	});
});

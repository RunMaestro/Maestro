/**
 * Tests for TTSR's `astCondition` support (Phase 2 verification, AST half).
 *
 * Runs the real `@ast-grep/napi` engine - the point of these cases is that the
 * bundled grammars and metavariable semantics behave as the rule schema
 * promises, which a stubbed matcher could not prove. The degradation path (no
 * native module) is exercised with an injected loader.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	astLanguageForPath,
	createTtsrAstMatcher,
	type AstGrepModuleLike,
} from '../../../main/ttsr/ttsr-ast';
import { TtsrManager, type TtsrObserveContext } from '../../../main/ttsr/ttsr-manager';
import { TtsrStateStore } from '../../../main/ttsr/ttsr-state-store';
import type { ParsedEvent } from '../../../main/parsers/agent-output-parser';
import type { LoadedTtsrRule } from '../../../shared/ttsr-types';

const CWD = '/repo';

function makeAstRule(overrides: Partial<LoadedTtsrRule> = {}): LoadedTtsrRule {
	return {
		name: 'no-console-log',
		description: 'Flag stray console.log',
		condition: [],
		astCondition: ['console.log($$$ARGS)'],
		scope: ['tool:edit', 'tool:write'],
		globs: [],
		interruptMode: 'always',
		repeatMode: 'after-gap',
		repeatGap: 3,
		agents: ['claude-code', 'codex', 'opencode', 'copilot-cli'],
		content: 'Use the project logger.',
		path: '.maestro/rules/no-console-log.md',
		compiledCondition: [],
		...overrides,
	};
}

/** A claude-code style `Write` tool call. */
function writeEvent(filePath: string, content: string): ParsedEvent {
	return {
		type: 'tool_use',
		toolUseBlocks: [{ name: 'Write', id: 't1', input: { file_path: filePath, content } }],
	};
}

const ctx: TtsrObserveContext = { agentId: 'claude-code', cwd: CWD };

describe('astLanguageForPath', () => {
	it('maps the grammars bundled with @ast-grep/napi', () => {
		expect(astLanguageForPath('src/a.ts')).toBe('TypeScript');
		expect(astLanguageForPath('src/a.mts')).toBe('TypeScript');
		expect(astLanguageForPath('src/a.tsx')).toBe('Tsx');
		expect(astLanguageForPath('src/a.js')).toBe('JavaScript');
		expect(astLanguageForPath('src/a.jsx')).toBe('JavaScript');
		expect(astLanguageForPath('src/a.css')).toBe('Css');
		expect(astLanguageForPath('src/a.html')).toBe('Html');
	});

	it('returns null for paths with no bundled grammar', () => {
		// Python/Go/Rust would need `registerDynamicLanguage` with a compiled
		// grammar Maestro does not ship - AST rules are skipped there, not guessed.
		expect(astLanguageForPath('src/a.py')).toBeNull();
		expect(astLanguageForPath('src/a.go')).toBeNull();
		expect(astLanguageForPath('README.md')).toBeNull();
		expect(astLanguageForPath(undefined)).toBeNull();
	});

	it('handles Windows separators', () => {
		expect(astLanguageForPath('src\\renderer\\App.tsx')).toBe('Tsx');
	});
});

describe('createTtsrAstMatcher', () => {
	const matcher = createTtsrAstMatcher();

	it('matches a structural pattern against edit content', async () => {
		const hit = await matcher.find(
			['console.log($$$ARGS)'],
			'function f() {\n\tconsole.log("a", b);\n}',
			'src/f.ts'
		);
		expect(hit).toBe('console.log("a", b)');
	});

	it('honors metavariable identity', async () => {
		const pattern = ['if ($X) clearTimeout($X)'];
		const same = await matcher.find(pattern, 'if (timer) clearTimeout(timer);', 'src/f.ts');
		const different = await matcher.find(pattern, 'if (timer) clearTimeout(other);', 'src/f.ts');

		expect(same).toBe('if (timer) clearTimeout(timer);');
		expect(different).toBeNull();
	});

	it('tries every pattern and reports the first hit', async () => {
		const hit = await matcher.find(
			['debugger', 'console.log($$$ARGS)'],
			'const x = 1;\nconsole.log(x);',
			'src/f.ts'
		);
		expect(hit).toBe('console.log(x)');
	});

	it('returns null for a malformed pattern instead of throwing', async () => {
		await expect(matcher.find(['((('], 'const x = 1;', 'src/f.ts')).resolves.toBeNull();
	});

	it('skips files with no bundled grammar', async () => {
		expect(matcher.supports('main.py')).toBe(false);
		await expect(matcher.find(['print($X)'], 'print(1)', 'main.py')).resolves.toBeNull();
	});

	it('degrades to inert when the native module cannot be loaded', async () => {
		const missing = createTtsrAstMatcher(() => null);
		expect(missing.supports('src/f.ts')).toBe(false);
		await expect(
			missing.find(['console.log($$$ARGS)'], 'console.log(1)', 'src/f.ts')
		).resolves.toBeNull();
	});

	it('loads the native module once, even across misses', async () => {
		const load = vi.fn<() => AstGrepModuleLike | null>(() => null);
		const lazy = createTtsrAstMatcher(load);
		lazy.supports('src/f.ts');
		await lazy.find(['x'], 'x', 'src/f.ts');
		expect(load).toHaveBeenCalledTimes(1);
	});
});

describe('TtsrManager astCondition rules', () => {
	function setup(rules: LoadedTtsrRule[], store?: TtsrStateStore): TtsrManager {
		return new TtsrManager({ getRules: () => rules, isEnabled: () => true, store });
	}

	it('fires an AST rule on a write snapshot and queues it as an interrupt', async () => {
		const manager = setup([makeAstRule()]);
		const event = writeEvent('/repo/src/f.ts', 'export function f() {\n\tconsole.log(1);\n}');

		const matches = await manager.observeAst('s1', event, ctx);

		expect(matches).toHaveLength(1);
		expect(matches[0].source).toBe('tool:write');
		expect(matches[0].matchedText).toBe('console.log(1)');
		expect(matches[0].filePath).toBe('/repo/src/f.ts');
		expect(manager.takeInterrupts('s1')).toHaveLength(1);
	});

	it('does not fire when the content is structurally clean', async () => {
		const manager = setup([makeAstRule()]);
		// The literal text "console.log(" appears, but only inside a string, which
		// is exactly the false positive `astCondition` exists to avoid.
		const event = writeEvent('/repo/src/f.ts', 'const doc = "call console.log(x) to debug";');

		await expect(manager.observeAst('s1', event, ctx)).resolves.toEqual([]);
	});

	it('applies the glob path gate', async () => {
		const manager = setup([makeAstRule({ globs: ['src/**/*.ts'] })]);
		const inScope = writeEvent('/repo/src/f.ts', 'console.log(1);');
		const outOfScope = writeEvent('/repo/scripts/f.ts', 'console.log(1);');

		await expect(manager.observeAst('s1', outOfScope, ctx)).resolves.toEqual([]);
		await expect(manager.observeAst('s1', inScope, ctx)).resolves.toHaveLength(1);
	});

	it('honors the agents gate', async () => {
		const manager = setup([makeAstRule({ agents: ['opencode'] })]);
		const event = writeEvent('/repo/src/f.ts', 'console.log(1);');

		await expect(manager.observeAst('s1', event, ctx)).resolves.toEqual([]);
	});

	it('skips a repeated identical snapshot', async () => {
		const manager = setup([makeAstRule({ repeatMode: 'after-gap', repeatGap: 0 })]);
		const event = writeEvent('/repo/src/f.ts', 'console.log(1);');

		await expect(manager.observeAst('s1', event, ctx)).resolves.toHaveLength(1);
		await expect(manager.observeAst('s1', event, ctx)).resolves.toEqual([]);
	});

	it('respects the once repeat policy', async () => {
		const manager = setup([makeAstRule({ repeatMode: 'once' })]);

		await expect(
			manager.observeAst('s1', writeEvent('/repo/a.ts', 'console.log(1);'), ctx)
		).resolves.toHaveLength(1);
		await expect(
			manager.observeAst('s1', writeEvent('/repo/b.ts', 'console.log(2);'), ctx)
		).resolves.toEqual([]);
	});

	it('is a no-op when TTSR is disabled', async () => {
		const manager = new TtsrManager({ getRules: () => [makeAstRule()], isEnabled: () => false });
		const event = writeEvent('/repo/src/f.ts', 'console.log(1);');

		await expect(manager.observeAst('s1', event, ctx)).resolves.toEqual([]);
	});

	describe('needsAstCheck', () => {
		it('is false without a tool payload', () => {
			const manager = setup([makeAstRule()]);
			expect(manager.needsAstCheck({ type: 'text', text: 'hello' }, ctx)).toBe(false);
		});

		it('is false when no rule declares an astCondition', () => {
			const manager = setup([makeAstRule({ astCondition: [] })]);
			expect(manager.needsAstCheck(writeEvent('/repo/a.ts', 'x'), ctx)).toBe(false);
		});

		it('is true for a tool event with an AST rule loaded', () => {
			const manager = setup([makeAstRule()]);
			expect(manager.needsAstCheck(writeEvent('/repo/a.ts', 'x'), ctx)).toBe(true);
		});
	});
});

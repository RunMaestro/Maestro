/**
 * Tests for the TTSR rule loader (Phase 1 verification).
 *
 * Covers:
 * - a valid `.maestro/rules/*.md` rule normalizing correctly (regex compiled,
 *   enums validated, `agents` defaulted from the Gate A capability matrix)
 * - invalid regexes dropped with a warning while siblings survive
 * - name-collision first-wins shadowing
 * - missing config -> `reason: 'missing'`, empty rule set, no throw
 * - malformed YAML -> `reason: 'unparseable'`
 *
 * Uses a real temp directory rather than an fs mock: the loader's whole job is
 * directory listing + read ordering, which a mock would have to re-implement.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	loadTtsrConfigDetailed,
	watchTtsrConfig,
} from '../../../main/ttsr/config/ttsr-config-loader';
import { TTSR_CONFIG_PATH, TTSR_RULES_DIR } from '../../../shared/maestro-paths';

let projectRoot: string;

function writeRule(filename: string, content: string): void {
	const dir = path.join(projectRoot, TTSR_RULES_DIR);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
}

function writeConfig(content: string): void {
	const filePath = path.join(projectRoot, TTSR_CONFIG_PATH);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, 'utf-8');
}

beforeEach(() => {
	projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ttsr-loader-'));
});

afterEach(() => {
	fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('loadTtsrConfigDetailed', () => {
	it('normalizes a valid rule file', () => {
		writeRule(
			'no-console-log.md',
			[
				'---',
				'description: Flag stray console.log in shipped source',
				'condition:',
				'  - "console\\\\.log\\\\("',
				'scope: [text, thinking]',
				'interruptMode: always',
				'repeatMode: after-gap',
				'repeatGap: 2',
				'---',
				'Do not leave `console.log` in shipped source.',
			].join('\n')
		);
		writeConfig('enabled: true\ncontextMode: keep\n');

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.ok).toBe(true);
		expect(result.warnings).toEqual([]);
		expect(result.rules).toHaveLength(1);

		const rule = result.rules[0];
		// Name falls back to the filename when frontmatter omits it.
		expect(rule.name).toBe('no-console-log');
		expect(rule.description).toBe('Flag stray console.log in shipped source');
		expect(rule.condition).toEqual(['console\\.log\\(']);
		expect(rule.compiledCondition).toHaveLength(1);
		expect(rule.compiledCondition[0].test('console.log(x)')).toBe(true);
		expect(rule.compiledCondition[0].test('logger.info(x)')).toBe(false);
		expect(rule.scope).toEqual(['text', 'thinking']);
		expect(rule.interruptMode).toBe('always');
		expect(rule.repeatMode).toBe('after-gap');
		expect(rule.repeatGap).toBe(2);
		expect(rule.content).toBe('Do not leave `console.log` in shipped source.');
		expect(rule.path).toBe(`${TTSR_RULES_DIR}/no-console-log.md`);

		// Gate A: a prose rule defaults onto every supported agent, and never
		// onto terminal (raw PTY only, out of scope for v1).
		expect(rule.agents).toContain('claude-code');
		expect(rule.agents).toContain('opencode');
		expect(rule.agents).toContain('grok');
		expect(rule.agents).not.toContain('terminal');

		expect(result.settings).toEqual({ enabled: true, disabledRules: [], contextMode: 'keep' });
	});

	it('defaults an astCondition rule onto only agents that surface edit content', () => {
		writeRule(
			'no-console-ast.md',
			[
				'---',
				'description: AST-flag console.log calls',
				'astCondition:',
				'  - "console.log($$$ARGS)"',
				'---',
				'Use the project logger.',
			].join('\n')
		);

		const rule = loadTtsrConfigDetailed(projectRoot).rules[0];

		// An ast-only rule is inherently tool-scoped.
		expect(rule.scope).toEqual(['tool:edit', 'tool:write']);
		expect(rule.agents).toContain('claude-code');
		expect(rule.agents).toContain('opencode');
		// No tool events / no edit content -> excluded per Gate A.
		expect(rule.agents).not.toContain('factory-droid');
		expect(rule.agents).not.toContain('grok');
	});

	it('drops an invalid regex with a warning and keeps its siblings', () => {
		writeRule(
			'mixed.md',
			[
				'---',
				'description: One good pattern, one broken one',
				'condition:',
				'  - "valid-pattern"',
				'  - "unclosed(group"',
				'---',
				'Fix it.',
			].join('\n')
		);

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.ok).toBe(true);
		expect(result.rules).toHaveLength(1);
		expect(result.rules[0].condition).toEqual(['valid-pattern']);
		expect(result.warnings.some((w) => w.includes('invalid regex "unclosed(group"'))).toBe(true);
	});

	it('drops a rule whose every regex is invalid', () => {
		writeRule(
			'all-bad.md',
			['---', 'description: Broken', 'condition: "unclosed(group"', '---', 'Body.'].join('\n')
		);

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.rules).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes('no usable condition'))).toBe(true);
	});

	// Rule regexes come from the opened repo and run on the main process's stdout
	// hot path, so a quantified group with an unbounded body - the classic
	// `(a+)+$` bomb - is refused at load time, exactly like an uncompilable one.
	it.each([
		['(a+)+$', 'quantified group over an unbounded body'],
		['(x*)+y', 'star inside a plus-quantified group'],
		['(\\d+){2,}', 'counted repetition of an unbounded group'],
		['((a+)b)*', 'nested one level deeper'],
		['(?:a+)*', 'non-capturing group is no safer'],
	])('drops the backtracking-prone pattern %s (%s)', (pattern) => {
		writeRule(
			'bomb.md',
			['---', 'description: Hostile pattern', `condition: '${pattern}'`, '---', 'Body.'].join('\n')
		);

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.rules).toHaveLength(0);
		expect(result.warnings.join('\n')).toContain('nested quantifier');
	});

	it.each([
		'console\\.log\\(',
		'(TODO|FIXME):',
		'\\s+$',
		'(foo)?bar',
		'a{2,4}',
		'(x+)?',
		'[a+*]+',
		'\\(a+\\)+',
	])('accepts the ordinary pattern %s', (pattern) => {
		writeRule(
			'ok.md',
			['---', 'description: Ordinary pattern', `condition: '${pattern}'`, '---', 'Body.'].join('\n')
		);

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.rules).toHaveLength(1);
		expect(result.rules[0].condition).toEqual([pattern]);
		expect(result.warnings).toEqual([]);
	});

	it('drops only the unsafe pattern and keeps its siblings', () => {
		writeRule(
			'mixed-safety.md',
			[
				'---',
				'description: One safe pattern, one bomb',
				'condition:',
				"  - 'console\\.log\\('",
				"  - '(a+)+$'",
				'---',
				'Fix it.',
			].join('\n')
		);

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.rules).toHaveLength(1);
		expect(result.rules[0].condition).toEqual(['console\\.log\\(']);
		expect(result.warnings.join('\n')).toContain('nested quantifier');
	});

	it('shadows a name collision, first file wins', () => {
		const body = (marker: string) =>
			[
				'---',
				'name: duplicate-rule',
				`description: ${marker}`,
				'condition: "anything"',
				'---',
				`Body ${marker}.`,
			].join('\n');
		// Sorted filename order decides which one is "first".
		writeRule('a-first.md', body('first'));
		writeRule('b-second.md', body('second'));

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.rules).toHaveLength(1);
		expect(result.rules[0].description).toBe('first');
		expect(result.rules[0].path).toBe(`${TTSR_RULES_DIR}/a-first.md`);
		expect(
			result.warnings.some(
				(w) => w.includes('b-second.md') && w.includes('already defined') && w.includes('shadowed')
			)
		).toBe(true);
	});

	it('validates enums and falls back with a warning', () => {
		writeRule(
			'bad-enums.md',
			[
				'---',
				'description: Bogus enum values',
				'condition: "anything"',
				'interruptMode: sometimes',
				'repeatMode: forever',
				'repeatGap: 0',
				'scope: [text, telepathy]',
				'---',
				'Body.',
			].join('\n')
		);

		const rule = loadTtsrConfigDetailed(projectRoot).rules[0];

		expect(rule.interruptMode).toBe('always');
		expect(rule.repeatMode).toBe('after-gap');
		expect(rule.repeatGap).toBe(3);
		expect(rule.scope).toEqual(['text']);
	});

	it('drops an explicitly listed agent that cannot evaluate the rule', () => {
		writeRule(
			'ast-on-droid.md',
			[
				'---',
				'description: AST rule pointed at an agent with no tool events',
				'astCondition: "console.log($$$ARGS)"',
				'agents: [claude-code, factory-droid, not-a-real-agent]',
				'---',
				'Body.',
			].join('\n')
		);

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.rules[0].agents).toEqual(['claude-code']);
		expect(result.warnings.some((w) => w.includes('agent "factory-droid" dropped'))).toBe(true);
		expect(result.warnings.some((w) => w.includes('unknown agent "not-a-real-agent"'))).toBe(true);
	});

	it('drops agents that do not report their shell commands from a tool:bash rule', () => {
		writeRule(
			'no-force-push.md',
			[
				'---',
				'description: Never force-push',
				'condition: "git push .*--force"',
				'scope: [tool:bash]',
				'---',
				'Never force-push a shared branch.',
			].join('\n')
		);

		const rule = loadTtsrConfigDetailed(projectRoot).rules[0];

		// factory-droid and grok emit no tool events at all, so a command rule can
		// never fire for them - it must not silently default onto them.
		expect(rule.agents).toEqual(['claude-code', 'codex', 'opencode', 'copilot-cli']);
	});

	it('explains why a listed agent cannot evaluate a tool:bash rule', () => {
		writeRule(
			'no-rm-rf.md',
			[
				'---',
				'description: Never rm -rf',
				'condition: "rm -rf"',
				'scope: [tool:bash]',
				'agents: [claude-code, grok]',
				'---',
				'Body.',
			].join('\n')
		);

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.rules[0].agents).toEqual(['claude-code']);
		expect(result.warnings.join('\n')).toContain('does not report the shell commands it runs');
	});

	it('warns that globs are ignored on a rule with no file-bearing scope', () => {
		writeRule(
			'globbed-bash.md',
			[
				'---',
				'description: Command rule that also declares globs',
				'condition: "rm -rf"',
				'scope: [tool:bash]',
				'globs: ["src/**/*.ts"]',
				'---',
				'Body.',
			].join('\n')
		);

		const result = loadTtsrConfigDetailed(projectRoot);

		// The rule still works; the contradiction is surfaced rather than silently
		// making it never match.
		expect(result.rules[0].globs).toEqual(['src/**/*.ts']);
		expect(result.warnings.join('\n')).toContain('only narrows tool:edit / tool:write');
	});

	it('excludes rules listed in disabledRules', () => {
		writeRule(
			'keep-me.md',
			['---', 'description: Kept', 'condition: "a"', '---', 'Body.'].join('\n')
		);
		writeRule(
			'drop-me.md',
			['---', 'description: Dropped', 'condition: "b"', '---', 'Body.'].join('\n')
		);
		writeConfig('disabledRules:\n  - drop-me\n');

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.rules.map((r) => r.name)).toEqual(['keep-me']);
		expect(result.settings.disabledRules).toEqual(['drop-me']);
	});

	it('reports missing when the project has no config and no rules', () => {
		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('missing');
		expect(result.rules).toEqual([]);
		expect(result.settings).toEqual({ enabled: true, disabledRules: [] });
	});

	it('loads rules when ttsr.yaml is absent', () => {
		writeRule(
			'solo.md',
			['---', 'description: No yaml needed', 'condition: "x"', '---', 'Body.'].join('\n')
		);

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.ok).toBe(true);
		expect(result.rules).toHaveLength(1);
		// Left unset so the global `ttsrContextMode` setting decides; defaulting it
		// here would make every project silently override the user's choice.
		expect(result.settings.contextMode).toBeUndefined();
	});

	it('reports the contextMode a project does declare', () => {
		writeConfig('contextMode: discard\n');

		expect(loadTtsrConfigDetailed(projectRoot).settings.contextMode).toBe('discard');
	});

	it('falls back to keep for an invalid contextMode rather than deferring globally', () => {
		writeConfig('contextMode: nonsense\n');

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.settings.contextMode).toBe('keep');
		expect(result.warnings.join('\n')).toContain('contextMode');
	});

	it('reports unparseable on malformed YAML', () => {
		writeConfig('enabled: true\n  bad indent: [\n');

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('unparseable');
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.rules).toEqual([]);
	});

	it('reports invalid when the config root is not a mapping', () => {
		writeConfig('- just\n- a list\n');

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.ok).toBe(false);
		expect(result.reason).toBe('invalid');
		expect(result.errors[0]).toContain('must be a YAML mapping');
	});

	// Regression: the watcher used to be handed `.maestro/ttsr.yaml` as a watch
	// target directly, and chokidar 3 watches nothing at all when a listed path
	// inside a dot-directory does not exist yet - one missing path poisons its
	// siblings. A project with rules but no ttsr.yaml (a valid setup, and the
	// common one) therefore never saw a single rule edit.
	it('fires for a rule edit in a project that has no ttsr.yaml', async () => {
		writeRule(
			'watched.md',
			['---', 'description: Watched', 'condition: "x"', '---', 'Body.'].join('\n')
		);

		const onChange = vi.fn();
		let cleanup!: () => void;
		await new Promise<void>((resolve) => {
			cleanup = watchTtsrConfig(projectRoot, onChange, { onReady: resolve });
		});

		try {
			writeRule(
				'watched.md',
				['---', 'description: Watched', 'condition: "x"', '---', 'Edited body.'].join('\n')
			);
			await new Promise((resolve) => setTimeout(resolve, 1500));

			expect(onChange).toHaveBeenCalledTimes(1);
		} finally {
			cleanup();
		}
	}, 15_000);

	// Regression: the `.maestro` anchor itself is the same trap one level up.
	// Chokidar cannot watch a directory that does not exist when the watcher is
	// created, and the runtime arms one watcher per project and never re-arms
	// it. In a fresh repo (no `.maestro` at all - exactly the project whose
	// first rule an agent is about to author with its own file tools), the
	// watcher was born dead and the rule stayed invisible until app restart.
	it('fires for the first rule authored in a project with no .maestro directory', async () => {
		expect(fs.existsSync(path.join(projectRoot, '.maestro'))).toBe(false);

		const onChange = vi.fn();
		let cleanup!: () => void;
		await new Promise<void>((resolve) => {
			cleanup = watchTtsrConfig(projectRoot, onChange, { onReady: resolve });
		});

		try {
			writeRule(
				'first.md',
				['---', 'description: First', 'condition: "x"', '---', 'Body.'].join('\n')
			);
			await new Promise((resolve) => setTimeout(resolve, 1500));

			expect(onChange).toHaveBeenCalled();
		} finally {
			cleanup();
		}
	}, 15_000);

	// An agent authoring a rule writes the file several times in a second (draft,
	// fix the regex, fix the body), and each write is its own chokidar event.
	// The debounce is what keeps a half-written intermediate state from becoming
	// the live rule set: the reload reads the directory once, after the burst.
	it('coalesces a burst of rule-file writes into one reload of the final rule set', async () => {
		// The rule directory exists before the watcher starts, which is the shape
		// production always has: the watcher is installed when a project's rules
		// are first loaded.
		writeRule(
			'churn.md',
			['---', 'description: draft', 'condition: "x"', '---', 'Body draft.'].join('\n')
		);

		const onChange = vi.fn();
		let cleanup!: () => void;
		await new Promise<void>((resolve) => {
			cleanup = watchTtsrConfig(projectRoot, onChange, { onReady: resolve });
		});

		try {
			for (const marker of ['first', 'second', 'third']) {
				writeRule(
					'churn.md',
					['---', `description: ${marker}`, 'condition: "x"', '---', `Body ${marker}.`].join('\n')
				);
			}
			// A second file lands mid-burst, and the config file changes too.
			writeRule(
				'extra.md',
				['---', 'description: Extra', 'condition: "y"', '---', 'Extra body.'].join('\n')
			);
			writeConfig('enabled: true\n');

			// Past the 1s debounce window.
			await new Promise((resolve) => setTimeout(resolve, 1500));

			expect(onChange).toHaveBeenCalledTimes(1);

			const result = loadTtsrConfigDetailed(projectRoot);
			expect(result.rules.map((rule) => rule.name).sort()).toEqual(['churn', 'extra']);
			// The final write wins, and no intermediate version survives as a
			// duplicate: rules are keyed by name, read fresh from disk.
			expect(result.rules.find((rule) => rule.name === 'churn')?.content).toBe('Body third.');
			expect(result.warnings).toEqual([]);
		} finally {
			cleanup();
		}
	}, 15_000);

	it('skips a rule with no frontmatter and one with an empty body', () => {
		writeRule('no-frontmatter.md', 'Just a markdown file, no rule here.');
		writeRule(
			'empty-body.md',
			['---', 'description: Nothing to inject', 'condition: "x"', '---', ''].join('\n')
		);

		const result = loadTtsrConfigDetailed(projectRoot);

		expect(result.rules).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes('missing YAML frontmatter'))).toBe(true);
		expect(result.warnings.some((w) => w.includes('empty body'))).toBe(true);
	});
});

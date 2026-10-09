/**
 * @file producers.test.ts
 * @description Behavioral tests for the F2 AgentRun rich-field producers: the
 * pure mappers recordCheck (upsert-by-name, immutable) and ingestReviewFindings
 * (raw -> open finding, message-less dropped), plus the composed buildEnrichHook
 * driven through its injectable GitRunner/GhRunner/UsageSource boundaries so no
 * real git or gh is ever spawned.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	buildEnrichHook,
	ingestReviewFindings,
	recordCheck,
	touchedFilesFromGit,
	type GhRunner,
	type GitRunner,
	type RawReviewFinding,
} from '../../../main/agent-run/producers';
import type { AgentRun, AgentRunCheck } from '../../../shared/agent-run';
import type { ExecResult } from '../../../main/utils/execFile';

function run(overrides: Partial<AgentRun> = {}): AgentRun {
	return {
		id: 'run-1',
		createdAt: 100,
		updatedAt: 100,
		provider: 'claude-code',
		status: 'running',
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews: [],
		...overrides,
	};
}

function check(overrides: Partial<AgentRunCheck> = {}): AgentRunCheck {
	return {
		name: 'lint',
		status: 'passed',
		...overrides,
	};
}

const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', exitCode: 0 });
const gitFail = (): ExecResult => ({
	stdout: '',
	stderr: 'fatal: not a git repository',
	exitCode: 128,
});

// ---------------------------------------------------------------------------
// recordCheck - pure upsert-by-name (ISC-2.4)
// ---------------------------------------------------------------------------

describe('recordCheck', () => {
	it('appends a check with a new name, preserving existing checks in order', () => {
		const r = run({ checks: [check({ name: 'lint', status: 'passed' })] });
		const next = recordCheck(r, check({ name: 'typecheck', status: 'running' }));
		expect(next.map((c) => c.name)).toEqual(['lint', 'typecheck']);
		expect(next[1]).toEqual({ name: 'typecheck', status: 'running' });
	});

	it('appends to a run with no prior checks', () => {
		const r = run({ checks: [] });
		const next = recordCheck(r, check({ name: 'test', status: 'passed' }));
		expect(next).toEqual([{ name: 'test', status: 'passed' }]);
	});

	it('replaces a same-named check in place rather than duplicating', () => {
		const r = run({
			checks: [
				check({ name: 'lint', status: 'running' }),
				check({ name: 'typecheck', status: 'passed' }),
			],
		});
		const next = recordCheck(r, check({ name: 'lint', status: 'failed', summary: 'rerun' }));
		// Same length: replaced, not appended.
		expect(next).toHaveLength(2);
		// Replaced in place at index 0 (order preserved); the new value wins.
		expect(next[0]).toEqual({ name: 'lint', status: 'failed', summary: 'rerun' });
		expect(next[1]).toEqual({ name: 'typecheck', status: 'passed' });
	});

	it('does not mutate the input run.checks array (immutable)', () => {
		const original = [check({ name: 'lint', status: 'running' })];
		const r = run({ checks: original });
		const next = recordCheck(r, check({ name: 'lint', status: 'passed' }));
		// A fresh array is returned; the original is untouched.
		expect(next).not.toBe(original);
		expect(original).toEqual([{ name: 'lint', status: 'running' }]);
	});

	it('treats an undefined checks list as empty', () => {
		const r = run();
		// Force the undefined-checks branch that the store may hand us.
		const bare: AgentRun = { ...r, checks: undefined as unknown as AgentRunCheck[] };
		const next = recordCheck(bare, check({ name: 'lint', status: 'passed' }));
		expect(next).toEqual([{ name: 'lint', status: 'passed' }]);
	});
});

// ---------------------------------------------------------------------------
// ingestReviewFindings - pure raw -> finding mapper (ISC-2.5)
// ---------------------------------------------------------------------------

describe('ingestReviewFindings', () => {
	it('maps a raw finding to an open finding, preserving severity/category/message', () => {
		const raw: RawReviewFinding = {
			severity: 'high',
			category: 'security',
			message: 'hardcoded secret',
			file: 'src/auth.ts',
			line: 42,
		};
		const [finding] = ingestReviewFindings(run(), [raw]);
		expect(finding).toEqual({
			severity: 'high',
			category: 'security',
			message: 'hardcoded secret',
			status: 'open',
			file: 'src/auth.ts',
			line: 42,
		});
	});

	it('drops findings with no usable message but keeps the ones that have one', () => {
		const raws: RawReviewFinding[] = [
			{ severity: 'high', category: 'security' }, // no message -> dropped
			{ severity: 'low', category: 'style', message: 'unused import' }, // kept
			{ severity: 'medium', category: 'perf', message: '   ' }, // whitespace-only -> dropped
		];
		const findings = ingestReviewFindings(run(), raws);
		expect(findings).toHaveLength(1);
		expect(findings[0].message).toBe('unused import');
	});

	it('appends mapped findings to the run existing reviews without mutating them', () => {
		const existing = [
			{ severity: 'info' as const, category: 'general', message: 'prior', status: 'open' as const },
		];
		const r = run({ reviews: existing });
		const findings = ingestReviewFindings(r, [{ message: 'new one' }]);
		expect(findings).toHaveLength(2);
		expect(findings[0]).toEqual(existing[0]);
		expect(findings[1].message).toBe('new one');
		// Original reviews array is untouched.
		expect(r.reviews).toHaveLength(1);
		expect(r.reviews).toBe(existing);
	});

	it('normalizes alias fields (description/type/path) onto the canonical shape', () => {
		const raw: RawReviewFinding = {
			description: 'from description alias',
			type: 'bug',
			path: 'src/x.ts',
			suggestion: 'do the thing',
			confidence: 0.9,
		};
		const [finding] = ingestReviewFindings(run(), [raw]);
		expect(finding.message).toBe('from description alias');
		expect(finding.category).toBe('bug');
		expect(finding.file).toBe('src/x.ts');
		expect(finding.suggestedFix).toBe('do the thing');
		expect(finding.confidence).toBe(0.9);
	});

	it('coerces an unknown severity to info and a missing category to general', () => {
		const [finding] = ingestReviewFindings(run(), [{ severity: 'catastrophic', message: 'boom' }]);
		expect(finding.severity).toBe('info');
		expect(finding.category).toBe('general');
	});

	it('accepts a known severity case-insensitively', () => {
		const [finding] = ingestReviewFindings(run(), [{ severity: 'CRITICAL', message: 'boom' }]);
		expect(finding.severity).toBe('critical');
	});
});

// ---------------------------------------------------------------------------
// touchedFilesFromGit - injectable git boundary (ISC-2.1 / ISC-2.2)
// ---------------------------------------------------------------------------

describe('touchedFilesFromGit', () => {
	it('unions working-tree, staged, and branch diffs into a sorted, de-duplicated list', async () => {
		const runGit: GitRunner = vi.fn(async (_cwd, args) => {
			const key = args.join(' ');
			if (key === 'diff --name-only') return ok('src/b.ts\nsrc/a.ts\n');
			if (key === 'diff --name-only --cached') return ok('src/a.ts\n'); // duplicate
			if (key === 'diff --name-only main...HEAD') return ok('README.md\nsrc/c.ts\n');
			return gitFail();
		});
		const files = await touchedFilesFromGit('/wt', 'main', runGit);
		expect(files).toEqual(['README.md', 'src/a.ts', 'src/b.ts', 'src/c.ts']);
	});

	it('skips the branch diff when no baseBranch is given', async () => {
		const seen: string[] = [];
		const runGit: GitRunner = vi.fn(async (_cwd, args) => {
			seen.push(args.join(' '));
			return ok('src/a.ts\n');
		});
		await touchedFilesFromGit('/wt', undefined, runGit);
		expect(seen).toEqual(['diff --name-only', 'diff --name-only --cached']);
	});

	it('returns [] for an empty cwd without invoking git', async () => {
		const runGit: GitRunner = vi.fn(async () => ok('src/a.ts\n'));
		const files = await touchedFilesFromGit('', 'main', runGit);
		expect(files).toEqual([]);
		expect(runGit).not.toHaveBeenCalled();
	});

	it('contributes nothing from a non-zero-exit diff (not a repo), never throwing', async () => {
		const runGit: GitRunner = vi.fn(async () => gitFail());
		await expect(touchedFilesFromGit('/wt', 'main', runGit)).resolves.toEqual([]);
	});

	it('returns [] when the runner throws (defensive: producer never throws)', async () => {
		const runGit: GitRunner = vi.fn(async () => {
			throw new Error('runner blew up');
		});
		await expect(touchedFilesFromGit('/wt', 'main', runGit)).resolves.toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// buildEnrichHook - composed hook over injected boundaries
// ---------------------------------------------------------------------------

describe('buildEnrichHook', () => {
	it('assembles touchedFiles from the injected git runner', async () => {
		const runGit: GitRunner = vi.fn(async (_cwd, args) => {
			const key = args.join(' ');
			if (key === 'diff --name-only') return ok('src/a.ts\n');
			if (key === 'diff --name-only --cached') return ok('');
			if (key === 'diff --name-only main...HEAD') return ok('src/b.ts\n');
			return gitFail();
		});
		const hook = buildEnrichHook({ runGit });
		const enrichment = await hook(run({ worktreePath: '/wt', baseBranch: 'main' }), 0);
		expect(enrichment.touchedFiles).toEqual(['src/a.ts', 'src/b.ts']);
		expect(runGit).toHaveBeenCalledWith('/wt', ['diff', '--name-only']);
	});

	it('never throws and yields touchedFiles [] when the git runner throws', async () => {
		const runGit: GitRunner = vi.fn(async () => {
			throw new Error('git exploded');
		});
		const log = vi.fn();
		const hook = buildEnrichHook({ runGit, log });
		const enrichment = await hook(run({ worktreePath: '/wt', baseBranch: 'main' }), 0);
		expect(enrichment.touchedFiles).toEqual([]);
	});

	it('isolates a failing git producer from usage and pullRequest producers', async () => {
		// Git throws; usage + PR still succeed, proving each producer is isolated.
		const runGit: GitRunner = vi.fn(async () => {
			throw new Error('git down');
		});
		const gh: GhRunner = {
			resolveGhPath: vi.fn(async () => '/usr/bin/gh'),
			execFile: vi.fn(async () =>
				ok(
					JSON.stringify({
						number: 7,
						url: 'https://example.test/pr/7',
						state: 'OPEN',
						mergeable: 'MERGEABLE',
						headRefName: 'feature',
						baseRefName: 'main',
					})
				)
			),
		};
		const hook = buildEnrichHook({
			runGit,
			gh,
			usageSource: async () => ({ inputTokens: 10, outputTokens: 5 }),
		});
		const enrichment = await hook(
			run({ worktreePath: '/wt', branch: 'feature', baseBranch: 'main' }),
			0
		);
		expect(enrichment.touchedFiles).toEqual([]);
		expect(enrichment.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
		expect(enrichment.pullRequest).toEqual({
			number: 7,
			url: 'https://example.test/pr/7',
			state: 'open',
			mergeable: true,
			headBranch: 'feature',
			baseBranch: 'main',
		});
	});

	it('does not look up a pull request when the run has no branch', async () => {
		const gh: GhRunner = {
			resolveGhPath: vi.fn(async () => '/usr/bin/gh'),
			execFile: vi.fn(async () => ok('{}')),
		};
		const hook = buildEnrichHook({ runGit: vi.fn(async () => ok('')), gh });
		const enrichment = await hook(run({ worktreePath: '/wt' }), 0);
		expect(enrichment.pullRequest).toBeUndefined();
		expect(gh.execFile).not.toHaveBeenCalled();
	});

	it('leaves usage undefined when no source is wired and the run carries none', async () => {
		const hook = buildEnrichHook({ runGit: vi.fn(async () => ok('')) });
		const enrichment = await hook(run({ worktreePath: '/wt' }), 0);
		expect(enrichment.usage).toBeUndefined();
	});
});

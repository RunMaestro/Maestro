/**
 * Tests for renaming a Cue pipeline in place.
 *
 * Runs against real temp project roots so the YAML round-trip is asserted on
 * disk rather than against a mocked writer - the whole risk of this operation
 * is what it does to a file someone else's automation reads.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import {
	renamePipelineCommentHeader,
	renamePipelineOnDisk,
	validatePipelineName,
	MAX_PIPELINE_NAME_LENGTH,
} from '../../../main/cue/cue-pipeline-rename';

// The layout store writes to the app's userData dir; this suite is about the
// YAML, so stub it out and assert the re-key separately.
const layoutState = vi.hoisted(() => ({
	value: null as { pipelines: Array<{ id: string; name: string }> } | null,
	saved: null as { pipelines: Array<{ id: string; name: string }> } | null,
	throwOnSave: false,
}));
vi.mock('../../../main/cue/pipeline-layout-store', () => ({
	loadPipelineLayout: () => layoutState.value,
	savePipelineLayout: (next: { pipelines: Array<{ id: string; name: string }> }) => {
		if (layoutState.throwOnSave) throw new Error('disk full');
		layoutState.saved = next;
	},
}));

function writeConfig(projectRoot: string, contents: string): string {
	const dir = path.join(projectRoot, '.maestro');
	fs.mkdirSync(dir, { recursive: true });
	const filePath = path.join(dir, 'cue.yaml');
	fs.writeFileSync(filePath, contents, 'utf-8');
	return filePath;
}

function readSubs(projectRoot: string): Record<string, unknown>[] {
	const filePath = path.join(projectRoot, '.maestro', 'cue.yaml');
	const parsed = yaml.load(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
	return (parsed.subscriptions ?? []) as Record<string, unknown>[];
}

function readRaw(projectRoot: string): string {
	return fs.readFileSync(path.join(projectRoot, '.maestro', 'cue.yaml'), 'utf-8');
}

describe('cue-pipeline-rename', () => {
	const roots: string[] = [];

	function makeRoot(): string {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cue-rename-'));
		roots.push(root);
		return root;
	}

	beforeEach(() => {
		layoutState.value = null;
		layoutState.saved = null;
		layoutState.throwOnSave = false;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		while (roots.length > 0) {
			const root = roots.pop()!;
			if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
		}
	});

	describe('validatePipelineName', () => {
		it('accepts an ordinary name', () => {
			expect(validatePipelineName('ODIN Weekly')).toEqual({ ok: true });
		});

		it('rejects an empty or whitespace-only name', () => {
			expect(validatePipelineName('')).toMatchObject({ ok: false });
			expect(validatePipelineName('   ')).toMatchObject({ ok: false });
		});

		// `::` is the separator in the remote subscription id, so a name holding
		// one produces ids that cannot be parsed back apart.
		it('rejects "::"', () => {
			expect(validatePipelineName('a::b')).toMatchObject({ ok: false });
		});

		it('rejects a line break, which would corrupt the comment header', () => {
			expect(validatePipelineName('two\nlines')).toMatchObject({ ok: false });
		});

		it('rejects a name past the length cap', () => {
			expect(validatePipelineName('x'.repeat(MAX_PIPELINE_NAME_LENGTH))).toEqual({ ok: true });
			expect(validatePipelineName('x'.repeat(MAX_PIPELINE_NAME_LENGTH + 1))).toMatchObject({
				ok: false,
			});
		});
	});

	describe('renamePipelineOnDisk', () => {
		it('rewrites pipeline_name on every member', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [
						{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old', prompt: 'a' },
						{ name: 'Old-chain-2', event: 'agent.completed', pipeline_name: 'Old', prompt: 'b' },
					],
				})
			);

			const result = renamePipelineOnDisk([root], 'Old', 'New');

			expect(result.renamed).toBe(true);
			expect(result.subscriptionsUpdated).toBe(2);
			expect(readSubs(root).map((s) => s.pipeline_name)).toEqual(['New', 'New']);
		});

		// Subscription names are stable identities - the layout store keys trigger
		// positions by them and `source_sub` points at them. Renaming them here
		// would strand both, which is exactly the bug this guards.
		it('leaves subscription names and their cross-references untouched', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [
						{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old', prompt: 'a' },
						{
							name: 'Old-chain-2',
							event: 'agent.completed',
							pipeline_name: 'Old',
							source_sub: 'Old',
							prompt: 'b',
						},
					],
				})
			);

			renamePipelineOnDisk([root], 'Old', 'New');

			const subs = readSubs(root);
			expect(subs.map((s) => s.name)).toEqual(['Old', 'Old-chain-2']);
			expect(subs[1].source_sub).toBe('Old');
		});

		it('preserves fields it has no business touching', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					settings: { max_concurrent: 3 },
					subscriptions: [
						{
							name: 'Old',
							event: 'time.scheduled',
							pipeline_name: 'Old',
							pipeline_color: '#06b6d4',
							schedule_times: ['09:00'],
							prompt: 'do the thing',
							enabled: false,
						},
					],
				})
			);

			renamePipelineOnDisk([root], 'Old', 'New');

			const parsed = yaml.load(readRaw(root)) as Record<string, unknown>;
			expect(parsed.settings).toEqual({ max_concurrent: 3 });
			expect(readSubs(root)[0]).toMatchObject({
				name: 'Old',
				pipeline_color: '#06b6d4',
				schedule_times: ['09:00'],
				prompt: 'do the thing',
				enabled: false,
			});
		});

		// A cross-agent pipeline is physically N files; renaming only the root you
		// happened to click would split it in half.
		it('rewrites every root the pipeline spans', () => {
			const rootA = makeRoot();
			const rootB = makeRoot();
			for (const root of [rootA, rootB]) {
				writeConfig(
					root,
					yaml.dump({
						subscriptions: [
							{ name: `sub-${root}`, event: 'time.scheduled', pipeline_name: 'Old', prompt: 'a' },
						],
					})
				);
			}

			const result = renamePipelineOnDisk([rootA, rootB], 'Old', 'New');

			expect(result.subscriptionsUpdated).toBe(2);
			expect(result.filesWritten).toHaveLength(2);
			expect(readSubs(rootA)[0].pipeline_name).toBe('New');
			expect(readSubs(rootB)[0].pipeline_name).toBe('New');
		});

		it('leaves other pipelines in the same file alone', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [
						{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old', prompt: 'a' },
						{ name: 'Other', event: 'time.scheduled', pipeline_name: 'Other', prompt: 'b' },
					],
				})
			);

			renamePipelineOnDisk([root], 'Old', 'New');

			expect(readSubs(root).map((s) => s.pipeline_name)).toEqual(['New', 'Other']);
		});

		// Legacy YAML groups by the `-chain-N` suffix convention when no
		// `pipeline_name` is present. Renaming has to find those members AND stamp
		// the field, or they would be orphaned the moment the name stops matching.
		it('finds legacy members grouped only by name suffix, and stamps the field', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [
						{ name: 'Old', event: 'time.scheduled', prompt: 'a' },
						{ name: 'Old-chain-2', event: 'agent.completed', prompt: 'b' },
						{ name: 'Old-fanin', event: 'agent.completed', prompt: 'c' },
					],
				})
			);

			const result = renamePipelineOnDisk([root], 'Old', 'New');

			expect(result.subscriptionsUpdated).toBe(3);
			expect(readSubs(root).map((s) => s.pipeline_name)).toEqual(['New', 'New', 'New']);
			// Names still unchanged, so the suffix no longer matches - which is
			// precisely why the field had to be written.
			expect(readSubs(root).map((s) => s.name)).toEqual(['Old', 'Old-chain-2', 'Old-fanin']);
		});

		it('does not rewrite a file that holds no member of the pipeline', () => {
			const root = makeRoot();
			const filePath = writeConfig(
				root,
				yaml.dump({
					subscriptions: [
						{ name: 'Other', event: 'time.scheduled', pipeline_name: 'Other', prompt: 'b' },
					],
				})
			);
			const before = fs.readFileSync(filePath, 'utf-8');

			const result = renamePipelineOnDisk([root], 'Old', 'New');

			expect(result.renamed).toBe(false);
			expect(result.filesWritten).toEqual([]);
			expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
		});

		it('reports a miss rather than claiming success', () => {
			const root = makeRoot();
			writeConfig(root, yaml.dump({ subscriptions: [] }));

			const result = renamePipelineOnDisk([root], 'Nope', 'New');

			expect(result.renamed).toBe(false);
			expect(result.reason).toContain('no subscriptions found');
		});

		it('refuses an invalid name before touching anything', () => {
			const root = makeRoot();
			const filePath = writeConfig(
				root,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);
			const before = fs.readFileSync(filePath, 'utf-8');

			const result = renamePipelineOnDisk([root], 'Old', '   ');

			expect(result.renamed).toBe(false);
			expect(fs.readFileSync(filePath, 'utf-8')).toBe(before);
		});

		it('treats an unchanged name as a no-op, not an error state', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);

			const result = renamePipelineOnDisk([root], 'Old', 'Old');

			expect(result.renamed).toBe(false);
			expect(result.reason).toBe('the name is unchanged');
		});

		it('trims the new name', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);

			renamePipelineOnDisk([root], 'Old', '  New  ');

			expect(readSubs(root)[0].pipeline_name).toBe('New');
		});

		// Two agents can share one project root; counting the file twice would
		// report a subscription count the user cannot reconcile with their YAML.
		it('does not double-count a root passed twice', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);

			const result = renamePipelineOnDisk([root, root], 'Old', 'New');

			expect(result.subscriptionsUpdated).toBe(1);
			expect(result.filesWritten).toHaveLength(1);
		});

		it('warns and keeps going when one root is unparseable', () => {
			const bad = makeRoot();
			const good = makeRoot();
			writeConfig(bad, 'subscriptions: [oops\n  bad: : yaml');
			writeConfig(
				good,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);

			const result = renamePipelineOnDisk([bad, good], 'Old', 'New');

			expect(result.renamed).toBe(true);
			expect(result.warnings.some((w) => w.includes('could not parse'))).toBe(true);
			expect(readSubs(good)[0].pipeline_name).toBe('New');
		});

		it('skips a root with no cue.yaml without warning about it', () => {
			const empty = makeRoot();
			const good = makeRoot();
			writeConfig(
				good,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);

			const result = renamePipelineOnDisk([empty, good], 'Old', 'New');

			expect(result.renamed).toBe(true);
			expect(result.warnings).toEqual([]);
		});

		it('preserves the leading comment header', () => {
			const root = makeRoot();
			writeConfig(
				root,
				`# Maestro Cue config\n# Pipeline: Old (color: #06b6d4)\n\n${yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})}`
			);

			renamePipelineOnDisk([root], 'Old', 'New');

			const raw = readRaw(root);
			expect(raw).toContain('# Maestro Cue config');
			// The header names the pipeline, so it has to move with the rename.
			expect(raw).toContain('# Pipeline: New (color: #06b6d4)');
			expect(raw).not.toContain('# Pipeline: Old');
		});

		// The visual pipeline id is derived from the name, so without the re-key
		// the renamed pipeline reloads with no remembered node positions and the
		// old entry lingers as an orphan.
		it('re-keys the saved layout entry', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);
			layoutState.value = {
				pipelines: [
					{ id: 'pipeline-Old', name: 'Old' },
					{ id: 'pipeline-Other', name: 'Other' },
				],
			};

			renamePipelineOnDisk([root], 'Old', 'New');

			expect(layoutState.saved?.pipelines).toEqual([
				{ id: 'pipeline-New', name: 'New' },
				{ id: 'pipeline-Other', name: 'Other' },
			]);
		});

		// The YAML rename has already landed by then, so a layout failure is a
		// warning about lost node positions - not a failed rename.
		it('still reports success when the layout re-key fails', () => {
			const root = makeRoot();
			writeConfig(
				root,
				yaml.dump({
					subscriptions: [{ name: 'Old', event: 'time.scheduled', pipeline_name: 'Old' }],
				})
			);
			layoutState.value = { pipelines: [{ id: 'pipeline-Old', name: 'Old' }] };
			layoutState.throwOnSave = true;

			const result = renamePipelineOnDisk([root], 'Old', 'New');

			expect(result.renamed).toBe(true);
			expect(result.warnings.some((w) => w.includes('node positions'))).toBe(true);
			expect(readSubs(root)[0].pipeline_name).toBe('New');
		});
	});

	describe('renamePipelineCommentHeader', () => {
		it('rewrites an exact match and keeps the color suffix', () => {
			expect(renamePipelineCommentHeader('# Pipeline: Old (color: #06b6d4)\n', 'Old', 'New')).toBe(
				'# Pipeline: New (color: #06b6d4)\n'
			);
		});

		it('rewrites a header with no color suffix', () => {
			expect(renamePipelineCommentHeader('# Pipeline: Old\n', 'Old', 'New')).toBe(
				'# Pipeline: New\n'
			);
		});

		// A comment that merely mentions the word is not a declaration of it.
		it('leaves a different pipeline and prose mentions alone', () => {
			const header = '# Pipeline: Other\n# Old is mentioned here\n';
			expect(renamePipelineCommentHeader(header, 'Old', 'New')).toBe(header);
		});

		it('is a no-op on an empty header', () => {
			expect(renamePipelineCommentHeader('', 'Old', 'New')).toBe('');
		});
	});
});

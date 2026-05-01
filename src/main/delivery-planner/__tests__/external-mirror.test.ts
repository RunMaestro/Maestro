import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkItem } from '../../../shared/work-graph-types';
import { importExternalMirror, writeExternalMirror } from '../external-mirror';
import { markdownMirrorHash } from '../frontmatter';
import { resolveExternalMirrorPaths, slugifyMirrorSegment } from '../path-resolver';

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('External mirror (renamed from ccpm-mirror)', () => {
	it('resolves project-local external mirror artifact paths', async () => {
		const projectPath = await makeTempProject();
		const paths = resolveExternalMirrorPaths(projectPath, 'Delivery Planner');

		expect(paths.prdFile).toBe(
			path.join(projectPath, '.maestro', 'external-mirror', 'prds', 'delivery-planner.md')
		);
		expect(paths.epicFile).toBe(
			path.join(projectPath, '.maestro', 'external-mirror', 'epics', 'delivery-planner', 'epic.md')
		);
		expect(paths.tasksDir).toBe(
			path.join(projectPath, '.maestro', 'external-mirror', 'epics', 'delivery-planner', 'tasks')
		);
	});

	it('writes external mirror markdown with frontmatter and imports it back', async () => {
		const projectPath = await makeTempProject();
		const item = makeWorkItem(projectPath, {
			id: 'prd-1',
			title: 'Delivery Planner',
			type: 'feature',
			status: 'planned',
			description: 'Build Delivery Planner.',
			tags: ['delivery-planner', 'external-mirror'],
		});

		const result = await writeExternalMirror({
			item,
			kind: 'prd',
			slug: 'delivery-planner',
		});

		expect(result.status).toBe('created');
		expect(result.mirrorHash).toBeDefined();

		const imported = await importExternalMirror(result.filePath);

		expect(imported.frontmatter).toMatchObject({
			id: 'prd-1',
			title: 'Delivery Planner',
			type: 'prd',
			status: 'planned',
			source: 'delivery-planner',
		});
		expect(imported.frontmatter.tags).toEqual(['delivery-planner', 'external-mirror']);
		expect(imported.body).toContain('Build Delivery Planner.');
		expect(imported.mirrorHash).toBe(result.mirrorHash);
	});

	it('round-trips nested GitHub frontmatter', async () => {
		const projectPath = await makeTempProject();
		const item = makeWorkItem(projectPath, {
			id: 'bug-1',
			title: 'Follow up regression',
			type: 'bug',
			status: 'planned',
			github: {
				owner: 'HumpfTech',
				repo: 'Maestro',
				repository: 'HumpfTech/Maestro',
				issueNumber: 61,
				url: 'https://github.com/HumpfTech/Maestro/issues/61',
			},
		});

		const result = await writeExternalMirror({
			item,
			kind: 'bug',
			slug: 'delivery-planner',
			bugId: 'issue-61-regression',
		});
		const raw = await fs.readFile(result.filePath, 'utf8');
		const imported = await importExternalMirror(result.filePath);

		expect(raw).toContain('github:\n  owner: HumpfTech\n  repo: Maestro\n');
		expect(imported.frontmatter.github).toMatchObject({
			owner: 'HumpfTech',
			repo: 'Maestro',
			issueNumber: 61,
		});
	});

	it('does not overwrite a changed disk mirror when the Work Graph hash is stale', async () => {
		const projectPath = await makeTempProject();
		const item = makeWorkItem(projectPath, {
			id: 'task-1',
			title: 'Resolve paths',
			type: 'task',
			status: 'planned',
			description: 'Write the resolver.',
			mirrorHash: markdownMirrorHash('older mirror'),
		});

		const first = await writeExternalMirror({
			item: {
				...item,
				mirrorHash: undefined,
			},
			kind: 'task',
			slug: 'delivery-planner',
			taskId: 2,
		});
		await fs.appendFile(first.filePath, '\nLocal edit.\n', 'utf8');

		const conflict = await writeExternalMirror({
			item,
			kind: 'task',
			slug: 'delivery-planner',
			taskId: 2,
		});

		expect(conflict.status).toBe('conflict');
		expect(conflict.error?.recoverable).toBe(true);
		expect(await fs.readFile(first.filePath, 'utf8')).toContain('Local edit.');
	});

	it('stays unchanged after Work Graph stores the mirror hash', async () => {
		const projectPath = await makeTempProject();
		const item = makeWorkItem(projectPath, {
			id: 'task-2',
			title: 'Mirror hashes',
			type: 'task',
			status: 'planned',
			description: 'Keep hashes stable.',
		});

		const first = await writeExternalMirror({
			item,
			kind: 'task',
			slug: 'delivery-planner',
			taskId: 3,
		});
		const second = await writeExternalMirror({
			item: {
				...item,
				mirrorHash: first.mirrorHash,
			},
			kind: 'task',
			slug: 'delivery-planner',
			taskId: 3,
		});

		expect(second.status).toBe('unchanged');
		expect(second.mirrorHash).toBe(first.mirrorHash);
	});

	it('allows configured project-local external mirror roots but rejects paths outside the project', async () => {
		const projectPath = await makeTempProject();
		const configured = resolveExternalMirrorPaths(projectPath, 'Custom Root', {
			externalMirrorRoot: 'planning/.external-mirror',
		});

		expect(configured.prdFile).toBe(
			path.join(projectPath, 'planning', '.external-mirror', 'prds', 'custom-root.md')
		);
		expect(() =>
			resolveExternalMirrorPaths(projectPath, 'Outside', {
				externalMirrorRoot: path.dirname(projectPath),
			})
		).toThrow('External mirror root must be inside the active project');
		expect(() =>
			resolveExternalMirrorPaths(projectPath, 'Outside', {
				prdsDir: path.dirname(projectPath),
			})
		).toThrow('External mirror root must be inside the active project');
	});

	it('normalizes empty slugs safely', () => {
		expect(slugifyMirrorSegment('  !!!  ')).toBe('untitled');
	});
});

async function makeTempProject(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-external-mirror-'));
	tempDirs.push(dir);
	return dir;
}

function makeWorkItem(projectPath: string, overrides: Partial<WorkItem>): WorkItem {
	return {
		id: 'item-1',
		type: 'task',
		status: 'planned',
		title: 'Test Item',
		description: 'Test body.',
		projectPath,
		gitPath: '.',
		source: 'delivery-planner',
		readonly: false,
		tags: [],
		createdAt: '2026-04-30T00:00:00.000Z',
		updatedAt: '2026-04-30T00:00:00.000Z',
		...overrides,
	};
}

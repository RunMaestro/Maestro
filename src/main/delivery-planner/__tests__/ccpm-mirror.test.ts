import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import type { WorkItem } from '../../../shared/work-graph-types';
import { importCcpmMirror, writeCcpmMirror } from '../ccpm-mirror';
import { markdownMirrorHash } from '../frontmatter';
import { resolveCcpmProjectPaths, slugifyCcpmSegment } from '../path-resolver';

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('CCPM mirror', () => {
	it('resolves project-local CCPM artifact paths', async () => {
		const projectPath = await makeTempProject();
		const paths = resolveCcpmProjectPaths(projectPath, 'Delivery Planner');

		expect(paths.prdFile).toBe(path.join(projectPath, '.claude', 'prds', 'delivery-planner.md'));
		expect(paths.epicFile).toBe(
			path.join(projectPath, '.claude', 'epics', 'delivery-planner', 'epic.md')
		);
		expect(paths.tasksDir).toBe(
			path.join(projectPath, '.claude', 'epics', 'delivery-planner', 'tasks')
		);
	});

	it('writes CCPM markdown with frontmatter and imports it back', async () => {
		const projectPath = await makeTempProject();
		const item = makeWorkItem(projectPath, {
			id: 'prd-1',
			title: 'Delivery Planner',
			type: 'feature',
			status: 'planned',
			description: 'Build Delivery Planner.',
			tags: ['delivery-planner', 'ccpm'],
		});

		const result = await writeCcpmMirror({
			item,
			kind: 'prd',
			slug: 'delivery-planner',
		});

		expect(result.status).toBe('created');
		expect(result.mirrorHash).toBeDefined();

		const imported = await importCcpmMirror(result.filePath);

		expect(imported.frontmatter).toMatchObject({
			id: 'prd-1',
			title: 'Delivery Planner',
			type: 'prd',
			status: 'planned',
			source: 'delivery-planner',
		});
		expect(imported.frontmatter.tags).toEqual(['delivery-planner', 'ccpm']);
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

		const result = await writeCcpmMirror({
			item,
			kind: 'bug',
			slug: 'delivery-planner',
			bugId: 'issue-61-regression',
		});
		const raw = await fs.readFile(result.filePath, 'utf8');
		const imported = await importCcpmMirror(result.filePath);

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

		const first = await writeCcpmMirror({
			item: {
				...item,
				mirrorHash: undefined,
			},
			kind: 'task',
			slug: 'delivery-planner',
			taskId: 2,
		});
		await fs.appendFile(first.filePath, '\nLocal edit.\n', 'utf8');

		const conflict = await writeCcpmMirror({
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

		const first = await writeCcpmMirror({
			item,
			kind: 'task',
			slug: 'delivery-planner',
			taskId: 3,
		});
		const second = await writeCcpmMirror({
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

	it('allows configured project-local CCPM roots but rejects paths outside the project', async () => {
		const projectPath = await makeTempProject();
		const configured = resolveCcpmProjectPaths(projectPath, 'Custom Root', {
			ccpmRoot: 'planning/.ccpm',
		});

		expect(configured.prdFile).toBe(
			path.join(projectPath, 'planning', '.ccpm', 'prds', 'custom-root.md')
		);
		expect(() =>
			resolveCcpmProjectPaths(projectPath, 'Outside', {
				ccpmRoot: path.dirname(projectPath),
			})
		).toThrow('CCPM root must be inside the active project');
		expect(() =>
			resolveCcpmProjectPaths(projectPath, 'Outside', {
				prdsDir: path.dirname(projectPath),
			})
		).toThrow('CCPM root must be inside the active project');
	});

	it('normalizes empty slugs safely', () => {
		expect(slugifyCcpmSegment('  !!!  ')).toBe('untitled');
	});
});

async function makeTempProject(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-ccpm-mirror-'));
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

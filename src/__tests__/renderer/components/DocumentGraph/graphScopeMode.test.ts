/**
 * Scope mode in buildGraphData.
 *
 * Focus mode answers "what does this document reach?" and only ever creates
 * nodes for files its BFS walks into, so a file nothing links to can never
 * appear. Scope mode answers "how do THESE documents relate?" - every file in
 * the set becomes a node, which is the only way an unlinked document is
 * visible at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	buildGraphData,
	clearGraphDataCache,
} from '../../../../renderer/components/DocumentGraph/graphDataBuilder';

/** path (relative to /test) -> file body */
const FILES: Record<string, string> = {
	'index.md': 'points at [[hub]] and [[leaf]]',
	'hub.md': 'links onward to [[leaf]]',
	'leaf.md': 'a leaf, links to nobody',
	'lonely.md': 'no links at all',
	'outside.md': 'not in any scope',
	'notes/deep.md': 'a nested note linking to [[hub]]',
};

function mockReadFile(fullPath: string): Promise<string | null> {
	const rel = fullPath.replace('/test/', '');
	return Promise.resolve(FILES[rel] ?? null);
}

function mockStat(fullPath: string): Promise<{ size: number; modifiedAt: string } | null> {
	const rel = fullPath.replace('/test/', '');
	if (!(rel in FILES)) return Promise.resolve(null);
	return Promise.resolve({ size: FILES[rel].length, modifiedAt: '2024-01-01T00:00:00.000Z' });
}

function mockReadDir(dirPath: string) {
	const normalized = dirPath.replace(/\/$/, '');
	const prefix = normalized === '/test' ? '' : `${normalized.replace('/test/', '')}/`;
	const names = new Set<string>();
	const out: Array<{ name: string; isDirectory: boolean; path: string }> = [];
	for (const rel of Object.keys(FILES)) {
		if (!rel.startsWith(prefix)) continue;
		const rest = rel.slice(prefix.length);
		const slash = rest.indexOf('/');
		const name = slash === -1 ? rest : rest.slice(0, slash);
		if (names.has(name)) continue;
		names.add(name);
		out.push({ name, isDirectory: slash !== -1, path: `${normalized}/${name}` });
	}
	return Promise.resolve(out);
}

function documentIds(nodes: { id: string; type: string }[]): string[] {
	return nodes.filter((n) => n.type === 'documentNode').map((n) => n.id.replace('doc-', ''));
}

describe('buildGraphData scope mode', () => {
	beforeEach(() => {
		clearGraphDataCache();
		vi.stubGlobal('window', {
			maestro: {
				fs: {
					readDir: vi.fn().mockImplementation(mockReadDir),
					readFile: vi.fn().mockImplementation(mockReadFile),
					stat: vi.fn().mockImplementation(mockStat),
				},
			},
		});
	});

	it('creates a node for every scoped file, including ones nothing links to', async () => {
		const result = await buildGraphData({
			rootPath: '/test',
			focusFile: '',
			scopeFiles: ['index.md', 'hub.md', 'leaf.md', 'lonely.md'],
		});

		expect(documentIds(result.nodes).sort()).toEqual([
			'hub.md',
			'index.md',
			'leaf.md',
			'lonely.md',
		]);
	});

	it('reports the unlinked files as orphans', async () => {
		const result = await buildGraphData({
			rootPath: '/test',
			focusFile: '',
			scopeFiles: ['index.md', 'hub.md', 'leaf.md', 'lonely.md'],
		});

		expect(result.orphanFiles).toEqual(['lonely.md']);
	});

	it('never drags in a file outside the scope', async () => {
		// index.md links to hub.md; with hub.md excluded the link must stay
		// broken rather than pulling it in. A scope the user picked is the scope
		// they get.
		const result = await buildGraphData({
			rootPath: '/test',
			focusFile: '',
			scopeFiles: ['index.md', 'leaf.md'],
		});

		expect(documentIds(result.nodes).sort()).toEqual(['index.md', 'leaf.md']);
		expect(documentIds(result.nodes)).not.toContain('hub.md');
	});

	it('auto-centers on the most-connected file', async () => {
		// index.md has two outgoing links; leaf.md is pointed at twice. Degree
		// counts both directions, so index and leaf tie at 2 and hub has 2 as
		// well - the tie breaks alphabetically, which keeps the choice stable.
		const result = await buildGraphData({
			rootPath: '/test',
			focusFile: '',
			scopeFiles: ['index.md', 'hub.md', 'leaf.md', 'lonely.md'],
		});

		expect(result.centerFile).not.toBe('');
		expect(result.centerFile).not.toBe('lonely.md');
		expect(documentIds(result.nodes)).toContain(result.centerFile);
	});

	it('honors an explicit focus inside the scope', async () => {
		const result = await buildGraphData({
			rootPath: '/test',
			focusFile: 'lonely.md',
			scopeFiles: ['index.md', 'hub.md', 'lonely.md'],
		});

		expect(result.centerFile).toBe('lonely.md');
	});

	it('falls back to auto-centering when the focus is not in the scope', async () => {
		const result = await buildGraphData({
			rootPath: '/test',
			focusFile: 'outside.md',
			scopeFiles: ['index.md', 'hub.md'],
		});

		expect(['index.md', 'hub.md']).toContain(result.centerFile);
	});

	it('builds edges among scoped files', async () => {
		const result = await buildGraphData({
			rootPath: '/test',
			focusFile: '',
			scopeFiles: ['index.md', 'hub.md', 'leaf.md'],
		});

		expect(result.edges.length).toBeGreaterThan(0);
		for (const edge of result.edges) {
			expect(edge.source).not.toBe('doc-lonely.md');
			expect(edge.target).not.toBe('doc-lonely.md');
		}
	});

	it('does not run the backlink scan, which would reach outside the scope', async () => {
		const result = await buildGraphData({
			rootPath: '/test',
			focusFile: '',
			scopeFiles: ['index.md', 'hub.md'],
		});

		expect(result.startBacklinkScan).toBeUndefined();
		expect(result.backlinksLoading).toBe(false);
	});

	it('scans a scope directory rather than trusting a caller-supplied list', async () => {
		const result = await buildGraphData({
			rootPath: '/test',
			focusFile: '',
			scopeDirectory: 'notes',
		});

		expect(documentIds(result.nodes)).toEqual(['notes/deep.md']);
	});

	it('reports truncation when the scope exceeds maxNodes', async () => {
		const result = await buildGraphData({
			rootPath: '/test',
			focusFile: '',
			scopeFiles: ['index.md', 'hub.md', 'leaf.md', 'lonely.md'],
			maxNodes: 2,
		});

		expect(result.nodes.filter((n) => n.type === 'documentNode').length).toBe(2);
		expect(result.hasMore).toBe(true);
	});

	it('reports a fully-loaded scope as complete', async () => {
		const result = await buildGraphData({
			rootPath: '/test',
			focusFile: '',
			scopeFiles: ['index.md', 'hub.md'],
		});

		expect(result.hasMore).toBe(false);
	});

	it('leaves focus mode alone: no orphans, and a center that echoes the request', async () => {
		const result = await buildGraphData({
			rootPath: '/test',
			focusFile: 'index.md',
		});

		expect(result.centerFile).toBe('index.md');
		expect(result.orphanFiles).toEqual([]);
		// lonely.md exists in the tree but nothing links to it, so a focus-rooted
		// walk must never reach it.
		expect(documentIds(result.nodes)).not.toContain('lonely.md');
	});
});

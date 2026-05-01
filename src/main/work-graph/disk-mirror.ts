import { promises as fs } from 'fs';
import path from 'path';

import { relativePathInsideRoot, resolveInsideRoot, toPosixPath } from '../../shared/pathUtils';
import type { WorkItem } from '../../shared/work-graph-types';
import {
	type WorkGraphFrontmatterRecord,
	parseWorkGraphMarkdown,
	renderWorkItemMarkdown,
	workGraphMirrorHash,
} from './frontmatter';

export type { WorkGraphFrontmatterRecord } from './frontmatter';

export type WorkGraphMirrorKind = 'prd' | 'epic' | 'wiki';
export type WorkGraphMirrorWriteStatus = 'created' | 'updated' | 'unchanged' | 'conflict';

export interface WorkGraphMirrorPathInput {
	projectPath: string;
	kind: WorkGraphMirrorKind;
	slug: string;
}

export interface WorkGraphMirrorWriteInput {
	item: WorkItem;
	kind?: WorkGraphMirrorKind;
	projectPath?: string;
	mirrorPath?: string;
	slug?: string;
	body?: string;
	frontmatter?: WorkGraphFrontmatterRecord;
	expectedMirrorHash?: string;
	allowOverwrite?: boolean;
}

export interface WorkGraphMirrorWriteResult {
	status: WorkGraphMirrorWriteStatus;
	filePath: string;
	mirrorPath: string;
	mirrorHash?: string;
	existingMirrorHash?: string;
	frontmatter: WorkGraphFrontmatterRecord;
	error?: WorkGraphMirrorConflictError;
}

export interface ImportedWorkGraphMirror {
	filePath: string;
	mirrorPath: string;
	mirrorHash: string;
	frontmatter: WorkGraphFrontmatterRecord;
	body: string;
}

export class WorkGraphMirrorConflictError extends Error {
	readonly recoverable = true;
	readonly code = 'WORK_GRAPH_MIRROR_CONFLICT';

	constructor(
		message: string,
		readonly filePath: string,
		readonly expectedMirrorHash: string,
		readonly actualMirrorHash: string
	) {
		super(message);
		this.name = 'WorkGraphMirrorConflictError';
	}
}

export async function writeWorkGraphMirror(
	input: WorkGraphMirrorWriteInput
): Promise<WorkGraphMirrorWriteResult> {
	const markdown = renderWorkItemMarkdown(input.item, input.frontmatter, input.body);
	const mirrorHash = workGraphMirrorHash(markdown);
	const projectPath = input.projectPath ?? input.item.projectPath;
	const filePath = resolveMirrorFilePath({
		projectPath,
		kind: input.kind ?? inferMirrorKind(input.item),
		mirrorPath: input.mirrorPath,
		slug: input.slug ?? input.item.slug ?? input.item.title,
	});
	const mirrorPath = relativePathInsideRoot(projectPath, filePath);
	const existing = await readOptionalFile(filePath);

	if (existing !== undefined) {
		const existingMirrorHash = workGraphMirrorHash(existing);
		const expectedMirrorHash = input.expectedMirrorHash ?? input.item.mirrorHash;

		if (existingMirrorHash === mirrorHash) {
			return {
				status: 'unchanged',
				filePath,
				mirrorPath,
				mirrorHash,
				existingMirrorHash,
				frontmatter: parseWorkGraphMarkdown(markdown).frontmatter,
			};
		}

		if (
			!input.allowOverwrite &&
			(!expectedMirrorHash || existingMirrorHash !== expectedMirrorHash)
		) {
			const error = new WorkGraphMirrorConflictError(
				`Work Graph mirror changed on disk: ${filePath}`,
				filePath,
				expectedMirrorHash ?? '',
				existingMirrorHash
			);
			return {
				status: 'conflict',
				filePath,
				mirrorPath,
				mirrorHash,
				existingMirrorHash,
				frontmatter: parseWorkGraphMarkdown(markdown).frontmatter,
				error,
			};
		}
	}

	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, markdown, 'utf8');

	return {
		status: existing === undefined ? 'created' : 'updated',
		filePath,
		mirrorPath,
		mirrorHash,
		existingMirrorHash: existing === undefined ? undefined : workGraphMirrorHash(existing),
		frontmatter: parseWorkGraphMarkdown(markdown).frontmatter,
	};
}

export async function importWorkGraphMirror(
	projectPath: string,
	filePath: string
): Promise<ImportedWorkGraphMirror> {
	const mirrorPath = relativePathInsideRoot(projectPath, filePath);
	const markdown = await fs.readFile(filePath, 'utf8');
	const parsed = parseWorkGraphMarkdown(markdown);

	return {
		filePath,
		mirrorPath,
		mirrorHash: workGraphMirrorHash(markdown),
		frontmatter: parsed.frontmatter,
		body: parsed.body,
	};
}

export function resolveWorkGraphMirrorPath(input: WorkGraphMirrorPathInput): string {
	return resolveMirrorFilePath(input);
}

export function inferMirrorKind(item: WorkItem): WorkGraphMirrorKind {
	if (item.type === 'document' || item.type === 'decision') {
		return 'wiki';
	}
	if (item.type === 'feature' || item.type === 'milestone') {
		return 'prd';
	}
	return 'epic';
}

function resolveMirrorFilePath(input: WorkGraphMirrorPathInput & { mirrorPath?: string }): string {
	if (input.mirrorPath) {
		if (path.isAbsolute(input.mirrorPath) || /^[A-Za-z]:[\\/]/.test(input.mirrorPath)) {
			throw new Error('Work Graph mirror path must be project-relative');
		}
		return resolveInsideRoot(input.projectPath, ...toPosixPath(input.mirrorPath).split('/'));
	}

	const slug = normalizeMirrorSlug(input.slug);
	if (input.kind === 'prd') {
		return resolveInsideRoot(input.projectPath, '.claude', 'prds', `${slug}.md`);
	}
	if (input.kind === 'epic') {
		return resolveInsideRoot(input.projectPath, '.claude', 'epics', `${slug}.md`);
	}
	return resolveInsideRoot(input.projectPath, '.maestro', 'wiki', `${slug}.md`);
}

function normalizeMirrorSlug(slug: string): string {
	return (
		slug
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '') || 'untitled'
	);
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if (isNodeError(error) && error.code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error;
}

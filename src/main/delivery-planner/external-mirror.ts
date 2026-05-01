import { promises as fs } from 'fs';
import path from 'path';

import type { WorkItem } from '../../shared/work-graph-types';
import {
	type FrontmatterRecord,
	markdownMirrorHash,
	parseMarkdownFrontmatter,
	serializeMarkdown,
} from './frontmatter';
import {
	type ExternalMirrorArtifactKind,
	type ExternalMirrorPathResolverConfig,
	resolveExternalMirrorArtifactPath,
	slugifyMirrorSegment,
} from './path-resolver';

export type ExternalMirrorStatus = 'created' | 'updated' | 'unchanged' | 'conflict';

export interface ExternalMirrorWriteInput {
	item: WorkItem;
	kind: ExternalMirrorArtifactKind;
	projectPath?: string;
	slug?: string;
	taskId?: string | number;
	bugId?: string | number;
	body?: string;
	frontmatter?: FrontmatterRecord;
	config?: ExternalMirrorPathResolverConfig;
	expectedMirrorHash?: string;
	allowOverwrite?: boolean;
}

export interface ExternalMirrorResult {
	status: ExternalMirrorStatus;
	filePath: string;
	mirrorHash?: string;
	existingMirrorHash?: string;
	error?: PlannerMirrorConflictError;
}

export interface ImportedExternalMirror {
	filePath: string;
	mirrorHash: string;
	frontmatter: FrontmatterRecord;
	body: string;
}

export class PlannerMirrorConflictError extends Error {
	readonly recoverable = true;
	readonly code = 'DELIVERY_PLANNER_MIRROR_CONFLICT';

	constructor(
		message: string,
		readonly filePath: string,
		readonly expectedMirrorHash: string,
		readonly actualMirrorHash: string
	) {
		super(message);
		this.name = 'PlannerMirrorConflictError';
	}
}

export async function writeExternalMirror(
	input: ExternalMirrorWriteInput
): Promise<ExternalMirrorResult> {
	const markdown = renderExternalMirrorMarkdown(input);
	const mirrorHash = markdownMirrorHash(markdown);
	const filePath = resolveMirrorPath(input);
	const existing = await readOptionalFile(filePath);

	if (existing !== undefined) {
		const existingMirrorHash = markdownMirrorHash(existing);
		const expectedMirrorHash = input.expectedMirrorHash ?? input.item.mirrorHash;

		if (existingMirrorHash === mirrorHash) {
			return {
				status: 'unchanged',
				filePath,
				mirrorHash,
				existingMirrorHash,
			};
		}

		if (expectedMirrorHash && existingMirrorHash !== expectedMirrorHash && !input.allowOverwrite) {
			const error = new PlannerMirrorConflictError(
				`External mirror changed on disk: ${filePath}`,
				filePath,
				expectedMirrorHash,
				existingMirrorHash
			);

			return {
				status: 'conflict',
				filePath,
				mirrorHash,
				existingMirrorHash,
				error,
			};
		}
	}

	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, markdown, 'utf8');

	return {
		status: existing === undefined ? 'created' : 'updated',
		filePath,
		mirrorHash,
		existingMirrorHash: existing === undefined ? undefined : markdownMirrorHash(existing),
	};
}

export async function importExternalMirror(filePath: string): Promise<ImportedExternalMirror> {
	const markdown = await fs.readFile(filePath, 'utf8');
	const parsed = parseMarkdownFrontmatter(markdown);

	return {
		filePath,
		mirrorHash: markdownMirrorHash(markdown),
		frontmatter: parsed.frontmatter,
		body: parsed.body,
	};
}

export function renderExternalMirrorMarkdown(input: ExternalMirrorWriteInput): string {
	return serializeMarkdown(
		buildExternalMirrorFrontmatter(input),
		input.body ?? input.item.description ?? ''
	);
}

export function buildExternalMirrorFrontmatter(input: ExternalMirrorWriteInput): FrontmatterRecord {
	const item = input.item;
	const titleSlug = slugifyMirrorSegment(item.title);
	const frontmatter: FrontmatterRecord = {
		...(input.frontmatter ?? {}),
		id: item.id,
		title: item.title,
		type: input.kind,
		status: item.status,
		source: item.source,
		projectPath: input.projectPath ?? item.projectPath,
		gitPath: item.gitPath,
		slug: input.slug ? slugifyMirrorSegment(input.slug) : titleSlug,
		tags: item.tags,
		created: item.createdAt,
		updated: item.updatedAt,
	};

	if (item.priority !== undefined) {
		frontmatter.priority = item.priority;
	}

	if (item.dueAt) {
		frontmatter.due = item.dueAt;
	}

	if (item.completedAt) {
		frontmatter.completed = item.completedAt;
	}

	if (item.github) {
		frontmatter.github = {
			owner: item.github.owner,
			repo: item.github.repo,
			issueNumber: item.github.issueNumber ?? null,
			pullRequestNumber: item.github.pullRequestNumber ?? null,
			url: item.github.url ?? null,
			branch: item.github.branch ?? null,
			commitSha: item.github.commitSha ?? null,
		};
	}

	if (item.dependencies?.length) {
		frontmatter.dependencies = item.dependencies.map((dependency) => dependency.toWorkItemId);
	}

	if (input.taskId !== undefined) {
		frontmatter.task = String(input.taskId);
	}

	if (input.bugId !== undefined) {
		frontmatter.bug = String(input.bugId);
	}

	return frontmatter;
}

function resolveMirrorPath(input: ExternalMirrorWriteInput): string {
	const projectPath = input.projectPath ?? input.item.projectPath;
	const slug = input.slug ?? input.item.metadata?.mirrorSlug;

	if (typeof slug !== 'string' || !slug.trim()) {
		return resolveExternalMirrorArtifactPath({
			projectPath,
			kind: input.kind,
			slug: input.item.title,
			taskId: input.taskId ?? input.item.metadata?.mirrorTaskId?.toString(),
			bugId: input.bugId ?? input.item.metadata?.mirrorBugId?.toString(),
			config: input.config,
		});
	}

	return resolveExternalMirrorArtifactPath({
		projectPath,
		kind: input.kind,
		slug,
		taskId: input.taskId ?? input.item.metadata?.mirrorTaskId?.toString(),
		bugId: input.bugId ?? input.item.metadata?.mirrorBugId?.toString(),
		config: input.config,
	});
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

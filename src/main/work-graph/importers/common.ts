import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type {
	WorkGraphImportItemSummary,
	WorkGraphImportSummary,
	WorkItem,
	WorkItemCreateInput,
	WorkItemFilters,
	WorkItemSource,
	WorkItemSourceInput,
} from '../../../shared/work-graph-types';
import { getWorkGraphItemStore } from '../item-store';
import type { WorkItemSourceReference } from '../row-mappers';

export interface WorkGraphImporterStore {
	createItem(input: WorkItemCreateInput): Promise<WorkItem>;
	getItem?(id: string): Promise<WorkItem | undefined>;
	listItems(filters?: WorkItemFilters): Promise<{ items: WorkItem[]; total?: number }>;
	upsertSource?(input: WorkItemSourceInput): Promise<WorkItemSourceReference>;
	getSource?(
		input: Pick<WorkItemSourceInput, 'source' | 'projectPath' | 'externalType' | 'externalId'>
	): Promise<WorkItemSourceReference | undefined>;
}

export interface WorkGraphImporterOptions {
	projectPath: string;
	store?: WorkGraphImporterStore;
}

export interface ImportCandidate {
	externalType: string;
	externalId: string;
	gitPath: string;
	type: WorkItemCreateInput['type'];
	title: string;
	description?: string;
	status?: WorkItemCreateInput['status'];
	tags?: string[];
	metadata?: Record<string, unknown>;
	readonly?: boolean;
}

export function getImporterStore(store?: WorkGraphImporterStore): WorkGraphImporterStore {
	return store ?? getWorkGraphItemStore();
}

export async function importCandidates(
	source: WorkItemSource,
	options: WorkGraphImporterOptions,
	candidates: ImportCandidate[]
): Promise<WorkGraphImportSummary> {
	const store = getImporterStore(options.store);
	const startedAt = new Date().toISOString();
	const summary: WorkGraphImportSummary = {
		source,
		projectPath: options.projectPath,
		gitPath: options.projectPath,
		startedAt,
		completedAt: startedAt,
		created: 0,
		updated: 0,
		skipped: 0,
		failed: 0,
		items: [],
	};

	const existing = await store.listItems({
		source,
		projectPath: options.projectPath,
		limit: 10000,
	});
	const existingByExternalId = new Map<string, WorkItem>();
	for (const item of existing.items) {
		const externalId = getImporterExternalId(item);
		if (externalId) {
			existingByExternalId.set(externalId, item);
		}
	}

	for (const candidate of candidates) {
		try {
			const current =
				existingByExternalId.get(candidate.externalId) ??
				(await findSourceItem(store, source, options.projectPath, candidate));
			if (current) {
				await upsertProvenance(store, source, options.projectPath, current.id, candidate);
				summary.skipped++;
				summary.items.push(itemSummary(candidate, 'skipped', current.id));
				continue;
			}

			const item = await store.createItem({
				type: candidate.type,
				title: candidate.title,
				description: candidate.description,
				status: candidate.status ?? 'discovered',
				projectPath: options.projectPath,
				gitPath: candidate.gitPath,
				source,
				readonly: candidate.readonly ?? true,
				tags: candidate.tags,
				metadata: {
					...(candidate.metadata ?? {}),
					importer: {
						source,
						externalType: candidate.externalType,
						externalId: candidate.externalId,
						gitPath: candidate.gitPath,
					},
				},
			});
			await upsertProvenance(store, source, options.projectPath, item.id, candidate);
			existingByExternalId.set(candidate.externalId, item);
			summary.created++;
			summary.items.push(itemSummary(candidate, 'created', item.id));
		} catch (error) {
			summary.failed++;
			summary.items.push({
				externalId: candidate.externalId,
				title: candidate.title,
				status: 'failed',
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	summary.completedAt = new Date().toISOString();
	return summary;
}

export async function findMarkdownFiles(root: string, relativeDir: string): Promise<string[]> {
	const absoluteDir = path.join(root, relativeDir);
	const files: string[] = [];
	await walkMarkdown(absoluteDir, files);
	return files;
}

export async function readMarkdownCandidate(
	projectPath: string,
	filePath: string,
	fallbackTitle: string
): Promise<{ title: string; description: string; hash: string; gitPath: string }> {
	const content = await fs.readFile(filePath, 'utf8');
	const gitPath = toGitPath(projectPath, filePath);
	return {
		title: extractTitle(content) ?? fallbackTitle,
		description: firstMeaningfulParagraph(content),
		hash: hashContent(content),
		gitPath,
	};
}

export function toGitPath(projectPath: string, absolutePath: string): string {
	return path.relative(projectPath, absolutePath).split(path.sep).join('/');
}

export function hashContent(content: string): string {
	return crypto.createHash('sha256').update(content).digest('hex');
}

export function pathId(...parts: string[]): string {
	return parts.join(':').replace(/\\/g, '/');
}

function getImporterExternalId(item: WorkItem): string | undefined {
	const importer = item.metadata?.importer;
	if (isRecord(importer) && typeof importer.externalId === 'string') {
		return importer.externalId;
	}
	return undefined;
}

async function upsertProvenance(
	store: WorkGraphImporterStore,
	source: WorkItemSource,
	projectPath: string,
	workItemId: string,
	candidate: ImportCandidate
): Promise<void> {
	await store.upsertSource?.({
		workItemId,
		source,
		projectPath,
		gitPath: candidate.gitPath,
		externalType: candidate.externalType,
		externalId: candidate.externalId,
		metadata: candidate.metadata,
	});
}

async function findSourceItem(
	store: WorkGraphImporterStore,
	source: WorkItemSource,
	projectPath: string,
	candidate: ImportCandidate
): Promise<WorkItem | undefined> {
	if (!store.getSource || !store.getItem) {
		return undefined;
	}
	const sourceReference = await store.getSource({
		source,
		projectPath,
		externalType: candidate.externalType,
		externalId: candidate.externalId,
	});
	return sourceReference ? store.getItem(sourceReference.workItemId) : undefined;
}

function itemSummary(
	candidate: ImportCandidate,
	status: WorkGraphImportItemSummary['status'],
	workItemId: string
): WorkGraphImportItemSummary {
	return {
		externalId: candidate.externalId,
		workItemId,
		title: candidate.title,
		status,
	};
}

async function walkMarkdown(dir: string, files: string[]): Promise<void> {
	let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return;
		}
		throw error;
	}

	for (const entry of entries) {
		const child = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walkMarkdown(child, files);
		} else if (entry.isFile() && entry.name.endsWith('.md')) {
			files.push(child);
		}
	}
}

function extractTitle(content: string): string | undefined {
	const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
	if (heading) {
		return stripMarkdown(heading);
	}

	const frontmatterTitle = content.match(
		/^---[\s\S]*?\ntitle:\s*["']?(.+?)["']?\n[\s\S]*?---/m
	)?.[1];
	return frontmatterTitle ? stripMarkdown(frontmatterTitle.trim()) : undefined;
}

function firstMeaningfulParagraph(content: string): string {
	return (
		content
			.replace(/^---[\s\S]*?---\s*/, '')
			.split(/\n{2,}/)
			.map((block) => block.trim())
			.find((block) => block.length > 0 && !block.startsWith('#'))
			?.split('\n')
			.map((line) => stripMarkdown(line).trim())
			.filter(Boolean)
			.join('\n') ?? ''
	);
}

function stripMarkdown(value: string): string {
	return value
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/^#+\s*/, '')
		.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

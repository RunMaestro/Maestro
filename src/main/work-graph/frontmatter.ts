import crypto from 'crypto';

import type { WorkItem } from '../../shared/work-graph-types';

export type WorkGraphFrontmatterValue =
	| string
	| number
	| boolean
	| null
	| WorkGraphFrontmatterValue[]
	| { [key: string]: WorkGraphFrontmatterValue };

export type WorkGraphFrontmatterRecord = Record<string, WorkGraphFrontmatterValue>;

export interface ParsedWorkGraphMarkdown {
	frontmatter: WorkGraphFrontmatterRecord;
	body: string;
}

const FRONTMATTER_ORDER = [
	'id',
	'title',
	'type',
	'status',
	'source',
	'readonly',
	'projectPath',
	'gitPath',
	'slug',
	'parentWorkItemId',
	'tags',
	'capabilities',
	'priority',
	'dueAt',
	'completedAt',
	'owner',
	'github',
	'dependencies',
	'createdAt',
	'updatedAt',
];

export function renderWorkItemMarkdown(
	item: WorkItem,
	frontmatter: WorkGraphFrontmatterRecord = {},
	body = item.description ?? ''
): string {
	return serializeWorkGraphMarkdown(buildWorkItemFrontmatter(item, frontmatter), body);
}

export function buildWorkItemFrontmatter(
	item: WorkItem,
	extra: WorkGraphFrontmatterRecord = {}
): WorkGraphFrontmatterRecord {
	return orderFrontmatter({
		...extra,
		id: item.id,
		title: item.title,
		type: item.type,
		status: item.status,
		source: item.source,
		readonly: item.readonly,
		projectPath: item.projectPath,
		gitPath: item.gitPath,
		slug: item.slug ?? null,
		parentWorkItemId: item.parentWorkItemId ?? null,
		tags: item.tags,
		capabilities: item.capabilities ?? [],
		priority: item.priority ?? null,
		dueAt: item.dueAt ?? null,
		completedAt: item.completedAt ?? null,
		owner: toFrontmatterValue(item.owner),
		github: toFrontmatterValue(item.github),
		dependencies: item.dependencies?.map((dependency) => dependency.toWorkItemId) ?? [],
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	});
}

export function serializeWorkGraphMarkdown(
	frontmatter: WorkGraphFrontmatterRecord,
	body: string
): string {
	const yaml = serializeFrontmatter(orderFrontmatter(frontmatter));
	const normalizedBody = normalizeLineEndings(body).replace(/^\n+/, '').replace(/\s*$/, '\n');

	return `---\n${yaml}---\n\n${normalizedBody}`;
}

export function parseWorkGraphMarkdown(markdown: string): ParsedWorkGraphMarkdown {
	const normalized = normalizeLineEndings(markdown);

	if (!normalized.startsWith('---\n')) {
		return {
			frontmatter: {},
			body: normalized,
		};
	}

	const end = normalized.indexOf('\n---', 4);
	if (end === -1) {
		return {
			frontmatter: {},
			body: normalized,
		};
	}

	return {
		frontmatter: parseFrontmatter(normalized.slice(4, end)),
		body: normalized.slice(end + 4).replace(/^\n/, ''),
	};
}

export function workGraphMirrorHash(markdown: string): string {
	return crypto.createHash('sha256').update(normalizeLineEndings(markdown), 'utf8').digest('hex');
}

export function serializeFrontmatter(frontmatter: WorkGraphFrontmatterRecord): string {
	return Object.entries(frontmatter)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => serializeEntry(key, value, 0))
		.join('');
}

function serializeEntry(key: string, value: WorkGraphFrontmatterValue, depth: number): string {
	const indent = '\t'.repeat(0) + '  '.repeat(depth);

	if (Array.isArray(value)) {
		if (value.length === 0) {
			return `${indent}${key}: []\n`;
		}

		return `${indent}${key}:\n${value.map((item) => serializeArrayItem(item, depth + 1)).join('')}`;
	}

	if (isFrontmatterObject(value)) {
		const entries = Object.entries(value).filter(([, child]) => child !== undefined);
		if (entries.length === 0) {
			return `${indent}${key}: {}\n`;
		}

		return `${indent}${key}:\n${entries.map(([childKey, child]) => serializeEntry(childKey, child, depth + 1)).join('')}`;
	}

	return `${indent}${key}: ${serializeScalar(value)}\n`;
}

function serializeArrayItem(value: WorkGraphFrontmatterValue, depth: number): string {
	const indent = '  '.repeat(depth);

	if (Array.isArray(value) || isFrontmatterObject(value)) {
		return `${indent}- ${JSON.stringify(value)}\n`;
	}

	return `${indent}- ${serializeScalar(value)}\n`;
}

function serializeScalar(value: string | number | boolean | null): string {
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (!value) {
		return '""';
	}
	if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) {
		return value;
	}
	return JSON.stringify(value);
}

function parseFrontmatter(yaml: string): WorkGraphFrontmatterRecord {
	return parseObjectBlock(yaml.split('\n'), 0, 0).value;
}

function parseObjectBlock(
	lines: string[],
	startIndex: number,
	depth: number
): { value: WorkGraphFrontmatterRecord; nextIndex: number } {
	const result: WorkGraphFrontmatterRecord = {};
	let index = startIndex;

	while (index < lines.length) {
		const line = lines[index];
		const indent = indentationDepth(line);

		if (indent < depth) {
			break;
		}
		if (indent > depth) {
			index += 1;
			continue;
		}

		const match = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line.slice(indent * 2));
		if (!match) {
			index += 1;
			continue;
		}

		const [, key, rawValue = ''] = match;
		const trimmedValue = rawValue.trim();
		if (trimmedValue) {
			result[key] = parseScalar(trimmedValue);
			index += 1;
			continue;
		}

		const nextLine = lines[index + 1] ?? '';
		const nextIndent = indentationDepth(nextLine);
		if (nextIndent <= depth) {
			result[key] = null;
			index += 1;
			continue;
		}

		if (nextLine.trimStart().startsWith('- ')) {
			const parsed = parseArrayBlock(lines, index + 1, depth + 1);
			result[key] = parsed.value;
			index = parsed.nextIndex;
			continue;
		}

		const parsed = parseObjectBlock(lines, index + 1, depth + 1);
		result[key] = parsed.value;
		index = parsed.nextIndex;
	}

	return { value: result, nextIndex: index };
}

function parseArrayBlock(
	lines: string[],
	startIndex: number,
	depth: number
): { value: WorkGraphFrontmatterValue[]; nextIndex: number } {
	const result: WorkGraphFrontmatterValue[] = [];
	let index = startIndex;

	while (index < lines.length) {
		const line = lines[index];
		const indent = indentationDepth(line);
		if (indent < depth) {
			break;
		}
		if (indent > depth) {
			index += 1;
			continue;
		}

		const match = /^-\s*(.*)$/.exec(line.slice(indent * 2));
		if (!match) {
			break;
		}

		result.push(parseScalar(match[1].trim()));
		index += 1;
	}

	return { value: result, nextIndex: index };
}

function parseScalar(value: string): WorkGraphFrontmatterValue {
	if (value === 'null') {
		return null;
	}
	if (value === 'true') {
		return true;
	}
	if (value === 'false') {
		return false;
	}
	if (/^-?\d+(\.\d+)?$/.test(value)) {
		return Number(value);
	}
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		try {
			return JSON.parse(value);
		} catch {
			return value.slice(1, -1);
		}
	}
	if (
		(value.startsWith('{') && value.endsWith('}')) ||
		(value.startsWith('[') && value.endsWith(']'))
	) {
		try {
			return JSON.parse(value) as WorkGraphFrontmatterValue;
		} catch {
			return value;
		}
	}
	return value;
}

function indentationDepth(line: string): number {
	const match = /^ */.exec(line);
	return Math.floor((match?.[0].length ?? 0) / 2);
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function orderFrontmatter(frontmatter: WorkGraphFrontmatterRecord): WorkGraphFrontmatterRecord {
	const ordered: WorkGraphFrontmatterRecord = {};
	for (const key of FRONTMATTER_ORDER) {
		if (frontmatter[key] !== undefined) {
			ordered[key] = frontmatter[key];
		}
	}
	for (const key of Object.keys(frontmatter).sort()) {
		if (!(key in ordered)) {
			ordered[key] = frontmatter[key];
		}
	}
	return ordered;
}

function toFrontmatterValue(value: unknown): WorkGraphFrontmatterValue {
	if (value === undefined) {
		return null;
	}
	return JSON.parse(JSON.stringify(value)) as WorkGraphFrontmatterValue;
}

function isFrontmatterObject(value: WorkGraphFrontmatterValue): value is {
	[key: string]: WorkGraphFrontmatterValue;
} {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

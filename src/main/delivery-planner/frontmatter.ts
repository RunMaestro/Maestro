import crypto from 'crypto';

export type FrontmatterValue =
	| string
	| number
	| boolean
	| null
	| FrontmatterValue[]
	| { [key: string]: FrontmatterValue };

export type FrontmatterRecord = Record<string, FrontmatterValue>;

export interface ParsedMarkdownFrontmatter {
	frontmatter: FrontmatterRecord;
	body: string;
}

export function serializeMarkdown(frontmatter: FrontmatterRecord, body: string): string {
	const yaml = serializeFrontmatter(frontmatter);
	const normalizedBody = normalizeLineEndings(body).replace(/^\n+/, '').replace(/\s*$/, '\n');

	return `---\n${yaml}---\n\n${normalizedBody}`;
}

export function serializeFrontmatter(frontmatter: FrontmatterRecord): string {
	return `${Object.entries(frontmatter)
		.filter(([, value]) => value !== undefined)
		.map(([key, value]) => serializeEntry(key, value, 0))
		.join('')}`;
}

export function parseMarkdownFrontmatter(markdown: string): ParsedMarkdownFrontmatter {
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

	const yaml = normalized.slice(4, end);
	const body = normalized.slice(end + 4).replace(/^\n/, '');

	return {
		frontmatter: parseFrontmatter(yaml),
		body,
	};
}

export function markdownMirrorHash(markdown: string): string {
	return crypto.createHash('sha256').update(normalizeLineEndings(markdown), 'utf8').digest('hex');
}

function serializeEntry(key: string, value: FrontmatterValue, depth: number): string {
	const indent = '  '.repeat(depth);

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

function serializeArrayItem(value: FrontmatterValue, depth: number): string {
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

function parseFrontmatter(yaml: string): FrontmatterRecord {
	const lines = yaml.split('\n');

	return parseObjectBlock(lines, 0, 0).value;
}

function parseObjectBlock(
	lines: string[],
	startIndex: number,
	depth: number
): { value: FrontmatterRecord; nextIndex: number } {
	const result: FrontmatterRecord = {};
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
): { value: FrontmatterValue[]; nextIndex: number } {
	const result: FrontmatterValue[] = [];
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

function parseScalar(value: string): FrontmatterValue {
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
			return JSON.parse(value) as FrontmatterValue;
		} catch {
			return value;
		}
	}

	return value;
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function indentationDepth(line: string): number {
	const spaces = /^ */.exec(line)?.[0].length ?? 0;

	return Math.floor(spaces / 2);
}

function isFrontmatterObject(
	value: FrontmatterValue
): value is { [key: string]: FrontmatterValue } {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

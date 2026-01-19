/**
 * documentStats - Utility for computing document metadata from markdown files.
 *
 * Used by the Document Graph feature to display document statistics in graph nodes.
 * Computes:
 * - Line count
 * - Word count
 * - File size (formatted)
 * - Title (from front matter, first heading, or filename)
 * - Description (from front matter)
 */

import { parseMarkdownLinks } from './markdownLinkParser';

// Browser-compatible path utilities (Node's path module doesn't work in renderer)

/**
 * Get the basename of a path, optionally removing an extension
 * (browser-compatible path.basename)
 */
function basename(filePath: string, ext?: string): string {
	if (!filePath) return '';
	const normalized = filePath.replace(/\\/g, '/');
	let base = normalized.slice(normalized.lastIndexOf('/') + 1);
	if (ext && base.endsWith(ext)) {
		base = base.slice(0, -ext.length);
	}
	return base;
}

/**
 * Get the extension of a path (browser-compatible path.extname)
 */
function extname(filePath: string): string {
	if (!filePath) return '';
	const normalized = filePath.replace(/\\/g, '/');
	const base = normalized.slice(normalized.lastIndexOf('/') + 1);
	const dotIndex = base.lastIndexOf('.');
	if (dotIndex <= 0) return ''; // No extension or hidden file like .gitignore
	return base.slice(dotIndex);
}

/**
 * Document statistics extracted from a markdown file
 */
export interface DocumentStats {
	/** Document title (from front matter, first heading, or filename) */
	title: string;
	/** Number of lines in the document */
	lineCount: number;
	/** Number of words in the document */
	wordCount: number;
	/** Human-readable file size (e.g., "1.2 KB", "3.4 MB") */
	size: string;
	/** Optional description from front matter */
	description?: string;
	/** Plaintext content preview (fallback when no frontmatter description exists) */
	contentPreview?: string;
	/** Path to the document file */
	filePath: string;
	/** Paths to broken internal links (links to non-existent files) */
	brokenLinks?: string[];
	/** True if the file is very large (>1MB) and was truncated for parsing */
	isLargeFile?: boolean;
}

/**
 * Front matter keys to check for description, in order of preference.
 * The first matching key will be used.
 */
const DESCRIPTION_KEYS = [
	'description',
	'overview',
	'abstract',
	'summary',
	'synopsis',
	'intro',
	'introduction',
	'about',
	'tldr',
	'excerpt',
	'blurb',
	'brief',
	'preamble',
] as const;

/**
 * Format a file size in bytes to a human-readable string
 * @param bytes - File size in bytes
 * @returns Formatted string (e.g., "1.2 KB", "3.4 MB")
 */
export function formatFileSize(bytes: number): string {
	if (bytes < 0) {
		return '0 B';
	}

	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let unitIndex = 0;
	let size = bytes;

	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex++;
	}

	// Use integer for bytes, 1 decimal for KB and above
	if (unitIndex === 0) {
		return `${Math.round(size)} ${units[unitIndex]}`;
	}

	return `${size.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Count words in content, splitting on whitespace and filtering empty strings
 * @param content - Text content to count words in
 * @returns Number of words
 */
export function countWords(content: string): number {
	if (!content || content.trim() === '') {
		return 0;
	}

	// Split on any whitespace (spaces, tabs, newlines, etc.)
	const words = content.split(/\s+/).filter((word) => word.length > 0);
	return words.length;
}

/**
 * Count lines in content
 * @param content - Text content to count lines in
 * @returns Number of lines
 */
export function countLines(content: string): number {
	if (!content) {
		return 0;
	}

	// Empty string has 0 lines, any content has at least 1 line
	if (content.trim() === '') {
		return 0;
	}

	// Count line breaks and add 1 (content without trailing newline)
	// Content with trailing newline: "a\nb\n" has 2 lines
	// Content without trailing newline: "a\nb" has 2 lines
	const lines = content.split('\n');

	// If the last element is empty (trailing newline), don't count it
	if (lines[lines.length - 1] === '') {
		return lines.length - 1;
	}

	return lines.length;
}

/**
 * Extract title from content, checking in order:
 * 1. Front matter 'title' field
 * 2. First H1 heading (# Title)
 * 3. Filename without extension
 *
 * @param content - Markdown content
 * @param filePath - Path to the file
 * @param frontMatter - Parsed front matter object
 * @returns Title string
 */
export function extractTitle(
	content: string,
	filePath: string,
	frontMatter: Record<string, unknown>
): string {
	// 1. Check front matter for title
	if (frontMatter.title && typeof frontMatter.title === 'string') {
		return frontMatter.title;
	}

	// 2. Look for first H1 heading
	const headingMatch = content.match(/^#\s+(.+)$/m);
	if (headingMatch) {
		return headingMatch[1].trim();
	}

	// 3. Fall back to filename without extension
	return basename(filePath, extname(filePath));
}

/**
 * Extract description from front matter, checking multiple possible keys
 *
 * @param frontMatter - Parsed front matter object
 * @returns Description string if found, undefined otherwise
 */
export function extractDescription(frontMatter: Record<string, unknown>): string | undefined {
	for (const key of DESCRIPTION_KEYS) {
		const value = frontMatter[key];
		if (value && typeof value === 'string') {
			return value;
		}
	}

	return undefined;
}

/**
 * Maximum characters to extract for content preview (generous limit for truncation elsewhere)
 */
const MAX_CONTENT_PREVIEW_LENGTH = 600;

/**
 * Strip markdown syntax from content and return plaintext.
 * Removes: headings, bold/italic, links, images, code blocks, blockquotes, lists, etc.
 *
 * @param content - Markdown content
 * @returns Plaintext version of the content
 */
function stripMarkdownSyntax(content: string): string {
	let text = content;

	// Remove front matter (--- ... ---)
	text = text.replace(/^---[\s\S]*?---\n*/m, '');

	// Remove code blocks (``` ... ```)
	text = text.replace(/```[\s\S]*?```/g, '');

	// Remove inline code (`code`)
	text = text.replace(/`[^`]+`/g, '');

	// Remove images ![alt](url)
	text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, '');

	// Replace links [text](url) with just the text
	text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

	// Replace wiki-links [[link]] with just the link text
	text = text.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1');

	// Remove HTML tags
	text = text.replace(/<[^>]+>/g, '');

	// Remove headings (# Heading)
	text = text.replace(/^#{1,6}\s+/gm, '');

	// Remove blockquotes (> quote)
	text = text.replace(/^>\s*/gm, '');

	// Remove horizontal rules (---, ***, ___)
	text = text.replace(/^[-*_]{3,}\s*$/gm, '');

	// Remove emphasis markers (bold/italic) but keep text
	// Handle ***text***, **text**, *text*, ___text___, __text__, _text_
	text = text.replace(/(\*{1,3}|_{1,3})([^*_]+)\1/g, '$2');

	// Remove strikethrough ~~text~~
	text = text.replace(/~~([^~]+)~~/g, '$1');

	// Remove list markers (-, *, +, 1.)
	text = text.replace(/^[\s]*[-*+]\s+/gm, '');
	text = text.replace(/^[\s]*\d+\.\s+/gm, '');

	// Remove task list markers [ ] and [x]
	text = text.replace(/\[[ xX]\]\s*/g, '');

	// Collapse multiple newlines into single space
	text = text.replace(/\n+/g, ' ');

	// Collapse multiple spaces into single space
	text = text.replace(/\s+/g, ' ');

	return text.trim();
}

/**
 * Extract a plaintext content preview from markdown.
 * Skips front matter and title, strips markdown syntax, returns clean text.
 *
 * @param content - Markdown content
 * @param title - Document title to skip if it appears at the start
 * @returns Plaintext preview string, or undefined if no meaningful content
 */
export function extractContentPreview(content: string, title: string): string | undefined {
	if (!content || content.trim() === '') {
		return undefined;
	}

	// Strip markdown syntax to get plaintext
	let plaintext = stripMarkdownSyntax(content);

	// Remove the title from the start if it appears there (avoid duplication)
	if (plaintext.toLowerCase().startsWith(title.toLowerCase())) {
		plaintext = plaintext.slice(title.length).trim();
		// Remove any leading punctuation or whitespace left over
		plaintext = plaintext.replace(/^[:\-–—.!?,;\s]+/, '');
	}

	// If no meaningful content left, return undefined
	if (!plaintext || plaintext.length < 10) {
		return undefined;
	}

	// Limit to reasonable length (will be truncated further by UI)
	if (plaintext.length > MAX_CONTENT_PREVIEW_LENGTH) {
		plaintext = plaintext.slice(0, MAX_CONTENT_PREVIEW_LENGTH);
	}

	return plaintext;
}

/**
 * Compute document statistics from markdown content.
 * Handles malformed content gracefully - never throws, always returns valid stats.
 *
 * @param content - The markdown file content
 * @param filePath - The relative path of the file
 * @param fileSize - File size in bytes
 * @returns DocumentStats object with computed metadata
 */
export function computeDocumentStats(
	content: string,
	filePath: string,
	fileSize: number
): DocumentStats {
	// Handle null/undefined content
	const safeContent = content ?? '';
	const safeFilePath = filePath ?? 'unknown.md';
	const safeFileSize = typeof fileSize === 'number' && !isNaN(fileSize) ? fileSize : 0;

	// Parse front matter using existing utility (already handles errors gracefully)
	let frontMatter: Record<string, unknown> = {};
	try {
		const parsed = parseMarkdownLinks(safeContent, safeFilePath);
		frontMatter = parsed.frontMatter;
	} catch (error) {
		// parseMarkdownLinks should never throw, but defensive coding
		console.warn(`Unexpected error parsing front matter in ${safeFilePath}:`, error);
		frontMatter = {};
	}

	// Compute stats with error handling for each operation
	let title: string;
	try {
		title = extractTitle(safeContent, safeFilePath, frontMatter);
	} catch (error) {
		console.warn(`Failed to extract title from ${safeFilePath}:`, error);
		title = basename(safeFilePath, extname(safeFilePath));
	}

	let lineCount: number;
	try {
		lineCount = countLines(safeContent);
	} catch (error) {
		console.warn(`Failed to count lines in ${safeFilePath}:`, error);
		lineCount = 0;
	}

	let wordCount: number;
	try {
		wordCount = countWords(safeContent);
	} catch (error) {
		console.warn(`Failed to count words in ${safeFilePath}:`, error);
		wordCount = 0;
	}

	const size = formatFileSize(safeFileSize);
	const description = extractDescription(frontMatter);

	// Extract plaintext content preview as fallback when no frontmatter description exists
	let contentPreview: string | undefined;
	try {
		contentPreview = extractContentPreview(safeContent, title);
	} catch (error) {
		console.warn(`Failed to extract content preview from ${safeFilePath}:`, error);
		contentPreview = undefined;
	}

	return {
		title,
		lineCount,
		wordCount,
		size,
		description,
		contentPreview,
		filePath: safeFilePath,
	};
}

export default computeDocumentStats;

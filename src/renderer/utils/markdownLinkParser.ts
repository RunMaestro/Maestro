/**
 * markdownLinkParser - Utility for extracting links and metadata from markdown files.
 *
 * Used by the Document Graph feature to build a graph of document relationships.
 * Extracts:
 * - Internal links (wiki-style and standard markdown)
 * - External links (with domain extraction)
 * - Front matter metadata
 */

// Browser-compatible path utilities (Node's path module doesn't work in renderer)

/**
 * Get the directory portion of a path (browser-compatible path.dirname)
 */
function dirname(filePath: string): string {
	if (!filePath) return '.';
	const normalized = filePath.replace(/\\/g, '/');
	const lastSlash = normalized.lastIndexOf('/');
	if (lastSlash === -1) return '.';
	if (lastSlash === 0) return '/';
	return normalized.slice(0, lastSlash);
}

/**
 * Get the extension of a path (browser-compatible path.extname)
 */
function extname(filePath: string): string {
	if (!filePath) return '';
	const normalized = filePath.replace(/\\/g, '/');
	const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
	const dotIndex = basename.lastIndexOf('.');
	if (dotIndex <= 0) return ''; // No extension or hidden file like .gitignore
	return basename.slice(dotIndex);
}

/**
 * Join path segments and normalize (browser-compatible path.join)
 */
function joinPath(...segments: string[]): string {
	// Filter out empty segments and join with /
	const joined = segments
		.filter((s) => s && s.length > 0)
		.join('/')
		.replace(/\\/g, '/');

	// Normalize multiple slashes
	const normalized = joined.replace(/\/+/g, '/');

	// Resolve . and .. segments
	const parts = normalized.split('/');
	const result: string[] = [];

	for (const part of parts) {
		if (part === '..') {
			if (result.length > 0 && result[result.length - 1] !== '..') {
				result.pop();
			} else {
				result.push('..');
			}
		} else if (part !== '.' && part !== '') {
			result.push(part);
		}
	}

	return result.join('/') || '.';
}

/**
 * Represents an external link with its URL and extracted domain
 */
export interface ExternalLink {
	url: string;
	domain: string;
}

/**
 * Result of parsing a markdown file for links
 */
export interface ParsedMarkdownLinks {
	/** Resolved relative paths to internal .md files */
	internalLinks: string[];
	/** External URLs with their domains */
	externalLinks: ExternalLink[];
	/** Parsed front matter key-value pairs */
	frontMatter: Record<string, unknown>;
}

// Regex patterns - aligned with remarkFileLinks.ts for consistency

/**
 * Wiki-style links: [[Note Name]] or [[Folder/Note]] or [[Folder/Note|Display Text]]
 * The pipe syntax allows custom display text: [[path|display]]
 * Captures: [1] = path, [2] = optional display text
 */
const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/**
 * Standard markdown links: [text](url)
 * Captures: [1] = display text, [2] = url
 *
 * The URL pattern handles:
 * - Simple URLs without parentheses
 * - URLs with balanced parentheses (e.g., Wikipedia links like /wiki/Test_(example))
 * - URLs with query parameters, fragments, and special characters
 *
 * The regex uses:
 * - (?:[^()\s]|\([^()]*\))+ to match: non-paren/non-space chars OR balanced parens
 */
const MARKDOWN_LINK_PATTERN = /\[([^\]]*)\]\(((?:[^()\s]|\([^()]*\))+)\)/g;

/**
 * Front matter delimiter pattern - matches YAML front matter block
 * Content between opening and closing ---
 */
const FRONT_MATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * URL pattern for detecting external links
 */
const URL_PATTERN = /^https?:\/\//i;

/**
 * Extract the domain from a URL, stripping www. and path
 * @param url - Full URL string
 * @returns Domain name (e.g., "github.com" from "https://www.github.com/user/repo")
 */
export function extractDomain(url: string): string {
	try {
		const parsed = new URL(url);
		let hostname = parsed.hostname;
		// Strip www. prefix
		if (hostname.startsWith('www.')) {
			hostname = hostname.slice(4);
		}
		return hostname;
	} catch {
		// If URL parsing fails, try basic extraction
		const match = url.match(/^https?:\/\/(?:www\.)?([^/]+)/i);
		return match ? match[1] : url;
	}
}

/**
 * Parse simple YAML key-value pairs from front matter content.
 * Handles basic YAML syntax (key: value on each line).
 * Does not handle nested objects or arrays.
 */
function parseFrontMatter(content: string): Record<string, unknown> {
	const match = content.match(FRONT_MATTER_PATTERN);
	if (!match) {
		return {};
	}

	const yamlContent = match[1];
	const result: Record<string, unknown> = {};
	const lines = yamlContent.split('\n');

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		// Match key: value pattern
		const colonIndex = trimmed.indexOf(':');
		if (colonIndex > 0) {
			const key = trimmed.substring(0, colonIndex).trim();
			let value: string | boolean | number = trimmed.substring(colonIndex + 1).trim();

			// Remove surrounding quotes if present
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}

			// Try to parse as boolean or number
			if (value === 'true') {
				result[key] = true;
			} else if (value === 'false') {
				result[key] = false;
			} else if (value !== '' && !isNaN(Number(value))) {
				result[key] = Number(value);
			} else {
				result[key] = value;
			}
		}
	}

	return result;
}

/**
 * Resolve a relative link path to a normalized path
 * @param linkPath - The path from the link (e.g., "../docs/file.md")
 * @param currentFilePath - The path of the file containing the link
 * @returns Normalized relative path from project root, or null if invalid
 */
function resolveRelativePath(linkPath: string, currentFilePath: string): string | null {
	// Guard against null/undefined/non-string inputs
	if (!linkPath || typeof linkPath !== 'string') {
		return null;
	}

	// Skip URLs, anchors, and mailto links
	if (URL_PATTERN.test(linkPath) || linkPath.startsWith('#') || linkPath.startsWith('mailto:')) {
		return null;
	}

	// Get the directory of the current file
	const currentDir = dirname(currentFilePath || '');

	// Decode URL-encoded characters (e.g., %20 -> space)
	// Wrapped in try-catch to handle malformed URL encoding gracefully
	let decodedPath: string;
	try {
		decodedPath = decodeURIComponent(linkPath);
	} catch {
		// If decodeURIComponent fails (malformed encoding like '%ZZ'), use the original path
		decodedPath = linkPath;
	}

	// Join and normalize the path
	let resolved = joinPath(currentDir, decodedPath);

	// Normalize path separators and remove leading ./
	resolved = resolved.replace(/\\/g, '/');
	if (resolved.startsWith('./')) {
		resolved = resolved.slice(2);
	}

	// Ensure it ends with .md if it doesn't have an extension
	if (!extname(resolved)) {
		resolved = resolved + '.md';
	}

	return resolved;
}

/**
 * Parse a markdown file's content to extract links and front matter.
 * Handles malformed markdown gracefully - never throws, always returns a valid result.
 *
 * @param content - The markdown file content
 * @param filePath - The relative path of the file (used to resolve relative links)
 * @returns Parsed links and metadata (empty arrays/object if parsing fails)
 */
export function parseMarkdownLinks(content: string, filePath: string): ParsedMarkdownLinks {
	// Return empty result for null/undefined/non-string content
	if (content === null || content === undefined || typeof content !== 'string') {
		return {
			internalLinks: [],
			externalLinks: [],
			frontMatter: {},
		};
	}

	const internalLinks: string[] = [];
	const externalLinks: ExternalLink[] = [];

	// Parse front matter with error handling
	let frontMatter: Record<string, unknown> = {};
	try {
		frontMatter = parseFrontMatter(content);
	} catch (error) {
		// Log but don't crash - malformed front matter is common
		console.warn(`Failed to parse front matter in ${filePath}:`, error);
		frontMatter = {};
	}

	// Track seen links to avoid duplicates
	const seenInternal = new Set<string>();
	const seenExternal = new Set<string>();

	// Parse wiki-style links: [[path]] or [[path|text]]
	// Wrapped in try-catch to handle regex edge cases
	try {
		let match;
		WIKI_LINK_PATTERN.lastIndex = 0;
		while ((match = WIKI_LINK_PATTERN.exec(content)) !== null) {
			const linkPath = match[1]?.trim();
			if (!linkPath) continue;

			// Skip image embeds (handled separately in graph builder if needed)
			if (linkPath.match(/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/i)) {
				continue;
			}

			// Resolve the path relative to current file
			const resolved = resolveRelativePath(linkPath, filePath);
			if (resolved && !seenInternal.has(resolved)) {
				seenInternal.add(resolved);
				internalLinks.push(resolved);
			}
		}
	} catch (error) {
		// Log wiki link parsing failure but continue with markdown links
		console.warn(`Failed to parse wiki links in ${filePath}:`, error);
	}

	// Parse standard markdown links: [text](url)
	// Wrapped in try-catch to handle regex edge cases
	try {
		let match;
		MARKDOWN_LINK_PATTERN.lastIndex = 0;
		while ((match = MARKDOWN_LINK_PATTERN.exec(content)) !== null) {
			const linkUrl = match[2]?.trim();
			if (!linkUrl) continue;

			// Check if it's an external URL
			if (URL_PATTERN.test(linkUrl)) {
				if (!seenExternal.has(linkUrl)) {
					seenExternal.add(linkUrl);
					externalLinks.push({
						url: linkUrl,
						domain: extractDomain(linkUrl),
					});
				}
			} else {
				// Internal link
				const resolved = resolveRelativePath(linkUrl, filePath);
				if (resolved && !seenInternal.has(resolved)) {
					// Only include markdown files as internal links
					if (resolved.endsWith('.md')) {
						seenInternal.add(resolved);
						internalLinks.push(resolved);
					}
				}
			}
		}
	} catch (error) {
		// Log markdown link parsing failure but return what we have
		console.warn(`Failed to parse markdown links in ${filePath}:`, error);
	}

	return {
		internalLinks,
		externalLinks,
		frontMatter,
	};
}

export default parseMarkdownLinks;

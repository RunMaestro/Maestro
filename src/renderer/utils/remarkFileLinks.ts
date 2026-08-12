/**
 * remarkFileLinks - A remark plugin that transforms file path references into clickable links.
 *
 * Supports multiple patterns:
 * 1. Path-style references: `Folder/Subfolder/File` or `README.md`
 * 2. Wiki-style references (Obsidian): `[[Note Name]]` or `[[Folder/Note]]`
 * 3. Wiki-style with alias: `[[Folder/Note|Display Text]]` - links to Note but shows "Display Text"
 * 4. Absolute paths: `/Users/name/Project/file.md` (converted to relative if within projectRoot)
 * 5. Image embeds (Obsidian): `![[image.png]]` - renders image inline
 * 6. Standard markdown links: `[Display Text](file.md)` - converted to internal links if file exists
 *
 * Links are validated against the provided fileTree before conversion.
 * Uses `maestro-file://` protocol for internal file preview handling.
 */

import { visit } from 'unist-util-visit';
import type { Root, Text, Link, Image } from 'mdast';
import type { FileNode } from '../types/fileTree';
import {
	buildFileTreeIndices,
	findClosestMatch as findClosestMatchCore,
	toRelativePath as toRelativePathCore,
	validatePathReference as validatePathReferenceCore,
	type FileTreeIndices,
} from './fileLinks/matcher';
import {
	ABSOLUTE_PATH_PATTERN,
	IMAGE_EMBED_PATTERN,
	INLINE_CODE_EXT_PATTERN,
	MAESTRO_DEEP_LINK_PATTERN,
	PATH_PATTERN,
	TILDE_PATH_PATTERN,
	WIKI_LINK_PATTERN,
} from './fileLinks/patterns';

// Re-export the shared core so existing callers don't need to learn a new
// import path. New code should import from `./fileLinks/matcher` directly.
export { buildFileTreeIndices };
export type { FileTreeIndices };

export interface RemarkFileLinksOptions {
	/** The file tree to validate paths against (used if indices not provided) */
	fileTree?: FileNode[];
	/** Pre-built indices for O(1) lookups - pass this to avoid rebuilding on every render */
	indices?: FileTreeIndices;
	/** Current working directory for proximity-based matching (relative path) */
	cwd: string;
	/** Project root absolute path - used to convert absolute paths to relative */
	projectRoot?: string;
	/** User's home directory (e.g. /Users/pedram) - used to expand ~/... paths */
	homeDir?: string;
}

/**
 * The remark plugin
 */
export function remarkFileLinks(options: RemarkFileLinksOptions) {
	const { fileTree, indices, cwd, projectRoot, homeDir } = options;

	// Resolve indices: prefer pre-built (caller memoized), build from fileTree
	// as a fallback, or use empty indices when neither is provided.
	const resolvedIndices: FileTreeIndices = indices
		? indices
		: fileTree
			? buildFileTreeIndices(fileTree)
			: { allPaths: new Set(), filenameIndex: new Map() };

	// Bind helpers that close over the resolved indices/projectRoot so call
	// sites read like the original (which had locals in scope).
	const findClosestMatch = (reference: string) =>
		findClosestMatchCore(reference, resolvedIndices, cwd);
	const validatePathReference = (reference: string) =>
		validatePathReferenceCore(reference, resolvedIndices);
	const toRelativePath = (absPath: string) => toRelativePathCore(absPath, projectRoot);
	const allPaths = resolvedIndices.allPaths;

	return (tree: Root) => {
		visit(tree, 'text', (node: Text, index, parent) => {
			if (!parent || index === undefined) return;

			// Skip text nodes inside link nodes - the link visitor handles those
			if (parent.type === 'link') return;

			const text = node.value;
			const replacements: (Text | Link | Image)[] = [];
			let lastIndex = 0;

			// Combined processing - collect all matches with their positions
			interface Match {
				start: number;
				end: number;
				display: string;
				resolvedPath: string;
				type: 'link' | 'image';
				isRelativeToCwd?: boolean; // For images: true if path needs cwd prepended (fallback paths)
				isFromFileTree?: boolean; // For images: true if path was found in file tree (complete from project root)
				imageWidth?: number; // For images: optional width in pixels
				absoluteUrl?: string; // For links outside projectRoot: use file:// URL instead of maestro-file://
			}
			const matches: Match[] = [];

			// Find bare maestro:// deep link URLs so they auto-linkify in plain text.
			let deepLinkMatch;
			MAESTRO_DEEP_LINK_PATTERN.lastIndex = 0;
			while ((deepLinkMatch = MAESTRO_DEEP_LINK_PATTERN.exec(text)) !== null) {
				const url = deepLinkMatch[0];
				matches.push({
					start: deepLinkMatch.index,
					end: deepLinkMatch.index + url.length,
					display: url,
					resolvedPath: url,
					type: 'link',
					absoluteUrl: url,
				});
			}

			// Find image embeds (before wiki-links, since ![[...]] contains [[...]])
			let imageMatch;
			IMAGE_EMBED_PATTERN.lastIndex = 0;
			while ((imageMatch = IMAGE_EMBED_PATTERN.exec(text)) !== null) {
				const imagePath = imageMatch[1];
				const widthStr = imageMatch[2]; // Optional width (e.g., "300")
				const imageWidth = widthStr ? parseInt(widthStr, 10) : undefined;

				// Try to find the image in the file tree first
				const foundPath = findClosestMatch(imagePath);

				// If not found in file tree, try common Obsidian attachment locations
				// Obsidian stores attachments relative to the current document, typically in:
				// 1. _attachments/ subfolder next to the document
				// 2. attachments/ subfolder
				// 3. Same folder as the document
				let resolvedPath: string;
				let isRelativeToCwd = false; // Track if path needs cwd prepended

				let isFromFileTree = false;

				if (foundPath) {
					// Found in file tree - path is already complete from project root
					resolvedPath = foundPath;
					isFromFileTree = true;
				} else {
					// Not found - use _attachments fallback relative to current document
					resolvedPath = `_attachments/${imagePath}`;
					isRelativeToCwd = true; // This path is relative to cwd
				}

				matches.push({
					start: imageMatch.index,
					end: imageMatch.index + imageMatch[0].length,
					display: imagePath,
					resolvedPath,
					type: 'image',
					isRelativeToCwd,
					isFromFileTree,
					imageWidth,
				});
			}

			// Find wiki-style links
			let wikiMatch;
			WIKI_LINK_PATTERN.lastIndex = 0;
			while ((wikiMatch = WIKI_LINK_PATTERN.exec(text)) !== null) {
				const reference = wikiMatch[1]; // The path part
				const displayText = wikiMatch[2]; // Optional display text after |

				// Skip if already inside an image embed match
				const isInsideExisting = matches.some(
					(m) => wikiMatch!.index >= m.start && wikiMatch!.index < m.end
				);
				if (isInsideExisting) continue;

				const resolvedPath = findClosestMatch(reference);

				if (resolvedPath) {
					matches.push({
						start: wikiMatch.index,
						end: wikiMatch.index + wikiMatch[0].length,
						// Use display text if provided, otherwise use the reference
						display: displayText || reference,
						resolvedPath,
						type: 'link',
					});
				}
			}

			// Find absolute path references (e.g., /Users/pedram/Project/file.md)
			if (projectRoot) {
				let absMatch;
				ABSOLUTE_PATH_PATTERN.lastIndex = 0;
				while ((absMatch = ABSOLUTE_PATH_PATTERN.exec(text)) !== null) {
					const absolutePath = absMatch[0];

					// Skip if already inside another match
					const isInsideExisting = matches.some(
						(m) => absMatch!.index >= m.start && absMatch!.index < m.end
					);
					if (isInsideExisting) continue;

					// Convert to relative path
					const relativePath = toRelativePath(absolutePath);
					// For absolute paths within projectRoot, always create a link even if not in file tree
					// The file click handler will attempt to open the file from disk
					if (relativePath) {
						matches.push({
							start: absMatch.index,
							end: absMatch.index + absMatch[0].length,
							display: absolutePath,
							resolvedPath: relativePath,
							type: 'link',
						});
					}
				}
			}

			// Find tilde path references (e.g., ~/Downloads/audio/file.wav)
			if (homeDir) {
				let tildeMatch;
				TILDE_PATH_PATTERN.lastIndex = 0;
				while ((tildeMatch = TILDE_PATH_PATTERN.exec(text)) !== null) {
					const tildePath = tildeMatch[0];

					// Skip if already inside another match
					const isInsideExisting = matches.some(
						(m) => tildeMatch!.index >= m.start && tildeMatch!.index < m.end
					);
					if (isInsideExisting) continue;

					// Expand ~ to home directory
					const absolutePath = homeDir + tildePath.slice(1);

					// If within projectRoot, convert to relative maestro-file:// link
					const relativePath = toRelativePath(absolutePath);
					if (relativePath) {
						matches.push({
							start: tildeMatch.index,
							end: tildeMatch.index + tildePath.length,
							display: tildePath,
							resolvedPath: relativePath,
							type: 'link',
						});
					} else {
						// Outside projectRoot - use file:// URL to open in system default app
						matches.push({
							start: tildeMatch.index,
							end: tildeMatch.index + tildePath.length,
							display: tildePath,
							resolvedPath: absolutePath,
							type: 'link',
							absoluteUrl: `file://${absolutePath}`,
						});
					}
				}
			}

			// Find path-style references (relative paths)
			let pathMatch;
			PATH_PATTERN.lastIndex = 0;
			while ((pathMatch = PATH_PATTERN.exec(text)) !== null) {
				const reference = pathMatch[0];

				// Skip if already inside another match
				const isInsideExisting = matches.some(
					(m) => pathMatch!.index >= m.start && pathMatch!.index < m.end
				);
				if (isInsideExisting) continue;

				const resolvedPath = validatePathReference(reference);

				if (resolvedPath) {
					matches.push({
						start: pathMatch.index,
						end: pathMatch.index + pathMatch[0].length,
						display: reference,
						resolvedPath,
						type: 'link',
					});
				}
			}

			// Sort matches by position
			matches.sort((a, b) => a.start - b.start);

			// No matches, nothing to do
			if (matches.length === 0) return;

			// Build replacement nodes
			for (const match of matches) {
				// Add text before this match
				if (match.start > lastIndex) {
					replacements.push({
						type: 'text',
						value: text.slice(lastIndex, match.start),
					});
				}

				if (match.type === 'image') {
					// Add image node - construct file:// URL for the image
					// For AI terminal (has projectRoot): build absolute file:// URL
					// For FilePreview (no projectRoot): use relative path (resolveImagePath handles it)
					let imageSrc: string;
					if (projectRoot) {
						// Build full path:
						// - If isRelativeToCwd (fallback path), need: projectRoot + cwd + resolvedPath
						// - If from file tree (already full relative path), need: projectRoot + resolvedPath
						let fullPath: string;
						if (match.isRelativeToCwd && cwd) {
							fullPath = `${projectRoot}/${cwd}/${match.resolvedPath}`;
						} else {
							fullPath = `${projectRoot}/${match.resolvedPath}`;
						}
						imageSrc = `file://${fullPath}`;
					} else {
						// Relative path - FilePreview's resolveImagePath will resolve from markdown file location
						imageSrc = match.resolvedPath;
					}
					// Build style string - use specified width or default to max-width: 100%
					const imageStyle = match.imageWidth
						? `width: ${match.imageWidth}px; height: auto;`
						: 'max-width: 100%; height: auto;';

					replacements.push({
						type: 'image',
						url: imageSrc,
						alt: match.display,
						data: {
							hProperties: {
								'data-maestro-image': match.resolvedPath,
								'data-maestro-width': match.imageWidth?.toString(),
								'data-maestro-from-tree': match.isFromFileTree ? 'true' : undefined,
								style: imageStyle,
							},
						},
					} as Image);
				} else if (match.absoluteUrl) {
					// External file link (outside projectRoot) - use file:// URL
					// MarkdownRenderer's <a> handler calls shell.openPath for file:// URLs
					replacements.push({
						type: 'link',
						url: match.absoluteUrl,
						children: [{ type: 'text', value: match.display }],
					});
				} else {
					// Add the link - use data-hProperties to pass the file path as a data attribute
					// This survives rehype processing which may strip custom protocols from href
					replacements.push({
						type: 'link',
						url: `maestro-file://${match.resolvedPath}`,
						data: {
							hProperties: {
								'data-maestro-file': match.resolvedPath,
							},
						},
						children: [{ type: 'text', value: match.display }],
					});
				}

				lastIndex = match.end;
			}

			// Add remaining text
			if (lastIndex < text.length) {
				replacements.push({
					type: 'text',
					value: text.slice(lastIndex),
				});
			}

			// Replace the node with our new nodes
			parent.children.splice(index, 1, ...replacements);

			// Return the index to continue from (skip the nodes we just inserted)
			return index + replacements.length;
		});

		// Also process inlineCode nodes - paths wrapped in backticks
		visit(tree, 'inlineCode', (node: any, index, parent) => {
			if (!parent || index === undefined) return;

			// Skip inline code inside link nodes - the link visitor handles those
			if (parent.type === 'link') return;

			const code = node.value;

			// Check if this inline code is a file path
			// First try wiki-style
			const wikiMatch = code.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
			if (wikiMatch) {
				const reference = wikiMatch[1];
				const displayText = wikiMatch[2];
				const resolvedPath = findClosestMatch(reference);
				if (resolvedPath) {
					const link: Link = {
						type: 'link',
						url: `maestro-file://${resolvedPath}`,
						data: {
							hProperties: {
								'data-maestro-file': resolvedPath,
							},
						},
						children: [{ type: 'text', value: displayText || reference }],
					};
					parent.children.splice(index, 1, link);
					return index + 1;
				}
			}

			// Check for absolute path
			if (projectRoot && code.startsWith('/')) {
				// Check if it has a valid file extension
				const extMatch = code.match(INLINE_CODE_EXT_PATTERN);
				if (extMatch) {
					const relativePath = toRelativePath(code);
					if (relativePath) {
						// Extract just the filename for display
						const filename = code.split('/').pop() || code;
						const link: Link = {
							type: 'link',
							url: `maestro-file://${relativePath}`,
							data: {
								hProperties: {
									'data-maestro-file': relativePath,
								},
							},
							children: [{ type: 'text', value: filename }],
						};
						parent.children.splice(index, 1, link);
						return index + 1;
					}
				}
			}

			// Check for tilde path (e.g., ~/Downloads/file.wav)
			if (homeDir && code.startsWith('~/')) {
				const extMatch = code.match(INLINE_CODE_EXT_PATTERN);
				if (extMatch) {
					const absolutePath = homeDir + code.slice(1);
					const relativePath = toRelativePath(absolutePath);
					const filename = code.split('/').pop() || code;
					if (relativePath) {
						const link: Link = {
							type: 'link',
							url: `maestro-file://${relativePath}`,
							data: {
								hProperties: {
									'data-maestro-file': relativePath,
								},
							},
							children: [{ type: 'text', value: filename }],
						};
						parent.children.splice(index, 1, link);
						return index + 1;
					} else {
						// Outside projectRoot - open via file:// URL
						const link: Link = {
							type: 'link',
							url: `file://${absolutePath}`,
							children: [{ type: 'text', value: filename }],
						};
						parent.children.splice(index, 1, link);
						return index + 1;
					}
				}
			}

			// Check for relative path (with slash or valid extension)
			const hasSlash = code.includes('/') && !code.includes('://');
			const hasValidExt = INLINE_CODE_EXT_PATTERN.test(code);
			if ((hasSlash || hasValidExt) && allPaths.has(code)) {
				const filename = code.split('/').pop() || code;
				const link: Link = {
					type: 'link',
					url: `maestro-file://${code}`,
					data: {
						hProperties: {
							'data-maestro-file': code,
						},
					},
					children: [{ type: 'text', value: filename }],
				};
				parent.children.splice(index, 1, link);
				return index + 1;
			}
		});

		// Process existing link nodes - convert relative file references to maestro-file:// protocol
		// This handles standard markdown links like [Kira Systems](Kira Systems.md)
		visit(tree, 'link', (node: Link) => {
			const href = node.url;

			// Skip if already processed, external URL, deep link, or anchor link
			if (
				!href ||
				href.startsWith('maestro-file://') ||
				href.startsWith('maestro://') ||
				href.startsWith('http://') ||
				href.startsWith('https://') ||
				href.startsWith('mailto:') ||
				href.startsWith('#') ||
				href.startsWith('file://')
			) {
				return;
			}

			// Decode URL-encoded characters (e.g., %20 -> space)
			const decodedHref = decodeURIComponent(href);

			let resolvedPath: string | null = null;

			// Handle absolute paths first - agents (e.g. Codex) emit [file.tsx](/Users/name/Project/src/file.tsx)
			// These should be resolved directly, not searched via filename index
			if (projectRoot && decodedHref.startsWith('/')) {
				resolvedPath = toRelativePath(decodedHref);
			}

			// Handle tilde paths (e.g., [file](~/Projects/file.tsx))
			if (!resolvedPath && homeDir && decodedHref.startsWith('~/')) {
				const absolutePath = homeDir + decodedHref.slice(1);
				const relativePath = toRelativePath(absolutePath);
				if (relativePath) {
					resolvedPath = relativePath;
				} else {
					// Outside projectRoot - use file:// URL
					node.url = `file://${absolutePath}`;
					return;
				}
			}

			// Fall back to file tree search for relative references
			if (!resolvedPath) {
				resolvedPath = findClosestMatch(decodedHref);
			}

			if (resolvedPath) {
				// Convert to maestro-file:// protocol
				node.url = `maestro-file://${resolvedPath}`;
				// Add data attribute for fallback (in case rehype strips custom protocols)
				node.data = node.data || {};
				(node.data as any).hProperties = {
					...((node.data as any).hProperties || {}),
					'data-maestro-file': resolvedPath,
				};
			}
		});
	};
}

export default remarkFileLinks;

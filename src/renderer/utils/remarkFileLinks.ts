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
import { buildFileIndex as buildFileIndexShared, type FilePathEntry } from '../../shared/treeUtils';

/**
 * Pre-built indices for file tree lookups.
 * Build these once with buildFileTreeIndices() and reuse across renders.
 */
export interface FileTreeIndices {
	/** Set of all relative paths in the tree */
	allPaths: Set<string>;
	/** Map from filename to array of paths containing that filename */
	filenameIndex: Map<string, string[]>;
}

export interface RemarkFileLinksOptions {
	/** The file tree to validate paths against (used if indices not provided) */
	fileTree?: FileNode[];
	/** Pre-built indices for O(1) lookups - pass this to avoid rebuilding on every render */
	indices?: FileTreeIndices;
	/** Current working directory for proximity-based matching (relative path) */
	cwd: string;
	/** Project root absolute path - used to convert absolute paths to relative */
	projectRoot?: string;
}

/**
 * Build file tree indices for use with remarkFileLinks.
 * Call this once when fileTree changes and pass the result to remarkFileLinks.
 * This avoids O(n) tree traversal on every markdown render.
 */
export function buildFileTreeIndices(fileTree: FileNode[]): FileTreeIndices {
	const fileEntries = buildFileIndex(fileTree);
	const allPaths = new Set(fileEntries.map((e) => e.relativePath));
	const filenameIndex = buildFilenameIndex(fileEntries);
	return { allPaths, filenameIndex };
}

/**
 * Build a flat index of all files in the tree for quick lookup
 * @see {@link buildFileIndexShared} from shared/treeUtils for the underlying implementation
 */
function buildFileIndex(nodes: FileNode[], currentPath = ''): FilePathEntry[] {
	return buildFileIndexShared(nodes, currentPath);
}

/**
 * Build a filename -> paths map for quick wiki-link lookup
 */
function buildFilenameIndex(entries: FilePathEntry[]): Map<string, string[]> {
	const index = new Map<string, string[]>();

	for (const entry of entries) {
		// Index by filename (with and without .md extension)
		const paths = index.get(entry.filename) || [];
		paths.push(entry.relativePath);
		index.set(entry.filename, paths);

		// Also index without .md extension for convenience
		if (entry.filename.endsWith('.md')) {
			const withoutExt = entry.filename.slice(0, -3);
			const pathsNoExt = index.get(withoutExt) || [];
			pathsNoExt.push(entry.relativePath);
			index.set(withoutExt, pathsNoExt);
		}
	}

	return index;
}

/**
 * Calculate path proximity - how "close" a file path is to the cwd
 * Lower score = closer
 */
function calculateProximity(filePath: string, cwd: string): number {
	const fileSegments = filePath.split('/');
	const cwdSegments = cwd.split('/').filter(Boolean);

	// Find common prefix length
	let commonLength = 0;
	for (let i = 0; i < Math.min(fileSegments.length, cwdSegments.length); i++) {
		if (fileSegments[i] === cwdSegments[i]) {
			commonLength++;
		} else {
			break;
		}
	}

	// Score = steps up from cwd + steps down to file
	const stepsUp = cwdSegments.length - commonLength;
	const stepsDown = fileSegments.length - commonLength;

	return stepsUp + stepsDown;
}

/**
 * Find the closest matching path for a wiki-style reference
 */
function findClosestMatch(
	reference: string,
	filenameIndex: Map<string, string[]>,
	allPaths: Set<string>,
	cwd: string
): string | null {
	// First, try exact path match
	if (allPaths.has(reference)) {
		return reference;
	}

	// Try with .md extension
	if (allPaths.has(`${reference}.md`)) {
		return `${reference}.md`;
	}

	// Extract filename from reference (in case it includes a partial path)
	const refParts = reference.split('/');
	const filename = refParts[refParts.length - 1];

	// Look up by filename
	let candidates = filenameIndex.get(filename) || [];

	// Also try with .md appended
	if (candidates.length === 0 && !filename.endsWith('.md')) {
		candidates = filenameIndex.get(`${filename}.md`) || [];
	}

	if (candidates.length === 0) {
		return null;
	}

	if (candidates.length === 1) {
		return candidates[0];
	}

	// Multiple matches - filter by partial path if provided
	if (refParts.length > 1) {
		const partialPath = reference;
		const filtered = candidates.filter(
			(c) => c.endsWith(partialPath) || c.endsWith(`${partialPath}.md`)
		);
		if (filtered.length === 1) {
			return filtered[0];
		}
		if (filtered.length > 1) {
			candidates = filtered;
		}
	}

	// Pick closest to cwd
	let closest = candidates[0];
	let closestScore = calculateProximity(candidates[0], cwd);

	for (let i = 1; i < candidates.length; i++) {
		const score = calculateProximity(candidates[i], cwd);
		if (score < closestScore) {
			closestScore = score;
			closest = candidates[i];
		}
	}

	return closest;
}

/**
 * Check if a path-style reference is valid
 */
function validatePathReference(reference: string, allPaths: Set<string>): string | null {
	// Try exact match
	if (allPaths.has(reference)) {
		return reference;
	}

	// Try with .md extension
	if (allPaths.has(`${reference}.md`)) {
		return `${reference}.md`;
	}

	return null;
}

// Regex patterns
// Image embed: ![[image.png]] or ![[folder/image.png]] or ![[image.png|300]] (with width)
// Must have image extension (png, jpg, jpeg, gif, webp, svg, bmp, ico)
// Optional |width syntax for sizing (e.g., |300 means 300px width)
const IMAGE_EMBED_PATTERN =
	/!\[\[([^\]|]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|ico))(?:\|(\d+))?\]\]/gi;

// Wiki-style: [[Note Name]] or [[Folder/Note]] or [[Folder/Note|Display Text]]
// The pipe syntax allows custom display text: [[path|display]]
const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

// Path-style: Must contain a slash OR end with common file extensions
// Avoid matching URLs (no :// prefix)
const PATH_PATTERN =
	/(?<![:\w])(?:(?:[A-Za-z0-9_-]+\/)+[A-Za-z0-9_.-]+|[A-Za-z0-9_-]+\.(?:md|txt|json|yaml|yml|toml|ts|tsx|js|jsx|py|rb|go|rs|java|c|cpp|h|hpp|css|scss|html|xml|sh|bash|zsh))(?![:\w/])/g;

// Absolute path pattern: Starts with / and contains path segments
// Matches paths like /Users/pedram/Project/file.md or /home/user/docs/note.txt
// Must end with a file extension to avoid matching arbitrary paths
// Supports spaces, unicode, emoji, and special characters in path segments
// Lookahead allows: whitespace, end of string, or common punctuation (including period, backtick)
const ABSOLUTE_PATH_PATTERN =
	/\/(?:[^/\n]+\/)+[^/\n]+\.(?:md|txt|json|yaml|yml|toml|ts|tsx|js|jsx|py|rb|go|rs|java|c|cpp|h|hpp|css|scss|html|xml|sh|bash|zsh)(?=\s|$|[.,;:!?`'")\]}>])/g;

/**
 * The remark plugin
 */
export function remarkFileLinks(options: RemarkFileLinksOptions) {
	const { fileTree, indices, cwd, projectRoot } = options;

	// Use pre-built indices if provided, otherwise build them (fallback for backwards compatibility)
	let allPaths: Set<string>;
	let filenameIndex: Map<string, string[]>;

	if (indices) {
		// Use pre-built indices - O(1) access
		allPaths = indices.allPaths;
		filenameIndex = indices.filenameIndex;
	} else if (fileTree) {
		// Fallback: build indices from fileTree - O(n) traversal
		const fileEntries = buildFileIndex(fileTree);
		allPaths = new Set(fileEntries.map((e) => e.relativePath));
		filenameIndex = buildFilenameIndex(fileEntries);
	} else {
		// No file tree data provided - use empty indices
		allPaths = new Set();
		filenameIndex = new Map();
	}

	// Helper to convert absolute path to relative path
	const toRelativePath = (absPath: string): string | null => {
		if (!projectRoot) return null;
		// Normalize projectRoot to not have trailing slash
		const root = projectRoot.endsWith('/') ? projectRoot.slice(0, -1) : projectRoot;
		if (absPath.startsWith(root + '/')) {
			return absPath.slice(root.length + 1);
		}
		return null;
	};

	return (tree: Root) => {
		visit(tree, 'text', (node: Text, index, parent) => {
			if (!parent || index === undefined) return;

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
			}
			const matches: Match[] = [];

			// Find image embeds first (before wiki-links, since ![[...]] contains [[...]])
			let imageMatch;
			IMAGE_EMBED_PATTERN.lastIndex = 0;
			while ((imageMatch = IMAGE_EMBED_PATTERN.exec(text)) !== null) {
				const imagePath = imageMatch[1];
				const widthStr = imageMatch[2]; // Optional width (e.g., "300")
				const imageWidth = widthStr ? parseInt(widthStr, 10) : undefined;

				// Try to find the image in the file tree first
				const foundPath = findClosestMatch(imagePath, filenameIndex, allPaths, cwd);

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

				const resolvedPath = findClosestMatch(reference, filenameIndex, allPaths, cwd);

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

				const resolvedPath = validatePathReference(reference, allPaths);

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

			const code = node.value;

			// Check if this inline code is a file path
			// First try wiki-style
			const wikiMatch = code.match(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/);
			if (wikiMatch) {
				const reference = wikiMatch[1];
				const displayText = wikiMatch[2];
				const resolvedPath = findClosestMatch(reference, filenameIndex, allPaths, cwd);
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
				const extMatch = code.match(
					/\.(?:md|txt|json|yaml|yml|toml|ts|tsx|js|jsx|py|rb|go|rs|java|c|cpp|h|hpp|css|scss|html|xml|sh|bash|zsh)$/i
				);
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

			// Check for relative path (with slash or valid extension)
			const hasSlash = code.includes('/') && !code.includes('://');
			const hasValidExt =
				/\.(?:md|txt|json|yaml|yml|toml|ts|tsx|js|jsx|py|rb|go|rs|java|c|cpp|h|hpp|css|scss|html|xml|sh|bash|zsh)$/i.test(
					code
				);
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

			// Skip if already processed, external URL, or anchor link
			if (
				!href ||
				href.startsWith('maestro-file://') ||
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

			// Try to resolve the reference as a file path
			const resolvedPath = findClosestMatch(decodedHref, filenameIndex, allPaths, cwd);

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

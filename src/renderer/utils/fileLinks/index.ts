/**
 * Public surface of the shared file-link core.
 *
 * Both the Rich path (`remarkFileLinks`) and the Fast path
 * (`markdownItAdapter`) reuse the same matcher + patterns + tree-indices -
 * the barrel makes the contract obvious: consumers import the shapes and
 * helpers they need without deep paths.
 *
 * Add new exports here only when they're part of the public contract;
 * tier-internal helpers should stay deep-imported.
 */

export {
	buildFileTreeIndices,
	calculateProximity,
	findClosestMatch,
	toRelativePath,
	validatePathReference,
	type FileTreeIndices,
} from './matcher';

export {
	ABSOLUTE_PATH_PATTERN,
	IMAGE_EMBED_PATTERN,
	INLINE_CODE_EXT_PATTERN,
	LINKABLE_EXTENSIONS,
	PATH_PATTERN,
	TILDE_PATH_PATTERN,
	WIKI_LINK_PATTERN,
} from './patterns';

export { applyFileLinks, type MarkdownItFileLinksOptions } from './markdownItAdapter';

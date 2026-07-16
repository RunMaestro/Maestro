/**
 * Shared regex patterns for detecting file references in markdown text.
 *
 * Lives in its own module so both the Rich-path remark plugin and the
 * Fast-tier markdown-it adapter use IDENTICAL regexes. Drift here would
 * cause subtle parity bugs ("works in small files, broken in big ones").
 */

/**
 * File extensions we recognize as link targets. Includes code, configs,
 * docs, media, data, and archive formats. Lowercase only - callers must
 * use case-insensitive matching.
 */
export const LINKABLE_EXTENSIONS =
	'md|txt|json|yaml|yml|toml|ts|tsx|js|jsx|py|rb|go|rs|java|c|cpp|h|hpp|css|scss|html|xml|sh|bash|zsh' +
	'|pdf|csv|tsv|sql|log|diff|patch|env|ini|cfg|conf|lock|makefile' +
	'|wav|mp3|flac|aac|ogg|m4a|mp4|mkv|avi|mov|webm' +
	'|zip|tar|gz|rar|7z' +
	'|doc|docx|xls|xlsx|ppt|pptx|rtf';

/**
 * Obsidian-style image embed: `![[image.png]]` or `![[folder/image.png]]`
 * optionally suffixed with `|width` for sizing (e.g. `|300` = 300px).
 * Only matches paths ending with a recognized image extension.
 */
export const IMAGE_EMBED_PATTERN =
	/!\[\[([^\]|]+\.(?:png|jpg|jpeg|gif|webp|svg|bmp|ico))(?:\|(\d+))?\]\]/gi;

/**
 * Obsidian-style wiki link: `[[Note]]` or `[[Folder/Note]]` or
 * `[[Folder/Note|Display Text]]` (pipe = optional display alias).
 */
export const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/**
 * Relative path reference: `Folder/Subfolder/file.md` or `file.md`. Must
 * contain a slash OR end with a recognized extension. Negative lookbehind
 * `(?<![:\w])` and lookahead avoid matching URLs or words.
 *
 * The final filename segment is constrained to either `name.ext` (with a
 * recognized extension) or a bare `name` (only when preceded by at least
 * one folder segment, the wiki-link-style path). This prevents the greedy
 * `[A-Za-z0-9_.-]+` of older versions from swallowing a sentence-ending
 * period - e.g. in `See src/utils/helpers.ts.` we now match exactly
 * `src/utils/helpers.ts` instead of `src/utils/helpers.ts.`.
 */
export const PATH_PATTERN = new RegExp(
	`(?<![:\\w])(?:(?:[A-Za-z0-9_-]+\\/)+(?:[A-Za-z0-9_-]+\\.(?:${LINKABLE_EXTENSIONS})|[A-Za-z0-9_-]+)|[A-Za-z0-9_-]+\\.(?:${LINKABLE_EXTENSIONS}))(?![:\\w/])`,
	'gi'
);

/**
 * Absolute filesystem path: `/Users/name/Project/file.md`. Must end with
 * a recognized file extension. Lookahead allows whitespace, end-of-string,
 * or common punctuation as terminator. Case-insensitive so `.MD` / `.Ts`
 * still match the lowercase-only LINKABLE_EXTENSIONS list.
 */
export const ABSOLUTE_PATH_PATTERN = new RegExp(
	`\\/(?:[^/\\n]+\\/)+[^/\\n]+\\.(?:${LINKABLE_EXTENSIONS})(?=\\s|$|[.,;:!?\`'"\\)\\]}>])`,
	'gi'
);

/**
 * Tilde-expanded path: `~/Documents/note.md`. Same shape as absolute path
 * but rooted at the user's home directory; resolution requires homeDir.
 * Case-insensitive - see ABSOLUTE_PATH_PATTERN above.
 */
export const TILDE_PATH_PATTERN = new RegExp(
	`~\\/(?:[^\\s/]+\\/)*[^\\s/]+\\.(?:${LINKABLE_EXTENSIONS})(?=\\s|$|[.,;:!?\`'"\\)\\]}>])`,
	'gi'
);

/** Anchored extension check for inline-code path validation. */
export const INLINE_CODE_EXT_PATTERN = new RegExp(`\\.(?:${LINKABLE_EXTENSIONS})$`, 'i');

/**
 * Bare `maestro://` deep link URL embedded in text. Matches URL-safe chars
 * and only consumes `.` when followed by more URL chars, so sentence-ending
 * punctuation (e.g. `… maestro://session/abc.`) is left out of the match.
 * Used to auto-linkify in-app navigation URLs (e.g.
 * `maestro://session/<id>/tab/<id>`) so they become clickable in rendered
 * markdown.
 */
export const MAESTRO_DEEP_LINK_PATTERN =
	/maestro:\/\/[A-Za-z0-9_\-/?&=%]+(?:\.[A-Za-z0-9_\-/?&=%]+)*/g;

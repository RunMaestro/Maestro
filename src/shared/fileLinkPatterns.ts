/**
 * Shared regex patterns for detecting file references in markdown text.
 *
 * Lives in its own module so both the Rich-path remark plugin and the
 * Fast-tier markdown-it adapter use IDENTICAL regexes. Drift here would
 * cause subtle parity bugs ("works in small files, broken in big ones").
 *
 * Lives in `src/shared/` (not the renderer) so the main-process Dataview
 * index extracts the same wiki links and embeds the preview renders. The
 * patterns carry the `g` flag: reset `lastIndex` before reusing one.
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
 *
 * Segments admit spaces (`/Users/me/Meeting Notes/a.md` is a real path), which
 * is exactly what lets a careless pattern swallow prose: the leftmost `/` in a
 * paragraph plus the last `name.md` in it reads as one "path", and clicking it
 * sent a whole paragraph to `fs:stat` (ENAMETOOLONG, MAESTRO-176 / MAESTRO-16F).
 * Five rules keep a match on one path:
 *  - the first segment (the root directory) holds no whitespace. No root
 *    directory on any platform we ship has a space in its name (`/Users`,
 *    `/Volumes`, `/home`, `/tmp`), while a slash command in prose does
 *    (`/maestro-build command so that ... example.com/a/b.zip`). Spaces stay
 *    legal below the root (`/Volumes/My Drive/a.md`);
 *  - it starts at a token boundary, never inside a word (`C/bozze/x.md`,
 *    `and/or`), in any script that separates words with spaces. Chinese and
 *    Japanese do not, so a path written straight after a Han, Hiragana or
 *    Katakana character (`これは/Users/me/a.md`) still starts there;
 *  - no segment starts or ends with whitespace, so prose that runs into a
 *    later path (`Read /handoff notes in /Users/me/a.md`) is not read as a
 *    directory: ` /` is where a sentence meets a path, not a folder name;
 *  - no segment holds a sentence break (`.`, `;`, `!` or `?` followed by
 *    whitespace, or a fullwidth `。！？；`), which a directory or file name
 *    essentially never does;
 *  - no segment exceeds 255 characters, the NAME_MAX of every platform we ship.
 * The match ends at the FIRST file name that closes a path. The directory
 * run is lazy (`/a/SKILL.md and refs/b.md` stops at `SKILL.md`), and the file
 * name may not run past a `.ext` that already ends one, i.e. one followed by
 * whitespace or closing punctuation (`/a/first.md and second.md` and
 * `/a/b.md, then c.md` stop at the first `.md`). A following `.` is not such
 * an ending, so `/a/archive.tar.gz` keeps its full name.
 * That is a deliberate tradeoff: a real folder or file whose name holds a
 * file name and a space (`/a/node.js backup/b.md`) is the same text as that
 * prose, and stops at `/a/node.js` too. Stopping early is the safer error.
 *
 * A match with whitespace in it is still only the pattern's guess, so
 * remarkFileLinks links it only once the file is confirmed to exist (its
 * `pathExists` option, backed by `pathExistence.ts`).
 */
/** The root directory: no whitespace at all, and no fullwidth sentence break. */
const ABSOLUTE_PATH_ROOT_SEGMENT = `(?:(?![。！？；])[^/\\s]){1,255}`;
const ABSOLUTE_PATH_SEGMENT = `(?!\\s)(?:(?![.;!?]\\s|[。！？；])[^/\\n]){1,255}(?<!\\s)`;
/** The final segment: the same, but it may not run past a `.ext` that already ends a path. */
const ABSOLUTE_PATH_FILE_SEGMENT = `(?!\\s)(?:(?!\\.(?:${LINKABLE_EXTENSIONS})(?:\\s|[,;:!?\`'"\\)\\]}>])|[.;!?]\\s|[。！？；])[^/\\n]){1,255}(?<!\\s)`;
/** A word character, except in the scripts written without spaces between words. */
const SPACED_WORD_CHAR = `(?![\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}])[\\p{L}\\p{N}_]`;
export const ABSOLUTE_PATH_PATTERN = new RegExp(
	`(?<!${SPACED_WORD_CHAR})\\/${ABSOLUTE_PATH_ROOT_SEGMENT}\\/(?:${ABSOLUTE_PATH_SEGMENT}\\/)*?${ABSOLUTE_PATH_FILE_SEGMENT}\\.(?:${LINKABLE_EXTENSIONS})(?=\\s|$|[.,;:!?\`'"\\)\\]}>])`,
	'giu'
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

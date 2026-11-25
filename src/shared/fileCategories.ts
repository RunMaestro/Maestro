/**
 * File Category Classification
 *
 * One extension table answering two related questions that were previously
 * answered by private sets inside `FileSearchModal`:
 *
 *   1. "Can Maestro open this file at all?" (`isPreviewableFile`)
 *   2. "Which bucket does it belong to?" (`getFileCategory`)
 *
 * Both answers come from the SAME table on purpose. A file that classifies
 * into a category but is not previewable would show up under a filter pill and
 * then refuse to open; a previewable file with no category would be reachable
 * only through `All` and invisible everywhere else. Deriving one from the other
 * makes both failures impossible: every previewable file has exactly one
 * category, and every categorized file is previewable.
 *
 * A separate table answers a third question, "would the OS run this if asked
 * to open it?" (`isLaunchableFile`), for the open path's launch guard.
 *
 * Audio and video are NOT listed here - they come from `mediaTypes.ts`, which
 * is the single source of truth for what Chromium can actually decode. A second
 * copy would eventually list a container the player cannot open.
 *
 * Lives in `shared/` (no Electron or React imports) so the CLI and main process
 * can classify a path without pulling in the renderer.
 */

import { getMediaKind } from './mediaTypes';
import { isWindows } from './platformDetection';

/** Buckets a file can fall into, in the order their filter pills are drawn. */
export const FILE_CATEGORIES = ['code', 'docs', 'data', 'media', 'other'] as const;

export type FileCategory = (typeof FILE_CATEGORIES)[number];

/** A category filter, plus the unfiltered `all` case. */
export type FileCategoryFilter = 'all' | FileCategory;

/** Human labels for the filter pills. */
export const FILE_CATEGORY_LABELS: Record<FileCategoryFilter, string> = {
	all: 'All',
	code: 'Code',
	docs: 'Docs',
	data: 'Data',
	media: 'Media',
	other: 'Other',
};

/** Source files, markup, stylesheets, and build scripts. */
export const CODE_FILE_EXTENSIONS = new Set([
	// General purpose languages
	'js',
	'jsx',
	'ts',
	'tsx',
	'mjs',
	'cjs',
	'mts',
	'cts',
	'py',
	'rb',
	'php',
	'java',
	'c',
	'cpp',
	'cc',
	'h',
	'hpp',
	'cs',
	'go',
	'rs',
	'swift',
	'kt',
	'scala',
	'clj',
	'ex',
	'exs',
	'lua',
	'r',
	'pl',
	'pm',
	'dart',
	'zig',
	'nim',
	'hs',
	'erl',
	// Shell and query languages
	'sh',
	'bash',
	'zsh',
	'fish',
	'ps1',
	'bat',
	'cmd',
	'sql',
	'graphql',
	'gql',
	// Markup and styles
	'html',
	'htm',
	'css',
	'scss',
	'sass',
	'less',
	'vue',
	'svelte',
	'astro',
	// Build tooling
	'cmake',
	'gradle',
	'mk',
]);

/** Prose: things a human reads rather than runs. */
export const DOC_FILE_EXTENSIONS = new Set([
	'md',
	'mdx',
	'markdown',
	'rst',
	'adoc',
	'txt',
	'text',
	'pdf',
	'doc',
	'docx',
	'odt',
	'rtf',
	'ppt',
	'pptx',
	'epub',
]);

/** Structured data, configuration, logs, and spreadsheets. */
export const DATA_FILE_EXTENSIONS = new Set([
	'json',
	'jsonl',
	'ndjson',
	'yaml',
	'yml',
	'toml',
	'xml',
	'ini',
	'cfg',
	'conf',
	'env',
	'properties',
	'plist',
	'csv',
	'tsv',
	'log',
	'parquet',
	'xls',
	'xlsx',
	'ods',
	'lock',
]);

/** Still images. Audio and video are resolved through `mediaTypes.ts`. */
export const IMAGE_FILE_EXTENSIONS = new Set([
	'png',
	'jpg',
	'jpeg',
	'gif',
	'webp',
	'svg',
	'ico',
	'bmp',
	'tiff',
	'tif',
	'avif',
	'heic',
]);

/**
 * Extensionless filenames that are still real files, mapped to their bucket.
 * Matched case-insensitively against the whole basename.
 */
const BARE_FILENAME_CATEGORIES: Record<string, FileCategory> = {
	makefile: 'code',
	dockerfile: 'code',
	gemfile: 'code',
	rakefile: 'code',
	procfile: 'code',
	brewfile: 'code',
	license: 'docs',
	readme: 'docs',
	changelog: 'docs',
	authors: 'docs',
	contributing: 'docs',
	notice: 'docs',
};

/**
 * Lowercase extension of a path, or `''` when it has none.
 *
 * Splits on the basename so a dot in a parent directory is ignored, and treats
 * a leading dot as part of the name (`.gitignore` has no extension, it IS the
 * name) rather than as an extension separator.
 */
export function getFileExtension(filePath: string): string {
	const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
	const name = filePath.slice(lastSlash + 1).toLowerCase();
	const lastDot = name.lastIndexOf('.');
	if (lastDot <= 0) return '';
	return name.slice(lastDot + 1);
}

/** Basename of a path, lowercased. */
function baseName(filePath: string): string {
	const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
	return filePath.slice(lastSlash + 1).toLowerCase();
}

/**
 * Which bucket a file belongs to, or `null` when Maestro cannot open it.
 *
 * `null` and `'other'` mean different things: `null` is "not a file we list at
 * all" (a binary, an archive, an unknown extension), while `'other'` is a file
 * we can open that simply does not fit the four named buckets.
 */
export function getFileCategory(filePath: string): FileCategory | null {
	const name = baseName(filePath);

	// Dotfiles with no second dot (.gitignore, .bashrc, .env) are config text.
	if (name.startsWith('.') && !name.includes('.', 1)) return 'data';

	const bare = BARE_FILENAME_CATEGORIES[name];
	if (bare) return bare;

	if (getMediaKind(name)) return 'media';

	const ext = getFileExtension(name);
	if (!ext) return null;

	if (IMAGE_FILE_EXTENSIONS.has(ext)) return 'media';
	if (CODE_FILE_EXTENSIONS.has(ext)) return 'code';
	if (DOC_FILE_EXTENSIONS.has(ext)) return 'docs';
	if (DATA_FILE_EXTENSIONS.has(ext)) return 'data';

	return null;
}

/**
 * Whether Maestro can preview a file or hand it to the OS. Derived from
 * `getFileCategory` so the two can never disagree.
 */
export function isPreviewableFile(filePath: string): boolean {
	return getFileCategory(filePath) !== null;
}

/**
 * Whether a file passes the given filter. `'all'` passes everything, including
 * files whose category could not be determined.
 */
export function matchesFileCategory(filePath: string, filter: FileCategoryFilter): boolean {
	if (filter === 'all') return true;
	return getFileCategory(filePath) === filter;
}

/**
 * Extensions the OS runs, installs, or mounts when it "opens" the file: app
 * bundles, scripts, installers, disk images, and shortcuts (which open
 * whatever they point at, so they can launch any of the others).
 *
 * This is a different question from `getFileCategory()`, and the two tables
 * overlap on purpose: a `.sh` is `code` (Maestro previews it) AND launchable
 * (the OS runs it).
 */
export const LAUNCHABLE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
	// macOS: apps, Terminal scripts and profiles, AppleScript, Automator,
	// installers, disk images
	'app',
	'command',
	'tool',
	'terminal',
	'scpt',
	'applescript',
	'workflow',
	'action',
	'prefpane',
	'pkg',
	'mpkg',
	'dmg',
	// macOS location files (shortcuts)
	'fileloc',
	'inetloc',
	'webloc',
	// POSIX shell scripts
	'sh',
	'zsh',
	'bash',
	// Windows: programs, control panel applets and snap-ins, installers, disk
	// images, scripts, registry files, shortcuts
	'exe',
	'com',
	'scr',
	'pif',
	'cpl',
	'msc',
	'msi',
	'msp',
	'msix',
	'appx',
	'iso',
	'img',
	'vhd',
	'vhdx',
	'bat',
	'cmd',
	'ps1',
	'vbs',
	'vbe',
	'wsf',
	'hta',
	'reg',
	'lnk',
	'url',
	// Linux: launchers, portable apps, packages
	'desktop',
	'appimage',
	'deb',
	'rpm',
	// Java archives, which an installed runtime runs on open
	'jar',
]);

/**
 * Scripts Windows Script Host runs on open. Launchable only on Windows: other
 * systems open a `.js` in an editor.
 */
const WINDOWS_LAUNCHABLE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(['js', 'jse']);

/**
 * Whether the OS would run, install, or mount this file (or folder: an `.app`
 * is a directory) if asked to open it. A click on a link must never do that,
 * so the open path reveals such a file in the file manager instead
 * (`openLocalPath()` in `src/main/utils/open-local-path.ts`).
 *
 * Judges the name only. The executable bit of a POSIX file needs the
 * filesystem, so `isLaunchableLocalPath()` adds that check in main.
 *
 * `windows` adds the Windows rules: `.js` / `.jse`, and the name Windows
 * actually opens (`setup.exe.`, `setup.exe ` and `setup.exe::$DATA` all run
 * `setup.exe`). It defaults to the platform this code runs on, which is the
 * one that would open the file.
 */
export function isLaunchableFile(
	filePath: string,
	{ windows = isWindows() }: { windows?: boolean } = {}
): boolean {
	const name = filePath.replace(/[\\/]+$/, '');
	if (hasLaunchableExtension(name, windows)) return true;
	if (!windows) return false;
	// Windows drops a `:stream` suffix, then trailing dots and spaces.
	const opened = name.replace(/:[^\\/]*$/, '').replace(/[. ]+$/, '');
	return hasLaunchableExtension(opened, windows);
}

function hasLaunchableExtension(name: string, windows: boolean): boolean {
	const ext = getFileExtension(name);
	if (!ext) return false;
	return (
		LAUNCHABLE_FILE_EXTENSIONS.has(ext) || (windows && WINDOWS_LAUNCHABLE_FILE_EXTENSIONS.has(ext))
	);
}

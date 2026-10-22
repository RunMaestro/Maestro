/**
 * M3: the Obsidian link resolver (DV-2, DV-3). Obsidian's `getFirstLinkpathDest` is closed source, so this
 * is the one Dataview semantic Maestro reimplements. The rules, and why the preview's `findClosestMatch`
 * cannot be reused, are in docs/agent-guides/DATAVIEW.md ("Link extraction and resolution for the index").
 *
 * Paths are vault-relative POSIX paths without a leading slash. Lookups are case-insensitive; an exact-case
 * match wins a tie. A markdown file matches its path with or without the `.md` extension; every other file
 * (a `view.js`, a CSV, a PDF) matches only with its extension, as in Obsidian.
 */

/** Maps a link's path text, written in `sourcePath`, to the vault path it points at. */
export interface LinkResolver {
	/** The vault path `linkpath` resolves to from `sourcePath`, or `null` when nothing matches. */
	resolve(linkpath: string, sourcePath: string): string | null;
}

const MD_EXTENSION = '.md';

function folderOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash < 0 ? '' : path.slice(0, slash);
}

/** Collapse `.` and `..` segments. Returns `null` when `..` climbs above the vault root. */
function collapseDotSegments(path: string): string | null {
	const out: string[] = [];
	for (const segment of path.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (out.length === 0) return null;
			out.pop();
		} else out.push(segment);
	}
	return out.join('/');
}

/** The names a file answers to: its path, plus its path without `.md` for a markdown file. */
function linkableNames(path: string): string[] {
	return path.toLowerCase().endsWith(MD_EXTENSION)
		? [path, path.slice(0, -MD_EXTENSION.length)]
		: [path];
}

function lastSegment(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The keys under which `filePath` can be the target of a link: its lowercased last segment, with and
 * without `.md` for a markdown file. A link can only resolve to a file whose keys contain
 * {@link linkPathKey} of the link, so an index that adds or removes a file needs to re-resolve only the
 * pages holding a link with one of these keys.
 */
export function linkTargetKeys(filePath: string): string[] {
	return linkableNames(filePath).map((name) => lastSegment(name).toLowerCase());
}

/** The key of a link path, written or resolved; see {@link linkTargetKeys}. */
export function linkPathKey(linkPath: string): string {
	return lastSegment(linkPath.replace(/\\/g, '/')).toLowerCase();
}

/**
 * Order duplicate matches: the source's own folder first, then the fewest path segments, then the shortest
 * path, then lexical order, so the same vault always resolves the same way.
 */
function compareCandidates(a: string, b: string, sourceFolder: string): number {
	const aLocal = folderOf(a) === sourceFolder ? 0 : 1;
	const bLocal = folderOf(b) === sourceFolder ? 0 : 1;
	if (aLocal !== bLocal) return aLocal - bLocal;
	const segments = a.split('/').length - b.split('/').length;
	if (segments !== 0) return segments;
	if (a.length !== b.length) return a.length - b.length;
	return a < b ? -1 : a > b ? 1 : 0;
}

/** Pick one path from `candidates` that answers to `name`, preferring an exact-case name. */
function pickExact(candidates: readonly string[] | undefined, name: string): string | null {
	if (!candidates || candidates.length === 0) return null;
	return candidates.find((path) => linkableNames(path).includes(name)) ?? candidates[0];
}

/**
 * Build a resolver over every file in the vault (any extension, not just markdown, because `dv.view` and
 * markdown links name non-markdown files). The resolver is a snapshot: rebuild it when files are added,
 * removed, or renamed.
 */
export function createLinkResolver(paths: Iterable<string>): LinkResolver {
	// Lowercased full name -> paths, and lowercased last segment -> paths (for the suffix rule).
	const byName = new Map<string, string[]>();
	const byLastSegment = new Map<string, string[]>();
	const add = (map: Map<string, string[]>, key: string, path: string) => {
		const list = map.get(key);
		if (!list) map.set(key, [path]);
		else if (!list.includes(path)) list.push(path);
	};
	for (const path of paths) {
		for (const name of linkableNames(path)) {
			add(byName, name.toLowerCase(), path);
			add(byLastSegment, lastSegment(name).toLowerCase(), path);
		}
	}

	const exact = (name: string) => pickExact(byName.get(name.toLowerCase()), name);

	return {
		resolve(linkpath, sourcePath) {
			// `[[#Heading]]` and `[[^block]]`-style self links carry an empty path.
			if (linkpath.trim() === '') return sourcePath;
			const sourceFolder = folderOf(sourcePath);
			const written = linkpath.replace(/\\/g, '/');

			// 1. The exact vault path (a leading `/` means the vault root). A bare name skips this step, so a
			// same-folder note beats a root-level one of the same name (step 3's ordering).
			const rooted = collapseDotSegments(written);
			if (rooted !== null && !written.startsWith('.') && written.includes('/')) {
				const hit = exact(rooted);
				if (hit) return hit;
			}

			// 2. Relative to the source's folder (`./x`, `../x`, and `sub/x` from inside a folder).
			if (!written.startsWith('/')) {
				const relative = collapseDotSegments(sourceFolder ? `${sourceFolder}/${written}` : written);
				if (relative !== null) {
					const hit = exact(relative);
					if (hit) return hit;
				}
			}
			if (written.startsWith('.')) return null;

			// 3. A folder-bounded suffix: `Note` matches `a/b/Note.md`, `b/Note` matches `a/b/Note.md`, but
			// `er/Note` never matches `Folder/Note.md`.
			const wanted = rooted;
			if (!wanted) return null;
			const wantedLower = wanted.toLowerCase();
			const matches = (byLastSegment.get(lastSegment(wantedLower)) ?? []).filter((path) =>
				linkableNames(path).some((name) => {
					const lower = name.toLowerCase();
					return lower === wantedLower || lower.endsWith(`/${wantedLower}`);
				})
			);
			if (matches.length === 0) return null;
			const exactCase = matches.filter((path) =>
				linkableNames(path).some((name) => name === wanted || name.endsWith(`/${wanted}`))
			);
			const pool = exactCase.length > 0 ? exactCase : matches;
			return pool.slice().sort((a, b) => compareCandidates(a, b, sourceFolder))[0];
		},
	};
}

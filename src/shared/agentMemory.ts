/**
 * Wire types for the Memory Viewer (`window.maestro.memory`).
 *
 * One definition shared by the main-process memory manager, the preload
 * bridge, and the renderer, so the three cannot drift on what an entry is.
 */

/** Which agent's memory store a request is about. */
export interface MemoryTarget {
	/** The agent's project root. Claude keys its memory store by it. */
	projectPath: string;
	/** Provider id (`claude-code`, `codex`). */
	toolType: string;
	/**
	 * The Maestro agent id. Resolves the account dir the agent actually runs
	 * under (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`); without it the provider's
	 * default account is used.
	 */
	agentId?: string;
}

export interface MemoryEntry {
	/** Path relative to the memory root, `/`-separated (e.g. "MEMORY.md", "skills/x/SKILL.md"). */
	name: string;
	size: number; // bytes
	createdAt: string; // ISO8601
	modifiedAt: string; // ISO8601
	/** The viewer may not delete this file (an index, or a file the provider regenerates). */
	protected?: boolean;
}

export interface MemoryStats {
	fileCount: number;
	firstCreatedAt: string | null;
	lastModifiedAt: string | null;
	totalBytes: number;
}

export interface MemorySearchMatch {
	name: string; // filename of the matching entry
	matchedName: boolean; // the query matched the filename itself
	snippet?: string; // first matching body line, trimmed and capped
}

/** How a provider lays out its store, as far as the viewer needs to know. */
export interface MemoryLayoutInfo {
	/** `project`: one store per working directory. `account`: one store shared by every project. */
	scope: 'project' | 'account';
	/** Whether entries live in subdirectories of the root. */
	nested: boolean;
	/** Relative directory a NEW memory is created in ('' for the root). */
	newEntryDir: string;
	/** Whether entries link to each other, so an unreferenced entry means something. */
	tracksLinks: boolean;
}

export interface MemoryListResponse {
	success: boolean;
	directoryPath?: string;
	exists?: boolean;
	entries?: MemoryEntry[];
	stats?: MemoryStats;
	layout?: MemoryLayoutInfo;
	error?: string;
}

/** The index every store pins to the top of its list. */
export const MEMORY_INDEX_FILE = 'MEMORY.md';

/**
 * The list group a nested entry belongs to: '' for a file at the root,
 * `extensions/<name>` for anything inside one extension (each is its own
 * corpus, written by a different process), else the top-level directory.
 */
export function memoryEntryGroup(name: string): string {
	const segments = name.split('/');
	if (segments.length === 1) return '';
	if (segments[0] === 'extensions' && segments.length > 2) return `extensions/${segments[1]}`;
	return segments[0];
}

/** `rollout_summaries` -> `Rollout summaries`. */
function humanizeSegment(segment: string): string {
	const words = segment.replace(/[-_]+/g, ' ').trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * How a nested store's groups are shown: the root files first (the index and
 * whatever the provider generates beside it), then the group new memories are
 * written into, then everything else alphabetically.
 */
export function memoryGroupDisplay(
	group: string,
	newEntryDir: string
): { label: string; order?: number } {
	if (group === '') return { label: 'Core', order: 0 };
	if (newEntryDir && group === memoryEntryGroup(`${newEntryDir}/x.md`)) {
		return { label: 'Your notes', order: 1 };
	}
	return { label: humanizeSegment(group.split('/').pop() ?? group) };
}

/**
 * An entry's name as its list row shows it: relative to the directory its
 * group is about, since the group header already says the rest.
 */
export function memoryEntryLabel(name: string, newEntryDir: string): string {
	if (newEntryDir && name.startsWith(`${newEntryDir}/`)) {
		return name.slice(newEntryDir.length + 1);
	}
	const group = memoryEntryGroup(name);
	return group ? name.slice(group.length + 1) : name;
}

// Maestro-authored (E2): local stand-ins for every type the vendored Dataview files import from `obsidian`.
// Types only; nothing here has runtime behavior. Shapes are copied from obsidian.d.ts 1.4.11 (MIT), the
// version upstream's lockfile pins. The Maestro metadata extractor (M1) produces `CachedMetadata`.

export interface Loc {
	line: number;
	col: number;
	offset: number;
}

export interface Pos {
	start: Loc;
	end: Loc;
}

export interface FileStats {
	/** Creation time in ms. Fill from `birthtimeMs`, not `ctimeMs` (inode change time). */
	ctime: number;
	mtime: number;
	size: number;
}

export interface FrontMatterCache {
	[key: string]: any;
}

export interface CacheItem {
	position: Pos;
}

export interface HeadingCache extends CacheItem {
	heading: string;
	level: number;
}

export interface Reference {
	link: string;
	original: string;
	/** The alias in `[[page|alias]]`, when it differs from the link text. */
	displayText?: string;
}

export interface ReferenceCache extends Reference, CacheItem {}

export interface LinkCache extends ReferenceCache {}

export interface EmbedCache extends ReferenceCache {}

export interface TagCache extends CacheItem {
	tag: string;
}

export interface SectionCache extends CacheItem {
	id?: string | undefined;
	type: string;
}

export interface ListItemCache extends CacheItem {
	id?: string | undefined;
	/** The character between the brackets of a task (a space when unchecked); undefined for a plain item. */
	task?: string | undefined;
	/** The parent item's start line, or the negative of the list's first line for a root item. */
	parent: number;
}

export interface FrontmatterLinkCache extends Reference {
	key: string;
}

export interface CachedMetadata {
	links?: LinkCache[];
	embeds?: EmbedCache[];
	tags?: TagCache[];
	headings?: HeadingCache[];
	sections?: SectionCache[];
	listItems?: ListItemCache[];
	frontmatter?: FrontMatterCache;
	frontmatterPosition?: Pos;
	frontmatterLinks?: FrontmatterLinkCache[];
}

export interface DataAdapter {
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
}

/** The subset of `Vault` that the vendored `rewriteTask` reads. */
export interface Vault {
	adapter: DataAdapter;
}

// Vendored from blacksmithgu/obsidian-dataview@0.5.68 (29b1ad87e1f2b964b4fa0c209f11d0622469bdb0).
// Upstream path: src/data-index/index.ts. License: MIT, see ../LICENSE.
// Modified for Maestro: E1, Split (kept PathFilters, StarredEntry, IndexMap, ValueCaseInsensitiveIndexMap verbatim; the
// Obsidian-bound FullIndex, PrefixIndex, CsvCache, and StarredCache are dropped); indentation converted to tabs.
import { Result } from "../api/result";
import { PageMetadata } from "../data-model/markdown";
import { DataObject } from "../data-model/value";

// MAESTRO: Split. Maestro-authored contract that the kept engine, resolver, and markdown model read; it replaces
// upstream's FullIndex class. Implemented by the main-process VaultIndex (M2) and the guest runtime (M7). Upstream's
// class also keeps `etags`, but no kept file reads it, so the contract omits it.
export interface FullIndex {
	pages: Map<string, PageMetadata>;
	tags: ValueCaseInsensitiveIndexMap;
	links: IndexMap;
	revision: number;
	prefix: {
		get(prefix: string, filter?: (path: string) => boolean): Set<string>;
		pathExists(path: string): boolean;
		nodeExists(prefix: string): boolean;
		resolveRelative(path: string, origin?: string): string;
	};
	csv: { get(path: string): Promise<Result<DataObject[], string>> };
	starred: { starred(path: string): boolean };
	metadataCache: {
		getFirstLinkpathDest(linkpath: string, sourcePath: string): { path: string } | null;
		resolvedLinks: Record<string, Record<string, number>>;
	};
	vault: { getMarkdownFiles(): { path: string }[] };
}

/** Simple path filters which filter file types. */
export namespace PathFilters {
	export function csv(path: string): boolean {
		return path.toLowerCase().endsWith(".csv");
	}

	export function markdown(path: string): boolean {
		let lcPath = path.toLowerCase();
		return lcPath.endsWith(".md") || lcPath.endsWith(".markdown");
	}
}

export type StarredEntry =
	| { type: "group"; items: StarredEntry[]; title: string }
	| { type: "file"; path: string; title: string }
	| { type: "folder" }
	| { type: "query" };

/** A generic index which indexes variables of the form key -> value[], allowing both forward and reverse lookups. */
export class IndexMap {
	/** Maps key -> values for that key. */
	map: Map<string, Set<string>>;
	/** Cached inverse map; maps value -> keys that reference that value. */
	invMap: Map<string, Set<string>>;

	/** Create a new, empty index map. */
	public constructor() {
		this.map = new Map();
		this.invMap = new Map();
	}

	/** Returns all values for the given key. */
	public get(key: string): Set<string> {
		let result = this.map.get(key);
		if (result) {
			return new Set(result);
		} else {
			return new Set();
		}
	}

	/** Returns all keys that reference the given key. Mutating the returned set is not allowed. */
	public getInverse(value: string): Readonly<Set<string>> {
		return this.invMap.get(value) || IndexMap.EMPTY_SET;
	}

	/** Sets the key to the given values; this will delete the old mapping for the key if one was present. */
	public set(key: string, values: Set<string>): this {
		if (!values.size) {
			// no need to store if no values
			this.delete(key);
			return this;
		}
		let oldValues = this.map.get(key);
		if (oldValues) {
			for (let value of oldValues) {
				// Only delete the ones we're not adding back
				if (!values.has(key)) this.invMap.get(value)?.delete(key);
			}
		}
		this.map.set(key, values);
		for (let value of values) {
			if (!this.invMap.has(value)) this.invMap.set(value, new Set([key]));
			else this.invMap.get(value)?.add(key);
		}
		return this;
	}

	/** Clears all values for the given key so they can be re-added. */
	public delete(key: string): boolean {
		let oldValues = this.map.get(key);
		if (!oldValues) return false;

		this.map.delete(key);
		for (let value of oldValues) {
			this.invMap.get(value)?.delete(key);
		}

		return true;
	}

	/** Rename all references to the given key to a new value. */
	public rename(oldKey: string, newKey: string): boolean {
		let oldValues = this.map.get(oldKey);
		if (!oldValues) return false;

		this.delete(oldKey);
		this.set(newKey, oldValues);
		return true;
	}

	/** Clear the entire index. */
	public clear() {
		this.map.clear();
		this.invMap.clear();
	}

	static EMPTY_SET: Readonly<Set<string>> = Object.freeze(new Set<string>());
}

/** Index map wrapper which is case-insensitive in the key. */
export class ValueCaseInsensitiveIndexMap {
	/** Create a new, empty case insensitive index map. */
	public constructor(public delegate: IndexMap = new IndexMap()) {}

	/** Returns all values for the given key. */
	public get(key: string): Set<string> {
		return this.delegate.get(key);
	}

	/** Returns all keys that reference the given value. Mutating the returned set is not allowed. */
	public getInverse(value: string): Readonly<Set<string>> {
		return this.delegate.getInverse(value.toLocaleLowerCase());
	}

	/** Sets the key to the given values; this will delete the old mapping for the key if one was present. */
	public set(key: string, values: Set<string>): this {
		this.delegate.set(key, new Set(Array.from(values).map(v => v.toLocaleLowerCase())));
		return this;
	}

	/** Clears all values for the given key so they can be re-added. */
	public delete(key: string): boolean {
		return this.delegate.delete(key);
	}

	/** Rename all references to the given key to a new value. */
	public rename(oldKey: string, newKey: string): boolean {
		return this.delegate.rename(oldKey, newKey);
	}

	/** Clear the entire index. */
	public clear() {
		this.delegate.clear();
	}
}

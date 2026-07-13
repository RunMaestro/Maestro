import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
	InteractiveRuntimeAuthorization,
	WorkspaceRootCapability,
} from '../../shared/plugins/interactive-runtime';

export interface RuntimeActivationContext {
	readonly ownerPluginId: string;
	readonly generation: bigint;
	readonly authorization: InteractiveRuntimeAuthorization;
}

export interface NativeWorkspaceRootStat {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

export interface NativeWorkspaceRootFilesystem {
	readonly resolve: (value: string) => string;
	readonly isAbsolute: (value: string) => boolean;
	readonly realpath: (value: string) => string;
	readonly lstat: (value: string) => NativeWorkspaceRootStat;
	readonly sep: string;
}

export interface NativeWorkspaceRootServiceDeps {
	/** Native UI adapter; it takes no plugin-controlled labels, paths, or filters. */
	readonly chooseDirectory: () => Promise<string | null>;
	/** Current manager-owned activation facts, re-evaluated for every resolution. */
	readonly activation: () => RuntimeActivationContext | null;
	readonly filesystem?: NativeWorkspaceRootFilesystem;
}

interface RootRecord {
	readonly ownerPluginId: string;
	readonly generation: bigint;
	readonly canonicalRoot: string;
	readonly identity: RootIdentity;
	readonly epoch: bigint;
}

interface RootIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly isDirectory: boolean;
	readonly isSymbolicLink: boolean;
}

/**
 * Main-process-only root authority. The capability is empty, frozen, and backed
 * by a WeakMap, so a renderer or plugin cannot forge a path-bearing value.
 */
export class NativeWorkspaceRootService {
	private readonly records = new WeakMap<object, RootRecord>();
	private epoch = 0n;
	private readonly filesystem: NativeWorkspaceRootFilesystem;

	constructor(private readonly deps: NativeWorkspaceRootServiceDeps) {
		this.filesystem = deps.filesystem ?? defaultFilesystem;
	}

	async requestWorkspaceRoot(): Promise<WorkspaceRootCapability | null> {
		const context = this.deps.activation();
		if (!context) throw new Error('interactive runtime owner is unavailable');
		const chosen = await this.deps.chooseDirectory();
		if (chosen === null) return null;
		const root = this.canonicalizeDirectory(chosen);
		const capability = Object.freeze(Object.create(null)) as WorkspaceRootCapability;
		this.records.set(
			capability,
			Object.freeze({
				ownerPluginId: context.ownerPluginId,
				generation: context.generation,
				canonicalRoot: root.canonicalRoot,
				identity: root.identity,
				epoch: this.epoch,
			})
		);
		return capability;
	}

	/** Resolves only a currently-owned capability; this raw path never crosses a plugin boundary. */
	resolveCurrent(
		capability: WorkspaceRootCapability,
		ownerPluginId: string,
		generation: bigint
	): string {
		const record = this.records.get(capability);
		const context = this.deps.activation();
		if (
			!record ||
			!context ||
			record.epoch !== this.epoch ||
			record.ownerPluginId !== ownerPluginId ||
			record.generation !== generation ||
			context.ownerPluginId !== ownerPluginId ||
			context.generation !== generation ||
			context.authorization.workspaceRootCurrent !== true
		) {
			throw new Error('workspace root capability is unavailable');
		}
		const current = this.canonicalizeDirectory(record.canonicalRoot);
		if (
			!samePath(current.canonicalRoot, record.canonicalRoot) ||
			current.identity.dev !== record.identity.dev ||
			current.identity.ino !== record.identity.ino ||
			current.identity.size !== record.identity.size ||
			current.identity.isDirectory !== record.identity.isDirectory ||
			current.identity.isSymbolicLink !== record.identity.isSymbolicLink
		) {
			throw new Error('workspace root changed after consent');
		}
		return current.canonicalRoot;
	}

	/** Revocation is monotonic and invalidates every previously-issued capability. */
	revokeAll(): void {
		this.epoch += 1n;
	}

	private canonicalizeDirectory(value: string): {
		readonly canonicalRoot: string;
		readonly identity: RootIdentity;
	} {
		if (typeof value !== 'string' || value.length === 0 || !this.filesystem.isAbsolute(value)) {
			throw new Error('workspace root must be an absolute directory');
		}
		const resolved = this.filesystem.resolve(value);
		this.assertNoFollowDirectory(resolved);
		const canonical = this.filesystem.realpath(resolved);
		if (!this.filesystem.isAbsolute(canonical))
			throw new Error('workspace root canonicalization failed');
		const identity = this.assertNoFollowDirectory(canonical);
		return { canonicalRoot: canonical, identity };
	}

	private assertNoFollowDirectory(absolute: string): RootIdentity {
		const parsed = path.parse(absolute);
		let current = parsed.root;
		for (const segment of absolute.slice(parsed.root.length).split(this.filesystem.sep)) {
			if (!segment) continue;
			current = path.join(current, segment);
			const entry = this.filesystem.lstat(current);
			if (entry.isSymbolicLink()) throw new Error('workspace root contains a reparse point');
			if (!entry.isDirectory()) throw new Error('workspace root is not a directory');
		}
		const root = this.filesystem.lstat(absolute);
		if (root.isSymbolicLink() || !root.isDirectory()) {
			throw new Error('workspace root is not a no-follow directory');
		}
		return {
			dev: root.dev,
			ino: root.ino,
			size: root.size,
			isDirectory: root.isDirectory(),
			isSymbolicLink: root.isSymbolicLink(),
		};
	}
}

const defaultFilesystem: NativeWorkspaceRootFilesystem = {
	resolve: path.resolve,
	isAbsolute: path.isAbsolute,
	realpath: fs.realpathSync.native,
	lstat: fs.lstatSync,
	sep: path.sep,
};

function samePath(left: string, right: string): boolean {
	return process.platform === 'win32'
		? left.toLocaleLowerCase() === right.toLocaleLowerCase()
		: left === right;
}

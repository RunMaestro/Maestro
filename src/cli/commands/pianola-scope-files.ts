/** Files only provide wakeup hints. The scope cycle and host remain authoritative. */
import * as fs from 'fs';
import * as path from 'path';
import { getConfigDirectory, getSyncDir } from '../services/storage';
import { BOOTSTRAP_STORE_FILE } from '../../shared/syncPath';
import type { PianolaFileMutationReceipt } from '../../shared/pianola/fs-store';
import {
	PIANOLA_DECISIONS_FILENAME,
	PIANOLA_PROFILES_FILENAME,
	PIANOLA_RULES_FILENAME,
	PIANOLA_SUPERVISOR_FILENAME,
} from '../../shared/pianola/storage';

/** One pair of directory watchers per scope worker, also covering atomic renames. */
export class PianolaScopeFiles {
	private watchers = new Map<string, fs.FSWatcher>();
	private snapshots = new Map<string, string | null>();
	private revisions = new Map<string, string>();
	private paths: string[] = [];
	private disposed = false;
	private failed = false;
	constructor(
		private readonly scopeId: string,
		private readonly signal: () => void
	) {}

	private read(file: string): string | null {
		try {
			return fs.readFileSync(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
	}

	/** Rebind after a bootstrap edit, connection recovery, or failed watcher. */
	refresh(): void {
		if (this.disposed) return;
		try {
			const config = getConfigDirectory();
			const sync = getSyncDir();
			const paths = [
				...[
					BOOTSTRAP_STORE_FILE,
					PIANOLA_RULES_FILENAME,
					PIANOLA_PROFILES_FILENAME,
					PIANOLA_SUPERVISOR_FILENAME,
					PIANOLA_DECISIONS_FILENAME,
					`maestro-pianola-scope-${this.scopeId}.json`,
				].map((name) => path.join(config, name)),
				path.join(sync, 'maestro-settings.json'),
			];
			const changed = JSON.stringify(paths) !== JSON.stringify(this.paths);
			if (changed) {
				for (const watcher of this.watchers.values()) watcher.close();
				this.watchers.clear();
				this.paths = paths;
				this.snapshots.clear();
				this.revisions.clear();
				for (const file of paths) this.snapshots.set(file, this.read(file));
			}
			for (const dir of new Set(paths.map((file) => path.dirname(file)))) {
				if (this.watchers.has(dir)) continue;
				const watcher = fs.watch(dir, (_event, filename) => {
					if (filename && !this.paths.includes(path.join(dir, filename.toString()))) return;
					this.inspect(filename ? [path.join(dir, filename.toString())] : this.paths);
				});
				watcher.on('error', () => {
					watcher.close();
					this.watchers.delete(dir);
					if (!this.failed) this.signal();
					this.failed = true;
				});
				this.watchers.set(dir, watcher);
			}
			// Close the snapshot-to-watch gap and recover changes missed while disconnected.
			if (!this.inspect()) return;
			if (this.failed || changed) this.signal();
			this.failed = false;
		} catch {
			if (!this.failed) this.signal();
			this.failed = true;
		}
	}

	private inspect(paths = this.paths): boolean {
		if (this.disposed) return false;
		try {
			let changed = false;
			for (const file of paths) {
				// Reuse the store's nanosecond identity scheme for passive hints only.
				// Commit the identity only after a stable read; never cache a failed read.
				const revision = (): string => {
					try {
						const stat = fs.statSync(file, { bigint: true });
						return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
						throw error;
					}
				};
				const before = revision();
				if (before === this.revisions.get(file)) continue;
				const actual = this.read(file);
				const after = revision();
				if (before !== after) {
					this.revisions.delete(file);
					this.signal();
					continue;
				}
				if (actual !== this.snapshots.get(file)) changed = true;
				this.snapshots.set(file, actual);
				this.revisions.set(file, after);
			}
			if (changed) this.signal();
			return true;
		} catch {
			if (!this.failed) this.signal();
			this.failed = true;
			return false;
		}
	}

	/** Attribute only an exact expected change; concurrent edits always wake. */
	ownWrite(
		file: string,
		write: (receipt: (value: PianolaFileMutationReceipt) => void) => void
	): void {
		this.revisions.delete(file);
		let before: string | null;
		try {
			before = this.read(file);
			if (before !== this.snapshots.get(file)) this.signal();
		} catch {
			this.signal();
			write(() => {});
			return;
		}
		let receipt: PianolaFileMutationReceipt | undefined;
		try {
			write((value) => {
				receipt = value;
			});
		} finally {
			try {
				const after = this.read(file);
				if (!receipt || before !== receipt.before || after !== receipt.after) this.signal();
				this.snapshots.set(file, after);
			} catch {
				this.signal();
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const watcher of this.watchers.values()) watcher.close();
		this.watchers.clear();
	}
}

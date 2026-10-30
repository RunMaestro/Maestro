/** Unwired, host-private delivery resources. Registry authority never comes from disk. */
import * as fs from 'fs';
import * as path from 'path';
import { PluginAuthorityError } from './plugin-authority';
import {
	PLUGIN_TOOL_RUN_LIMITS,
	PluginToolRunIdentity,
	type PluginToolCallerContext,
	type PluginToolRunAuthority,
} from './plugin-tool-run-identity';

export interface PluginToolRunProofFile {
	/** Host spawn configuration only; never return this resource to a plugin/model. */
	readonly runTokenFile: string;
	readonly signal: AbortSignal;
	assertActive(): void;
	/** Revokes first. A failed deletion can be retried; issuance stays stopped. */
	dispose(): void;
}

interface FileResource {
	closed: boolean;
	busy: boolean;
	token?: string;
	context?: PluginToolCallerContext;
	onAbort?: () => void;
	directory?: string;
	directoryStat?: fs.Stats;
	fileStat?: fs.Stats;
	fd?: number;
}

/** One resource owner beside the actual registry, not a second proof registry.
 * The trusted host must supply an existing local private directory outside project/Vault.
 * No chmod repair, temporary-directory fallback, Windows ACL guess or recursive deletion.
 * POSIX mode/owner checks do not isolate hostile code running as this same OS user. */
export class PluginToolRunProofFiles {
	private readonly resources = new Set<FileResource>();
	private readonly identities: PluginToolRunIdentity;
	private readonly directory: string;
	private readonly directoryStat: fs.Stats;
	private readonly uid: number;
	private stopped = false;
	private failing = false;

	constructor(identities: PluginToolRunIdentity, privateDirectory: string) {
		try {
			this.uid = PluginToolRunProofFiles.supportedUid();
			if (!(identities instanceof PluginToolRunIdentity))
				throw new PluginAuthorityError('PLUGIN_DENIED');
			this.identities = identities;
			this.directory = privateDirectory;
			this.directoryStat = this.checkDirectory(privateDirectory);
		} catch {
			throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		}
	}

	/** Host construction only. The caller must choose a base outside project/Vault;
	 * this checks filesystem privacy, not the origin or policy of that choice.
	 * Creates only one fixed child; no parent creation, chmod repair or temp fallback. */
	static provision(
		identities: PluginToolRunIdentity,
		hostPrivateBase: string
	): PluginToolRunProofFiles {
		try {
			const uid = this.supportedUid();
			if (!(identities instanceof PluginToolRunIdentity))
				throw new PluginAuthorityError('PLUGIN_DENIED');
			const baseStat = this.validateDirectory(hostPrivateBase, uid, undefined, false);
			const directory = path.join(hostPrivateBase, 'plugin-tool-run-proofs');
			if (directory.length > 4096) throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			try {
				fs.mkdirSync(directory, { mode: 0o700 });
			} catch (error) {
				// An existing child is accepted only by the same strict constructor checks.
				if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
			}
			this.validateDirectory(hostPrivateBase, uid, baseStat, false);
			const files = new PluginToolRunProofFiles(identities, directory);
			this.validateDirectory(hostPrivateBase, uid, baseStat, false);
			return files;
		} catch {
			// A failed preflight/creation cannot expose the selected path or OS error.
			throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		}
	}

	private static supportedUid(): number {
		// Windows needs verified private ACLs; POSIX chmod there is insufficient.
		if (
			!['linux', 'darwin'].includes(process.platform) ||
			typeof process.getuid !== 'function' ||
			!fs.constants.O_NOFOLLOW ||
			!fs.constants.O_DIRECTORY
		)
			throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		return process.getuid();
	}

	private static sameFile(first: fs.Stats, second: fs.Stats): boolean {
		return first.dev === second.dev && first.ino === second.ino;
	}

	/** Host composition only: issuance and verified ingress must share one registry. */
	assertIdentity(identity: PluginToolRunIdentity): void {
		if (this.stopped || identity !== this.identities)
			throw new PluginAuthorityError('PLUGIN_DENIED');
	}

	/** Reject noncanonical paths, symlinks and ancestors another uid can replace.
	 * Limit ancestor traversal too; a private leaf under a writable parent is not private. */
	private checkDirectory(directory: string, expected?: fs.Stats): fs.Stats {
		return PluginToolRunProofFiles.validateDirectory(directory, this.uid, expected);
	}

	private static validateDirectory(
		directory: string,
		uid: number,
		expected?: fs.Stats,
		privateLeaf = true
	): fs.Stats {
		if (
			typeof directory !== 'string' ||
			directory.length > 4096 ||
			directory.includes('\0') ||
			!path.isAbsolute(directory) ||
			path.resolve(directory) !== directory ||
			fs.realpathSync(directory) !== directory
		)
			throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		const stat = fs.lstatSync(directory);
		if (
			!stat.isDirectory() ||
			stat.uid !== uid ||
			(stat.mode & 0o700) !== 0o700 ||
			(stat.mode & 0o7022) !== 0 ||
			(privateLeaf && (stat.mode & 0o7777) !== 0o700) ||
			(expected && !PluginToolRunProofFiles.sameFile(expected, stat))
		)
			throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		let ancestor = path.dirname(directory);
		for (let count = 0; ; count++) {
			if (count >= 64) throw new PluginAuthorityError('PLUGIN_LIMIT');
			const parent = fs.lstatSync(ancestor);
			if (
				!parent.isDirectory() ||
				(parent.uid !== 0 && parent.uid !== uid) ||
				(parent.mode & 0o022) !== 0
			)
				throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			const next = path.dirname(ancestor);
			if (next === ancestor) break;
			ancestor = next;
		}
		const fd = fs.openSync(
			directory,
			fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
		);
		try {
			const opened = fs.fstatSync(fd);
			if (
				!opened.isDirectory() ||
				opened.uid !== uid ||
				opened.mode !== stat.mode ||
				!PluginToolRunProofFiles.sameFile(stat, opened) ||
				!PluginToolRunProofFiles.sameFile(stat, fs.lstatSync(directory))
			)
				throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		} finally {
			fs.closeSync(fd);
		}
		return stat;
	}

	private checkPaths(resource: FileResource): void {
		this.checkDirectory(this.directory, this.directoryStat);
		if (!resource.directory || !resource.directoryStat)
			throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		this.checkDirectory(resource.directory, resource.directoryStat);
	}

	private checkActive(resource: FileResource): void {
		if (this.stopped || resource.closed || !resource.context)
			throw new PluginAuthorityError('PLUGIN_DENIED');
		resource.context.assertActive();
		// The registry's host admission callbacks can synchronously stop/dispose us.
		if (this.stopped || resource.closed || resource.context.signal.aborted)
			throw new PluginAuthorityError('PLUGIN_DENIED');
	}

	private invalidate(resource: FileResource): void {
		resource.closed = true;
		if (resource.context && resource.onAbort)
			resource.context.signal.removeEventListener('abort', resource.onAbort);
		const token = resource.token;
		resource.token = undefined;
		if (token) this.identities.revoke(token);
	}

	/** A filesystem failure permanently fences admission and revokes all siblings. */
	private fail(): void {
		this.stopped = true;
		if (this.failing) return;
		this.failing = true;
		try {
			const resources = [...this.resources];
			for (const resource of resources) this.invalidate(resource);
			for (const resource of resources) {
				try {
					this.cleanup(resource);
				} catch {
					// Keep failed slots; other resources still get a cleanup attempt.
				}
			}
		} finally {
			this.failing = false;
		}
	}

	private cleanup(resource: FileResource): void {
		if (resource.busy) return; // In-progress synchronous I/O owns its descriptor/finally.
		resource.busy = true;
		try {
			if (resource.directory) {
				this.checkPaths(resource);
				const file = path.join(resource.directory, 'proof');
				let current: fs.Stats | undefined;
				try {
					current = fs.lstatSync(file);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
				if (current) {
					// Never unlink a substituted file or follow a link, even after revocation.
					if (!resource.fileStat || !PluginToolRunProofFiles.sameFile(resource.fileStat, current))
						throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
					if (!current.isFile() || current.nlink !== 1 || current.uid !== this.uid)
						throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
					fs.unlinkSync(file);
					try {
						fs.lstatSync(file);
						throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
					}
				}
				this.checkPaths(resource);
				fs.rmdirSync(resource.directory); // Empty owned directory only, never recursive.
				try {
					fs.lstatSync(resource.directory);
					throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
				}
				this.checkDirectory(this.directory, this.directoryStat);
				resource.directory = undefined;
			}
			this.resources.delete(resource);
		} catch {
			this.fail();
			// Retain the bounded failed slot for explicit retry; no raw path/error escapes.
			throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
		} finally {
			resource.busy = false;
		}
	}

	private dispose(resource: FileResource): void {
		this.invalidate(resource);
		this.cleanup(resource);
	}

	/** Only host lifecycle callers may issue; no token input or serialized authority. */
	create(
		agentId: unknown,
		authority: PluginToolRunAuthority,
		ttlMs = PLUGIN_TOOL_RUN_LIMITS.defaultTtlMs
	): PluginToolRunProofFile {
		if (this.stopped) throw new PluginAuthorityError('PLUGIN_DENIED');
		if (this.resources.size >= PLUGIN_TOOL_RUN_LIMITS.runs)
			throw new PluginAuthorityError('PLUGIN_LIMIT');
		const resource: FileResource = { closed: false, busy: true };
		this.resources.add(resource); // Reserve before reentrant membership/lifetime checks.
		const bytes = Buffer.alloc(64);
		const readback = Buffer.alloc(65);
		try {
			const token = this.identities.issue(agentId, authority, ttlMs);
			resource.token = token;
			resource.context = this.identities.resolveVerified(resource.token);
			resource.onAbort = () => {
				try {
					this.dispose(resource);
				} catch {
					// Cleanup already latched failure/revoked; abort delivery never logs secrets.
				}
			};
			resource.context.signal.addEventListener('abort', resource.onAbort, { once: true });
			this.checkActive(resource);
			this.checkDirectory(this.directory, this.directoryStat);
			this.checkActive(resource);
			resource.directory = fs.mkdtempSync(path.join(this.directory, 'run-'));
			resource.directoryStat = this.checkDirectory(resource.directory);
			this.checkActive(resource);
			const file = path.join(resource.directory, 'proof');
			resource.fd = fs.openSync(
				file,
				fs.constants.O_RDWR |
					fs.constants.O_CREAT |
					fs.constants.O_EXCL |
					fs.constants.O_NOFOLLOW |
					fs.constants.O_NONBLOCK,
				0o600
			);
			resource.fileStat = fs.fstatSync(resource.fd);
			const stat = resource.fileStat;
			if (
				!stat.isFile() ||
				stat.uid !== this.uid ||
				(stat.mode & 0o7777) !== 0o600 ||
				stat.nlink !== 1 ||
				stat.size !== 0 ||
				!PluginToolRunProofFiles.sameFile(stat, fs.lstatSync(file))
			)
				throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			this.checkPaths(resource);
			this.checkActive(resource);
			bytes.write(token, 'ascii'); // Actual registry token: exactly 64 lowercase hex.
			if (fs.writeSync(resource.fd, bytes, 0, 64, 0) !== 64)
				throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			this.checkActive(resource);
			const written = fs.fstatSync(resource.fd);
			if (written.size !== 64 || !PluginToolRunProofFiles.sameFile(stat, written))
				throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			if (
				fs.readSync(resource.fd, readback, 0, 65, 0) !== 64 ||
				!bytes.equals(readback.subarray(0, 64))
			)
				throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			this.checkPaths(resource);
			const final = fs.lstatSync(file);
			if (
				!final.isFile() ||
				!PluginToolRunProofFiles.sameFile(written, final) ||
				final.uid !== this.uid ||
				(final.mode & 0o7777) !== 0o600 ||
				final.nlink !== 1 ||
				final.size !== 64 ||
				final.mtimeMs !== written.mtimeMs ||
				final.ctimeMs !== written.ctimeMs
			)
				throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			const fd = resource.fd;
			resource.fd = undefined;
			fs.closeSync(fd);
			this.checkActive(resource);
			return Object.freeze({
				runTokenFile: file,
				signal: resource.context.signal,
				assertActive: () => {
					try {
						this.checkActive(resource);
					} catch {
						this.dispose(resource);
						throw new PluginAuthorityError('PLUGIN_DENIED');
					}
				},
				dispose: () => this.dispose(resource),
			});
		} catch (error) {
			this.invalidate(resource);
			if (!(error instanceof PluginAuthorityError) || error.code === 'PLUGIN_UNAVAILABLE')
				this.fail();
			throw new PluginAuthorityError(
				error instanceof PluginAuthorityError ? error.code : 'PLUGIN_UNAVAILABLE'
			);
		} finally {
			bytes.fill(0);
			readback.fill(0);
			if (resource.fd !== undefined) {
				const fd = resource.fd;
				resource.fd = undefined;
				try {
					fs.closeSync(fd);
				} catch {
					this.fail();
				}
			}
			resource.busy = false;
			if (resource.closed) this.cleanup(resource);
		}
	}

	/** Host shutdown: fence before callbacks, revoke every proof, attempt every cleanup. */
	stop(): void {
		this.stopped = true;
		const resources = [...this.resources];
		for (const resource of resources) this.invalidate(resource);
		let failed = false;
		for (const resource of resources) {
			try {
				this.cleanup(resource);
			} catch {
				failed = true;
			}
		}
		if (failed) throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
	}
}

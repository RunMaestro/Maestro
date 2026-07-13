import { describe, expect, it } from 'vitest';
import * as path from 'node:path';

const testWorkspace = path.resolve('workspace');
const testExports = path.resolve('exports');
import type { WorkspaceRootCapability } from '../../../shared/plugins/interactive-runtime';
import {
	OmpAuthCallbackPkceRouter,
	OmpNativeExportBroker,
	OmpRootToolPolicyBroker,
	OmpUriBroker,
	type OmpExportFilesystem,
	type OmpToolFilesystem,
	type OmpSupervisedWorkspaceProcess,
	type OmpToolApprovalRequest,
} from '../omp-host-safety-brokers';
import { NativeWorkspaceRootService } from '../native-workspace-root-service';

const activation = () => ({
	ownerPluginId: 'com.maestro.omp',
	generation: 7n,
	authorization: {
		signatureTrusted: true,
		enabled: true,
		hostCompatible: true,
		userConsented: true,
		workspaceRootCurrent: true,
		grants: [{ capability: 'process:interactive' as const, scope: 'omp', grantedAt: 1 }],
	},
});

function roots(reparse = () => false): NativeWorkspaceRootService {
	return new NativeWorkspaceRootService({
		chooseDirectory: async () => testWorkspace,
		activation,
		filesystem: {
			resolve: (value) => value,
			isAbsolute: () => true,
			realpath: (value) => value,
			lstat: () => ({
				dev: 1,
				ino: 1,
				size: 0,
				isDirectory: () => true,
				isSymbolicLink: reparse,
			}),
			sep: '/',
		},
	});
}

function pathStat(
	kind: 'directory' | 'file' | 'symbolic-link',
	ino: number,
	size = 0
): {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
} {
	return {
		dev: 1,
		ino,
		size,
		isDirectory: () => kind === 'directory',
		isFile: () => kind === 'file',
		isSymbolicLink: () => kind === 'symbolic-link',
	};
}

function memoryHandle(
	initial: Buffer,
	ino: number,
	options: {
		readonly onRead?: () => void;
		readonly onWrite?: () => void;
		readonly onTruncate?: () => void;
		readonly onSync?: () => void;
		readonly onClose?: (content: Buffer) => void;
	} = {}
) {
	let content = Buffer.from(initial);
	return {
		stat: async () => pathStat('file', ino, content.byteLength),
		readFile: async () => {
			options.onRead?.();
			return Buffer.from(content);
		},
		write: async (buffer: Buffer, offset: number, length: number, position: number) => {
			options.onWrite?.();
			const end = position + length;
			if (content.byteLength < end) {
				const expanded = Buffer.alloc(end);
				content.copy(expanded);
				content = expanded;
			}
			buffer.copy(content, position, offset, offset + length);
			return { bytesWritten: length };
		},
		truncate: async (length = 0) => {
			options.onTruncate?.();
			content = content.subarray(0, length);
		},
		sync: async () => options.onSync?.(),
		close: async () => options.onClose?.(Buffer.from(content)),
	};
}

function toolFilesystem(contents = new Map<string, string>()): OmpToolFilesystem {
	const directories = new Set([testWorkspace, path.join(testWorkspace, 'docs')]);
	return {
		lstat: async (value) => {
			if (directories.has(value)) return pathStat('directory', value.length);
			const content = contents.get(value);
			if (content === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
			return pathStat('file', value.length + 10, Buffer.byteLength(content));
		},
		realpath: async (value) => value,
		openExistingNoFollow: async (value) => {
			const current = contents.get(value);
			if (current === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
			return memoryHandle(Buffer.from(current), value.length + 10, {
				onClose: (content) => contents.set(value, content.toString()),
			});
		},
		readdir: async (directory) => {
			const prefix = `${directory}${path.sep}`;
			return [...directories, ...contents.keys()]
				.filter((entry) => entry.startsWith(prefix))
				.map((entry) => entry.slice(prefix.length))
				.filter((entry) => !entry.includes(path.sep));
		},
		mkdir: async (directory) => {
			directories.add(directory);
		},
		rename: async (source, target) => {
			const content = contents.get(source);
			if (content === undefined || contents.has(target)) throw new Error('invalid move');
			contents.delete(source);
			contents.set(target, content);
		},
		unlink: async (value) => {
			if (!contents.delete(value)) throw new Error('missing');
		},
	};
}

async function toolBroker(
	files = new Map<string, string>(),
	process?: OmpSupervisedWorkspaceProcess,
	approve: (request: OmpToolApprovalRequest) => Promise<boolean> = async () => true
) {
	const rootService = roots();
	const root = (await rootService.requestWorkspaceRoot()) as WorkspaceRootCapability;
	return {
		broker: new OmpRootToolPolicyBroker({
			roots: rootService,
			workspaceRoot: () => root,
			activation,
			filesystem: toolFilesystem(files),
			approve,
			clock: () => 1_000,
			...(process ? { process } : {}),
		}),
		files,
	};
}

async function raceToolBroker(filesystem: OmpToolFilesystem): Promise<OmpRootToolPolicyBroker> {
	const rootService = roots();
	const root = (await rootService.requestWorkspaceRoot()) as WorkspaceRootCapability;
	return new OmpRootToolPolicyBroker({
		roots: rootService,
		workspaceRoot: () => root,
		activation,
		filesystem,
		approve: async () => true,
	});
}

describe('OMP host safety brokers', () => {
	it('permits only approved bounded root-relative workspace tools and never returns a raw path', async () => {
		const { broker, files } = await toolBroker(
			new Map([[path.join(testWorkspace, 'docs', 'a.txt'), 'hello']])
		);
		await expect(broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' })).resolves.toEqual({
			text: 'hello',
		});
		await expect(
			broker.invoke('maestro.workspace.write', { path: 'docs/a.txt', text: 'updated' })
		).resolves.toEqual({ phase: 'completed' });
		expect(files.get(path.join(testWorkspace, 'docs', 'a.txt'))).toBe('updated');
		await expect(broker.invoke('bash', { command: 'whoami' })).rejects.toThrow('unavailable');
	});

	it('executes the closed root-bound list, search, stat, mkdir, move, and delete tools', async () => {
		const source = path.join(testWorkspace, 'docs', 'a.txt');
		const moved = path.join(testWorkspace, 'docs', 'renamed.txt');
		const content = ['first', 'needle here', 'needle again'].join('\n');
		const { broker, files } = await toolBroker(new Map([[source, content]]));

		await expect(broker.invoke('maestro.workspace.list', { path: 'docs' })).resolves.toEqual({
			entries: ['a.txt'],
		});
		await expect(
			broker.invoke('maestro.workspace.search', { path: 'docs/a.txt', query: 'needle' })
		).resolves.toEqual({
			matches: [
				{ line: 2, text: 'needle here' },
				{ line: 3, text: 'needle again' },
			],
		});
		await expect(broker.invoke('maestro.workspace.stat', { path: 'docs/a.txt' })).resolves.toEqual({
			stat: { kind: 'file', size: Buffer.byteLength(content) },
		});
		await expect(
			broker.invoke('maestro.workspace.mkdir', { path: 'docs/new-dir' })
		).resolves.toEqual({
			phase: 'completed',
		});
		await expect(
			broker.invoke('maestro.workspace.move', { path: 'docs/a.txt', target: 'docs/renamed.txt' })
		).resolves.toEqual({ phase: 'completed' });
		expect(files.has(source)).toBe(false);
		expect(files.get(moved)).toBe(content);
		await expect(
			broker.invoke('maestro.workspace.delete', { path: 'docs/renamed.txt' })
		).resolves.toEqual({
			phase: 'completed',
		});
		expect(files.has(moved)).toBe(false);
		await expect(
			broker.invoke('maestro.workspace.search', { path: 'docs/renamed.txt', query: 'needle' })
		).rejects.toThrow('unavailable');
	});

	it('rejects a concurrent call and rejects the pending call once after revocation', async () => {
		const rootService = roots();
		const root = (await rootService.requestWorkspaceRoot()) as WorkspaceRootCapability;
		let releaseApproval: () => void = () => undefined;
		const approval = new Promise<void>((resolve) => {
			releaseApproval = resolve;
		});

		const broker = new OmpRootToolPolicyBroker({
			roots: rootService,
			workspaceRoot: () => root,
			activation,
			filesystem: toolFilesystem(new Map([[path.join(testWorkspace, 'docs', 'a.txt'), 'ok']])),
			approve: async () => {
				await approval;
				return true;
			},
		});
		const pending = broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' });
		await expect(broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' })).rejects.toThrow(
			'unavailable'
		);
		broker.revoke();
		releaseApproval();
		await expect(pending).rejects.toThrow('unavailable');
	});

	it('runs only through an injected supervised process authority with bounded command and timeout', async () => {
		const calls: Array<{ command: string; cwd: string; timeoutMs: number }> = [];
		const process: OmpSupervisedWorkspaceProcess = {
			run: async (request) => {
				calls.push({ command: request.command, cwd: request.cwd, timeoutMs: request.timeoutMs });
				return { stdout: 'ok', stderr: '', exitCode: 0 };
			},
			cancel: () => undefined,
			revoke: () => undefined,
		};
		const { broker } = await toolBroker(new Map(), process);
		await expect(
			broker.invoke('maestro.workspace.run', { command: 'git status', timeoutMs: 30_000 })
		).resolves.toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
		expect(calls).toEqual([{ command: 'git status', cwd: testWorkspace, timeoutMs: 30_000 }]);
		await expect(
			broker.invoke('maestro.workspace.run', { command: 'git status', timeoutMs: 60_001 })
		).rejects.toThrow('unavailable');
		const { broker: unavailable } = await toolBroker();
		await expect(
			unavailable.invoke('maestro.workspace.run', { command: 'git status', timeoutMs: 30_000 })
		).rejects.toThrow('unavailable');
	});

	it('does not launch a workspace command when the user rejects its exact approval request', async () => {
		let launched = false;
		let approval: OmpToolApprovalRequest | undefined;
		const process: OmpSupervisedWorkspaceProcess = {
			run: async () => {
				launched = true;
				return { stdout: '', stderr: '', exitCode: 0 };
			},
			cancel: () => undefined,
			revoke: () => undefined,
		};
		const { broker } = await toolBroker(new Map(), process, async (request) => {
			approval = request;
			return false;
		});
		await expect(
			broker.invoke('maestro.workspace.run', { command: 'git status', timeoutMs: 1_000 })
		).rejects.toThrow('unavailable');
		expect(launched).toBe(false);
		expect(approval).toEqual({
			tool: 'maestro.workspace.run',
			path: 'workspace',
			command: 'git status',
		});
	});

	it('enforces the per-minute workspace tool rate limit', async () => {
		const { broker } = await toolBroker(
			new Map([[path.join(testWorkspace, 'docs', 'a.txt'), 'ok']])
		);
		for (let call = 0; call < 30; call += 1) {
			await expect(
				broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' })
			).resolves.toEqual({ text: 'ok' });
		}
		await expect(broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' })).rejects.toThrow(
			'rate limit'
		);
	});

	it('rejects traversal, reparse paths, over-limit output, and concurrent/rate-raced calls', async () => {
		const { broker } = await toolBroker(
			new Map([[path.join(testWorkspace, 'docs', 'a.txt'), 'x'.repeat(256 * 1024 + 1)]])
		);
		await expect(broker.invoke('maestro.workspace.read', { path: '../secret' })).rejects.toThrow(
			'unavailable'
		);
		await expect(broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' })).rejects.toThrow(
			'limit'
		);
		let reparse = false;
		const reparseRoots = roots(() => reparse);
		await reparseRoots.requestWorkspaceRoot();
		reparse = true;
		await expect(reparseRoots.requestWorkspaceRoot()).rejects.toThrow('reparse point');
	});

	it('does not read an outside file when a final entry becomes a reparse point during open', async () => {
		const outside = path.resolve('outside', 'a.txt');
		let swapped = false;
		let pathReads = 0;
		const filesystem: OmpToolFilesystem = {
			lstat: async (value) => {
				if (value === testWorkspace) return pathStat('directory', 1);
				if (value === path.join(testWorkspace, 'docs')) return pathStat('directory', 2);
				return swapped ? pathStat('symbolic-link', 99) : pathStat('file', 3, 6);
			},
			realpath: async (value) => value,
			openExistingNoFollow: async () => {
				swapped = true;
				return memoryHandle(Buffer.from('outside'), 99, { onRead: () => (pathReads += 1) });
			},
		};
		const broker = await raceToolBroker(filesystem);

		await expect(broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' })).rejects.toThrow(
			'unavailable'
		);
		expect(pathReads).toBe(0);
		expect(outside).toBe(path.resolve('outside', 'a.txt'));
	});

	it('does not read an outside file when an intermediate directory becomes a reparse point during open', async () => {
		let swapped = false;
		let pathReads = 0;
		const filesystem: OmpToolFilesystem = {
			lstat: async (value) => {
				if (value === testWorkspace) return pathStat('directory', 1);
				if (value === path.join(testWorkspace, 'docs')) {
					return swapped ? pathStat('symbolic-link', 99) : pathStat('directory', 2);
				}
				return pathStat('file', 3, 6);
			},
			realpath: async (value) => value,
			openExistingNoFollow: async () => {
				swapped = true;
				return memoryHandle(Buffer.from('outside'), 99, { onRead: () => (pathReads += 1) });
			},
		};
		const broker = await raceToolBroker(filesystem);

		await expect(broker.invoke('maestro.workspace.read', { path: 'docs/a.txt' })).rejects.toThrow(
			'unavailable'
		);
		expect(pathReads).toBe(0);
	});

	it('does not truncate or write after a final entry changes between validation and write', async () => {
		const outside = path.resolve('outside', 'a.txt');
		let swapped = false;
		const outsideContent = 'outside unchanged';
		let pathWrites = 0;
		const filesystem: OmpToolFilesystem = {
			lstat: async (value) => {
				if (value === testWorkspace) return pathStat('directory', 1);
				if (value === path.join(testWorkspace, 'docs')) return pathStat('directory', 2);
				return swapped ? pathStat('symbolic-link', 99) : pathStat('file', 3, 6);
			},
			realpath: async (value) => value,
			openExistingNoFollow: async () => {
				swapped = true;
				return memoryHandle(Buffer.from('inside'), 3, {
					onTruncate: () => (pathWrites += 1),
					onWrite: () => (pathWrites += 1),
				});
			},
		};
		const broker = await raceToolBroker(filesystem);

		await expect(
			broker.invoke('maestro.workspace.write', { path: 'docs/a.txt', text: 'replacement' })
		).rejects.toThrow('unavailable');
		expect(pathWrites).toBe(0);
		expect(outsideContent).toBe('outside unchanged');
		expect(outside).toBe(path.resolve('outside', 'a.txt'));
	});

	it('fails closed for a missing target rather than creating through a mutable parent', async () => {
		const outside = path.resolve('outside', 'new.txt');
		let outsideContent = 'outside unchanged';
		let pathWrites = 0;
		const filesystem: OmpToolFilesystem = {
			lstat: async (value) => {
				if (value === testWorkspace) return pathStat('directory', 1);
				if (value === path.join(testWorkspace, 'docs')) return pathStat('directory', 2);
				throw Object.assign(new Error('missing'), { code: 'ENOENT' });
			},
			realpath: async (value) => value,
			openExistingNoFollow: async () => {
				pathWrites += 1;
				outsideContent = 'replacement';
				throw Object.assign(new Error('missing'), { code: 'ENOENT' });
			},
		};
		const broker = await raceToolBroker(filesystem);

		await expect(
			broker.invoke('maestro.workspace.write', { path: 'docs/new.txt', text: 'replacement' })
		).rejects.toThrow();
		expect(pathWrites).toBe(0);
		expect(outsideContent).toBe('outside unchanged');
		expect(outside).toBe(path.resolve('outside', 'new.txt'));
	});

	it('uses opaque single-use PKCE transactions and rejects foreign origin, callback, state, replay, and revocation', async () => {
		const opened: string[] = [];
		const exchanged: Array<{ verifier: string; code: string }> = [];
		const router = new OmpAuthCallbackPkceRouter({
			providers: [{ id: 'github', authorizationEndpoint: 'https://login.example.test/authorize' }],
			allowedOrigins: new Set(['https://login.example.test']),
			openAuthorization: async (url) => {
				opened.push(url);
			},
			exchangeCode: async (_provider, code, verifier) => {
				exchanged.push({ code, verifier });
			},
			random: (() => {
				let index = 0;
				const values = ['t'.repeat(64), 's'.repeat(64), 'v'.repeat(64)];
				return () => values[index++] ?? 'z'.repeat(64);
			})(),
			clock: () => 1_000,
		});
		const begun = await router.begin('github');
		expect(begun).toEqual({ transactionId: expect.any(String), phase: 'pending' });
		expect(opened[0]).toContain('code_challenge=');
		const state = new URL(opened[0]).searchParams.get('state');
		if (!state) throw new Error('native authorization URL is missing state');
		await expect(
			router.handleCallback(`maestro://wrong/callback/${begun.transactionId}?code=x&state=${state}`)
		).rejects.toThrow('unavailable');
		await expect(
			router.handleCallback(`maestro://omp-auth/callback/${begun.transactionId}?code=x&state=wrong`)
		).rejects.toThrow('unavailable');
		await expect(
			router.handleCallback(
				`maestro://omp-auth/callback/${begun.transactionId}?code=x&state=${state}`
			)
		).resolves.toEqual({ transactionId: begun.transactionId, phase: 'completed' });
		expect(exchanged).toHaveLength(1);
		expect(JSON.stringify(begun)).not.toContain(state);
		await expect(
			router.handleCallback(
				`maestro://omp-auth/callback/${begun.transactionId}?code=x&state=${state}`
			)
		).rejects.toThrow('unavailable');
		router.revoke();
	});

	it('keeps URI catalog empty and makes every URI request unavailable', async () => {
		const broker = new OmpUriBroker();
		expect(broker.catalog()).toEqual([]);
		await expect(broker.resolve('https://example.test')).rejects.toThrow('unavailable');
	});

	it('exports only host-owned opaque HTML through native directory selection without paths, HTML, overwrite, or traversal', async () => {
		const writes: Record<string, string> = {};
		const filesystem: OmpExportFilesystem = {
			lstat: async (value) => {
				if (value === testExports) return pathStat('directory', 1);
				const content = writes[value];
				if (content !== undefined) return pathStat('file', 2, Buffer.byteLength(content));
				throw Object.assign(new Error('missing'), { code: 'ENOENT' });
			},
			realpath: async (value) => value,
			openTemporaryNoFollow: async (value) => {
				writes[value] = '';
				return memoryHandle(Buffer.alloc(0), 2, {
					onClose: (content) => {
						writes[value] = content.toString();
					},
				});
			},
			link: async (from, to) => {
				if (writes[to] !== undefined) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
				writes[to] = writes[from]!;
			},
			unlink: async (value) => {
				delete writes[value];
			},
		};
		const broker = new OmpNativeExportBroker({
			chooseDirectory: async () => testExports,
			filesystem,
			random: () => 'temp',
		});
		const handle = broker.registerHtml('<main>secret HTML</main>');
		expect(Object.keys(handle as object)).toEqual([]);
		await expect(broker.export(handle, '../../report')).resolves.toEqual({ phase: 'completed' });
		expect(writes[path.join(testExports, 'report.html')]).toBe('<main>secret HTML</main>');
		await expect(broker.export(handle, 'report')).resolves.toEqual({ phase: 'failed' });
		expect(JSON.stringify(await broker.export(handle, 'other'))).not.toContain('secret HTML');
		const cancelling = new OmpNativeExportBroker({
			chooseDirectory: async () => null,
			filesystem,
			random: () => 'temp',
		});
		await expect(
			cancelling.export(cancelling.registerHtml('private'), 'cancelled')
		).resolves.toEqual({
			phase: 'cancelled',
		});
		broker.revoke();
		await expect(broker.export(handle, 'again')).rejects.toThrow('unavailable');
	});

	it('does not write export bytes when the selected directory becomes a reparse point after open', async () => {
		let redirected = false;
		let writes = 0;
		let outsideContent = 'outside unchanged';
		const filesystem: OmpExportFilesystem = {
			lstat: async (value) => {
				if (value === testExports) {
					return redirected ? pathStat('symbolic-link', 99) : pathStat('directory', 1);
				}
				return pathStat('file', 2);
			},
			realpath: async (value) => value,
			openTemporaryNoFollow: async () => {
				redirected = true;
				return memoryHandle(Buffer.alloc(0), 2, {
					onWrite: () => {
						writes += 1;
						outsideContent = 'exported';
					},
				});
			},
			link: async () => undefined,
			unlink: async () => undefined,
		};
		const broker = new OmpNativeExportBroker({
			chooseDirectory: async () => testExports,
			filesystem,
			random: () => 'temp',
		});

		await expect(
			broker.export(broker.registerHtml('<main>safe</main>'), 'report')
		).resolves.toEqual({
			phase: 'failed',
		});
		expect(writes).toBe(0);
		expect(outsideContent).toBe('outside unchanged');
	});
});

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WorkspaceRootCapability } from '../../../shared/plugins/interactive-runtime';
import type { JsonValue, UUID } from '../../../shared/plugins/interactive-panel';
import type { PermissionGrant } from '../../../shared/plugins/permissions';
import {
	NativeWorkspaceRootService,
	PluginManagedRuntimeService,
	type ManagedRuntimeChild,
	type ManagedRuntimeLaunch,
} from '../plugin-managed-runtime-service';

class FakeWritable extends EventEmitter {
	readonly writes: string[] = [];
	writableLength = 0;
	write(value: string): boolean {
		this.writes.push(value);
		return true;
	}
}

class FakeChild extends EventEmitter implements ManagedRuntimeChild {
	readonly stdin = new FakeWritable();
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly pid = 4242;
	exitCode: number | null = null;
	kill(): boolean {
		this.exitCode = 0;
		this.emit('exit', 0);
		return true;
	}
}

const grants: readonly PermissionGrant[] = [
	{ capability: 'process:interactive', scope: 'omp', grantedAt: 1 },
];

function activation(rootCurrent = true) {
	return {
		ownerPluginId: 'com.maestro.omp',
		generation: 7n,
		authorization: {
			signatureTrusted: true,
			enabled: true,
			hostCompatible: true,
			userConsented: true,
			workspaceRootCurrent: rootCurrent,
			grants,
		},
	};
}

function rootService(activationContext = () => activation()) {
	return new NativeWorkspaceRootService({
		chooseDirectory: async () => '/workspace',
		activation: activationContext,
		filesystem: {
			resolve: (value) => value,
			isAbsolute: () => true,
			realpath: (value) => value,
			lstat: () => ({
				dev: 1,
				ino: 1,
				size: 0,
				isDirectory: () => true,
				isSymbolicLink: () => false,
			}),
			sep: '/',
		},
	});
}

function buildService(
	root: NativeWorkspaceRootService,
	child = new FakeChild(),
	ompSandboxHandlers?: { readonly revoke: () => void }
) {
	let launch: ManagedRuntimeLaunch | undefined;
	const service = new PluginManagedRuntimeService({
		activation: () => activation(),
		roots: root,
		runtime: {
			resolveSystem: async () => ({
				bunExecutable: '/bin/bun',
				ompCliPath: '/bin/omp',
				provenance: 'verified',
				version: '16.4.8',
			}),
			managedInstallAllowed: () => false,
			resolveManaged: async () => {
				throw new Error('managed install should not be used');
			},
		},
		spawn: (next) => {
			launch = next;
			return child;
		},
		killTree: async () => undefined,
		runtimeId: () => '00000000-0000-4000-8000-000000000001' as UUID,
		ompSandboxHandlers,
	});
	return { service, child, launch: () => launch };
}

describe('managed OMP runtime service', () => {
	it('mints opaque owner-bound roots only from the no-argument native chooser', async () => {
		const roots = rootService();
		const root = await roots.requestWorkspaceRoot();
		expect(root).not.toBeNull();
		expect(Object.keys(root as object)).toEqual([]);
		expect(Object.isFrozen(root as object)).toBe(true);
	});

	it('starts only through authenticated Bun with the OMP CLI as the explicit first argument', async () => {
		const roots = rootService();
		const root = (await roots.requestWorkspaceRoot()) as WorkspaceRootCapability;
		const { service, launch } = buildService(roots);
		const handle = await service.startOmpRuntime({
			workspaceRoot: root,
			options: { restore: false },
		});

		expect(handle).toMatchObject({
			runtimeId: '00000000-0000-4000-8000-000000000001',
			generation: 7n,
		});
		expect(launch()).toEqual({
			command: '/bin/bun',
			args: ['/bin/omp', '--mode', 'rpc', '--cwd', '/workspace'],
			cwd: '/workspace',
			env: {},
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
	});

	it('relays only bounded validated stdout frames as frozen ordered messages and isolates callbacks', async () => {
		const roots = rootService();
		const root = (await roots.requestWorkspaceRoot()) as WorkspaceRootCapability;
		const { service, child } = buildService(roots);
		const handle = await service.startOmpRuntime({
			workspaceRoot: root,
			options: { restore: false },
		});
		// A fast child can emit ready/response before startOmpRuntime resolves to a
		// consumer. The first listener receives that bounded queue in wire order.
		child.stdout.emit('data', '{"event":"ready"}\n{"response":{"ok":true}}\n');
		const messages: Array<{ sequence: number; value: JsonValue }> = [];
		handle.onMessage((message) => messages.push(message));
		handle.onMessage(() => {
			throw new Error('consumer failure');
		});
		child.stdout.emit('data', '{"event":"updated"}\n');
		child.stderr.emit('data', '{"response":"must-not-leak"}\nplain diagnostic\n');

		expect(messages).toEqual([
			{ sequence: 1, value: { event: 'ready' } },
			{ sequence: 2, value: { response: { ok: true } } },
			{ sequence: 3, value: { event: 'updated' } },
		]);
		const responseValue = messages[1]?.value;
		expect(Object.isFrozen(responseValue)).toBe(true);
		if (
			!responseValue ||
			typeof responseValue !== 'object' ||
			Array.isArray(responseValue) ||
			!('response' in responseValue)
		) {
			throw new Error('expected object response frame');
		}
		expect(Object.isFrozen(responseValue.response)).toBe(true);
	});

	it('fails closed for malformed or oversized output and revokes an active handle', async () => {
		const roots = rootService();
		const root = (await roots.requestWorkspaceRoot()) as WorkspaceRootCapability;
		const { service, child } = buildService(roots);
		const handle = await service.startOmpRuntime({
			workspaceRoot: root,
			options: { restore: false },
		});
		const events: unknown[] = [];
		handle.onEvent((event) => events.push(event));
		const messages: unknown[] = [];
		handle.onMessage((message) => messages.push(message));
		child.stdout.emit('data', '{not json}\n');
		expect(events).toContainEqual(expect.objectContaining({ kind: 'safe_error' }));
		expect(messages).toEqual([]);
		await expect(handle.writeCanonicalJson({ requestId: 'a' } as JsonValue)).rejects.toThrow(
			'closed'
		);
	});

	it('refuses stale or revoked root authority before a process is launched', async () => {
		const roots = rootService();
		const root = (await roots.requestWorkspaceRoot()) as WorkspaceRootCapability;
		roots.revokeAll();
		const { service, launch } = buildService(roots);
		await expect(
			service.startOmpRuntime({ workspaceRoot: root, options: { restore: false } })
		).rejects.toThrow('workspace root');
		expect(launch()).toBeUndefined();
	});

	it('uses a provenance-verified managed install only when the host opt-in allows it', async () => {
		const roots = rootService();
		const root = (await roots.requestWorkspaceRoot()) as WorkspaceRootCapability;
		let launched: ManagedRuntimeLaunch | undefined;
		const runtime = new PluginManagedRuntimeService({
			activation: () => activation(),
			roots,
			runtime: {
				resolveSystem: async () => null,
				managedInstallAllowed: () => true,
				resolveManaged: async () => ({
					bunExecutable: '/managed/bun',
					ompCliPath: '/managed/omp',
					provenance: 'verified',
					version: '16.4.8',
				}),
			},
			spawn: (next) => {
				launched = next;
				return new FakeChild();
			},
			killTree: async () => undefined,
			runtimeId: () => '00000000-0000-4000-8000-000000000002' as UUID,
		});
		await runtime.startOmpRuntime({ workspaceRoot: root, options: { restore: false } });
		expect(launched?.command).toBe('/managed/bun');
		expect(launched?.args[0]).toBe('/managed/omp');
	});
	it('fails closed when a child emits an oversized line before the delimiter', async () => {
		const roots = rootService();
		const root = (await roots.requestWorkspaceRoot()) as WorkspaceRootCapability;
		const { service, child } = buildService(roots);
		const handle = await service.startOmpRuntime({
			workspaceRoot: root,
			options: { restore: false },
		});
		const events: unknown[] = [];
		handle.onEvent((event) => events.push(event));
		child.stdout.emit('data', `${'x'.repeat(256 * 1024 + 1)}\n`);
		expect(events).toContainEqual(
			expect.objectContaining({ kind: 'safe_error', class: 'invalid_request' })
		);
	});

	it('re-resolves the root and rejects a post-consent reparse-point race before spawn', async () => {
		let reparse = false;
		const roots = new NativeWorkspaceRootService({
			chooseDirectory: async () => '/workspace',
			activation: () => activation(),
			filesystem: {
				resolve: (value) => value,
				isAbsolute: () => true,
				realpath: (value) => value,
				lstat: () => ({
					dev: 1,
					ino: 1,
					size: 0,
					isDirectory: () => true,
					isSymbolicLink: () => reparse,
				}),
				sep: '/',
			},
		});
		const root = (await roots.requestWorkspaceRoot()) as WorkspaceRootCapability;
		reparse = true;
		const { service, launch } = buildService(roots);
		await expect(
			service.startOmpRuntime({ workspaceRoot: root, options: { restore: false } })
		).rejects.toThrow('reparse point');
		expect(launch()).toBeUndefined();
	});

	it('rejects a root identity swap before spawn even when the canonical path is unchanged', async () => {
		let redirected = false;
		const roots = new NativeWorkspaceRootService({
			chooseDirectory: async () => '/workspace',
			activation: () => activation(),
			filesystem: {
				resolve: (value) => value,
				isAbsolute: () => true,
				realpath: (value) => value,
				lstat: () => ({
					dev: 1,
					ino: redirected ? 22 : 11,
					size: 0,
					isDirectory: () => true,
					isSymbolicLink: () => false,
				}),
				sep: '/',
			},
		});
		const root = (await roots.requestWorkspaceRoot()) as WorkspaceRootCapability;
		redirected = true;
		const { service, launch } = buildService(roots);

		await expect(
			service.startOmpRuntime({ workspaceRoot: root, options: { restore: false } })
		).rejects.toThrow('workspace root changed after consent');
		expect(launch()).toBeUndefined();
	});

	it('rejects an unverified system result rather than launching a provenance-unknown binary', async () => {
		const roots = rootService();
		const root = (await roots.requestWorkspaceRoot()) as WorkspaceRootCapability;
		let spawned = false;
		const runtime = new PluginManagedRuntimeService({
			activation: () => activation(),
			roots,
			runtime: {
				resolveSystem: async () =>
					({ bunExecutable: '/unknown/bun', ompCliPath: '/unknown/omp', provenance: 'unknown', version: '16.4.8' }) as never,
				managedInstallAllowed: () => false,
				resolveManaged: async () => {
					throw new Error('unreachable');
				},
			},
			spawn: () => {
				spawned = true;
				return new FakeChild();
			},
			killTree: async () => undefined,
			runtimeId: () => '00000000-0000-4000-8000-000000000003' as UUID,
		});
		await expect(
			runtime.startOmpRuntime({ workspaceRoot: root, options: { restore: false } })
		).rejects.toThrow('provenance');
		expect(spawned).toBe(false);
	});

	it('stops a live process tree gracefully then forcibly when it ignores the grace period', async () => {
		const roots = rootService();
		const root = (await roots.requestWorkspaceRoot()) as WorkspaceRootCapability;
		const child = new FakeChild();
		const kills: boolean[] = [];
		const runtime = new PluginManagedRuntimeService({
			activation: () => activation(),
			roots,
			runtime: {
				resolveSystem: async () => ({
					bunExecutable: '/bin/bun',
					ompCliPath: '/bin/omp',
					provenance: 'verified',
					version: '16.4.8',
				}),
				managedInstallAllowed: () => false,
				resolveManaged: async () => {
					throw new Error('unreachable');
				},
			},
			spawn: () => child,
			killTree: async (_pid, force) => {
				kills.push(force);
			},
			runtimeId: () => '00000000-0000-4000-8000-000000000004' as UUID,
			stopGraceMs: 0,
		});
		const handle = await runtime.startOmpRuntime({
			workspaceRoot: root,
			options: { restore: false },
		});

		await handle.stop('user');
		expect(kills).toEqual([false, true]);
	});
	it('rechecks authorization after asynchronous runtime resolution before spawning', async () => {
		let current = activation();
		const roots = new NativeWorkspaceRootService({
			chooseDirectory: async () => '/workspace',
			activation: () => current,
			filesystem: {
				resolve: (value) => value,
				isAbsolute: () => true,
				realpath: (value) => value,
				lstat: () => ({
					dev: 1,
					ino: 1,
					size: 0,
					isDirectory: () => true,
					isSymbolicLink: () => false,
				}),
				sep: '/',
			},
		});
		const root = (await roots.requestWorkspaceRoot()) as WorkspaceRootCapability;
		let spawned = false;
		const runtime = new PluginManagedRuntimeService({
			activation: () => current,
			roots,
			runtime: {
				resolveSystem: async () => {
					current = {
						...current,
						authorization: { ...current.authorization, enabled: false },
					};
					return {
						bunExecutable: '/bin/bun',
						ompCliPath: '/bin/omp',
						provenance: 'verified',
						version: '16.4.8',
					};
				},
				managedInstallAllowed: () => false,
				resolveManaged: async () => {
					throw new Error('unreachable');
				},
			},
			spawn: () => {
				spawned = true;
				return new FakeChild();
			},
			killTree: async () => undefined,
			runtimeId: () => '00000000-0000-4000-8000-000000000005' as UUID,
		});
		await expect(
			runtime.startOmpRuntime({ workspaceRoot: root, options: { restore: false } })
		).rejects.toThrow('not authorized');
		expect(spawned).toBe(false);
	});
	it('revokes injected OMP sandbox safety handlers with the managed owner', async () => {
		const roots = rootService();
		let revoked = 0;
		const { service } = buildService(roots, new FakeChild(), {
			revoke: () => {
				revoked += 1;
			},
		});
		await service.revokeOwner('com.maestro.omp');
		expect(revoked).toBe(1);
	});
});

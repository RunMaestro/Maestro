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
			lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
			sep: '/',
		},
	});
}

function buildService(root: NativeWorkspaceRootService, child = new FakeChild()) {
	let launch: ManagedRuntimeLaunch | undefined;
	const service = new PluginManagedRuntimeService({
		activation: () => activation(),
		roots: root,
		runtime: {
			resolveSystem: async () => ({
				executable: '/bin/omp',
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

	it('starts only from a current authorized root with host-owned argv, env, cwd, and shell-free stdio', async () => {
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
			command: '/bin/omp',
			args: ['--mode', 'rpc', '--cwd', '/workspace'],
			cwd: '/workspace',
			env: {},
			shell: false,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
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
		child.stdout.emit('data', '{not json}\n');
		expect(events).toContainEqual(expect.objectContaining({ kind: 'safe_error' }));
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
					executable: '/managed/omp',
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
		expect(launched?.command).toBe('/managed/omp');
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
				lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => reparse }),
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

	it('rejects an unverified system result rather than launching a provenance-unknown binary', async () => {
		const roots = rootService();
		const root = (await roots.requestWorkspaceRoot()) as WorkspaceRootCapability;
		let spawned = false;
		const runtime = new PluginManagedRuntimeService({
			activation: () => activation(),
			roots,
			runtime: {
				resolveSystem: async () =>
					({ executable: '/unknown/omp', provenance: 'unknown', version: '16.4.8' }) as never,
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
					executable: '/bin/omp',
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
				lstat: () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
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
					return { executable: '/bin/omp', provenance: 'verified', version: '16.4.8' };
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
});

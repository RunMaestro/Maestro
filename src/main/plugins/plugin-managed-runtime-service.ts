import { spawn as nodeSpawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

import type { JsonValue, UUID } from '../../shared/plugins/interactive-panel';
import {
	isInteractiveRuntimeAuthorized,
	type InteractiveRuntimeHandle,
	type InteractiveStopReason,
	type MaestroInteractiveRuntimeApi,
	type OmpSafeStartupOptions,
	type RuntimeEvent,
	type RuntimeMessage,
	type WorkspaceRootCapability,
} from '../../shared/plugins/interactive-runtime';
import {
	ManagedRuntimeProcess,
	defaultProcessTreeKiller,
	type ManagedRuntimeChild,
	type ManagedRuntimeLaunch,
	type ProcessTreeKiller,
} from './managed-runtime-process';
import {
	NativeWorkspaceRootService,
	type RuntimeActivationContext,
} from './native-workspace-root-service';
import type { OmpSandboxHostHandlerSeam } from './omp-host-safety-brokers';

/** The runtime service owns only teardown of this injected host safety seam. */
export type OmpManagedRuntimeSandboxHandlers = Pick<OmpSandboxHostHandlerSeam, 'revoke'>;

export { NativeWorkspaceRootService } from './native-workspace-root-service';
export type { ManagedRuntimeChild, ManagedRuntimeLaunch } from './managed-runtime-process';

const OMP_RUNTIME_VERSION = '16.4.8' as const;

export interface VerifiedRuntimeExecutable {
	/** Authenticated absolute Bun executable; never discovered from PATH. */
	readonly bunExecutable: string;
	/** Authenticated absolute OMP CLI module executed as Bun's explicit first arg. */
	readonly ompCliPath: string;
	readonly version: typeof OMP_RUNTIME_VERSION;
	/** Provenance is established by the host distributor, never a PATH lookup. */
	readonly provenance: 'verified';
}

/**
 * Host distribution policy. `resolveManaged` is responsible for consuming the
 * signed 2b5a0ee3 package pipeline (metadata, npm provenance, tarball checks,
 * notice preservation, and atomic installation) before it returns an executable.
 */
export interface ManagedRuntimeResolver {
	readonly resolveSystem: () => Promise<VerifiedRuntimeExecutable | null>;
	readonly managedInstallAllowed: () => boolean;
	readonly resolveManaged: () => Promise<VerifiedRuntimeExecutable>;
}

export type ManagedRuntimeSpawner = (launch: ManagedRuntimeLaunch) => ManagedRuntimeChild;

export interface PluginManagedRuntimeServiceDependencies {
	/** Manager-owned activation facts; no public call can supply an owner or grants. */
	readonly activation: () => RuntimeActivationContext | null;
	readonly roots: NativeWorkspaceRootService;
	readonly runtime: ManagedRuntimeResolver;
	readonly spawn?: ManagedRuntimeSpawner;
	readonly killTree?: ProcessTreeKiller;
	readonly runtimeId?: () => UUID;
	readonly stopGraceMs?: number;
	/** Injected by bootstrap; lifecycle authority stays with the managed runtime owner. */
	readonly ompSandboxHandlers?: OmpManagedRuntimeSandboxHandlers;
}

/**
 * Host authority for the fixed OMP interactive runtime. The public shape is
 * deliberately identical to the SDK capability: a root capability and the
 * one safe option. Owner, generation, executable, argv, environment, process
 * identity, streams, and teardown remain private here.
 */
export class PluginManagedRuntimeService implements MaestroInteractiveRuntimeApi {
	private readonly active = new Map<string, ActiveRuntime>();
	private readonly spawn: ManagedRuntimeSpawner;
	private readonly killTree: ProcessTreeKiller;
	private readonly runtimeId: () => UUID;

	constructor(private readonly deps: PluginManagedRuntimeServiceDependencies) {
		this.spawn = deps.spawn ?? defaultSpawn;
		this.killTree = deps.killTree ?? defaultProcessTreeKiller;
		this.runtimeId = deps.runtimeId ?? defaultRuntimeId;
	}

	requestWorkspaceRoot(): Promise<WorkspaceRootCapability | null> {
		return this.deps.roots.requestWorkspaceRoot();
	}

	async startOmpRuntime(input: {
		readonly workspaceRoot: WorkspaceRootCapability;
		readonly options: OmpSafeStartupOptions;
	}): Promise<InteractiveRuntimeHandle> {
		assertSafeInput(input);
		const activation = this.requireAuthorizedActivation();
		this.deps.roots.resolveCurrent(
			input.workspaceRoot,
			activation.ownerPluginId,
			activation.generation
		);
		const executable = await this.resolveExecutable();
		const current = this.requireAuthorizedActivation();
		if (
			current.ownerPluginId !== activation.ownerPluginId ||
			current.generation !== activation.generation
		) {
			throw new Error('workspace root capability is unavailable');
		}
		const currentRoot = this.deps.roots.resolveCurrent(
			input.workspaceRoot,
			current.ownerPluginId,
			current.generation
		);
		const key = activeKey(current.ownerPluginId, current.generation);
		if (this.active.has(key)) throw new Error('interactive runtime is already active');

		const runtimeId = this.runtimeId();
		assertRuntimeId(runtimeId);
		const child = this.spawn(launchFor(executable, currentRoot));
		const process = new ManagedRuntimeProcess({
			child,
			killTree: this.killTree,
			stopGraceMs: this.deps.stopGraceMs,
		});
		const active: ActiveRuntime = { runtimeId, generation: activation.generation, process };
		this.active.set(key, active);
		const unsubscribe = process.onEvent((event) => {
			if (event.kind === 'exit' && this.active.get(key) === active) this.active.delete(key);
		});
		return this.createHandle(key, active, unsubscribe);
	}

	/** Host lifecycle hook: no sandbox path can preserve a process across revocation. */
	async revokeOwner(
		ownerPluginId: string,
		reason: InteractiveStopReason = 'revoked'
	): Promise<void> {
		this.deps.ompSandboxHandlers?.revoke();
		const stops: Promise<void>[] = [];
		for (const [key, active] of this.active) {
			if (!key.startsWith(`${ownerPluginId}\u0000`)) continue;
			this.active.delete(key);
			stops.push(active.process.stop(reason));
		}
		await Promise.all(stops);
	}

	private requireAuthorizedActivation(): RuntimeActivationContext {
		const activation = this.deps.activation();
		if (!activation || !isInteractiveRuntimeAuthorized(activation.authorization)) {
			throw new Error('interactive runtime capability is not authorized');
		}
		return activation;
	}

	private async resolveExecutable(): Promise<VerifiedRuntimeExecutable> {
		const system = await this.deps.runtime.resolveSystem();
		if (system) return assertVerifiedRuntime(system);
		if (!this.deps.runtime.managedInstallAllowed()) {
			throw new Error(
				'verified system OMP 16.4.8 is unavailable and managed installation is disabled'
			);
		}
		return assertVerifiedRuntime(await this.deps.runtime.resolveManaged());
	}

	private createHandle(
		key: string,
		active: ActiveRuntime,
		unsubscribe: () => void
	): InteractiveRuntimeHandle {
		return Object.freeze({
			runtimeId: active.runtimeId,
			generation: active.generation,
			writeCanonicalJson: (request: JsonValue) => active.process.writeCanonicalJson(request),
			onEvent: (listener: (event: RuntimeEvent) => void) => active.process.onEvent(listener),
			onMessage: (listener: (message: RuntimeMessage) => void) =>
				active.process.onMessage(listener),
			stop: async (reason: InteractiveStopReason) => {
				if (this.active.get(key) !== active) return;
				this.active.delete(key);
				unsubscribe();
				await active.process.stop(reason);
			},
		});
	}
}

interface ActiveRuntime {
	readonly runtimeId: UUID;
	readonly generation: bigint;
	readonly process: ManagedRuntimeProcess;
}

function assertSafeInput(input: unknown): asserts input is {
	readonly workspaceRoot: WorkspaceRootCapability;
	readonly options: OmpSafeStartupOptions;
} {
	if (!input || typeof input !== 'object') throw new Error('invalid interactive runtime request');
	const record = input as Record<string, unknown>;
	if (Object.keys(record).length !== 2 || !('workspaceRoot' in record) || !('options' in record)) {
		throw new Error('invalid interactive runtime request');
	}
	if (!record.workspaceRoot || typeof record.workspaceRoot !== 'object') {
		throw new Error('invalid workspace root capability');
	}
	if (!record.options || typeof record.options !== 'object' || Array.isArray(record.options)) {
		throw new Error('invalid safe runtime options');
	}
	const options = record.options as Record<string, unknown>;
	if (Object.keys(options).length !== 1 || options.restore !== false) {
		throw new Error('invalid safe runtime options');
	}
}

function assertVerifiedRuntime(value: VerifiedRuntimeExecutable): VerifiedRuntimeExecutable {
	if (
		!value ||
		typeof value.bunExecutable !== 'string' ||
		!isAbsolute(value.bunExecutable) ||
		typeof value.ompCliPath !== 'string' ||
		!isAbsolute(value.ompCliPath) ||
		value.version !== OMP_RUNTIME_VERSION ||
		value.provenance !== 'verified'
	) {
		throw new Error('OMP runtime provenance or authenticated Bun launch verification failed');
	}
	return value;
}

function launchFor(runtime: VerifiedRuntimeExecutable, root: string): ManagedRuntimeLaunch {
	const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];
	return Object.freeze({
		command: runtime.bunExecutable,
		args: [runtime.ompCliPath, '--mode', 'rpc', '--cwd', root],
		cwd: root,
		env: Object.freeze({}),
		shell: false,
		stdio,
	});
}

const defaultSpawn: ManagedRuntimeSpawner = (launch) =>
	nodeSpawn(launch.command, [...launch.args], {
		cwd: launch.cwd,
		env: { ...launch.env },
		shell: false,
		stdio: [...launch.stdio],
	});

function defaultRuntimeId(): UUID {
	return crypto.randomUUID() as UUID;
}

function activeKey(ownerPluginId: string, generation: bigint): string {
	return `${ownerPluginId}\u0000${generation.toString()}`;
}

function assertRuntimeId(value: UUID): void {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
		throw new Error('runtime identifier source returned an invalid UUID');
	}
}

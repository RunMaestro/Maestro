import type { CanonicalWorkspaceFoundation } from '../../shared/plugins/workspace-foundation';
import type { PluginRecord } from '../../shared/plugins/plugin-registry';
import type { PermissionGrant } from '../../shared/plugins/permissions';
import {
	PluginWorkspaceRegistry,
	WorkspaceRegistryError,
	type WorkspaceCapability,
	type WorkspaceRegistryOwnerContext,
} from './plugin-workspace-registry';

/** A currently active, owner-qualified workspace declaration. */
export interface WorkspaceRuntimeRegistration {
	readonly context: WorkspaceRegistryOwnerContext;
	readonly foundation: CanonicalWorkspaceFoundation;
}

/**
 * The main-process lifecycle adapter around PluginWorkspaceRegistry.
 *
 * Declarations are reconciled only from the trusted plugin-manager view. A
 * sandbox or panel never supplies an owner, generation, or foundation to this
 * class. `acquire` returns the registry's unforgeable capability only to
 * main-process integrations; it is deliberately not serializable over IPC.
 */
export class PluginWorkspaceRuntime {
	private readonly registrations = new Map<string, WorkspaceRuntimeRegistration>();

	constructor(private readonly registry: PluginWorkspaceRegistry) {}

	/**
	 * Make the registry exactly match the active manager-owned declarations.
	 * Omitted declarations are revoked first, so disable/uninstall/reload cannot
	 * leave a usable capability behind.
	 */
	reconcile(registrations: readonly WorkspaceRuntimeRegistration[]): void {
		const next = new Map<string, WorkspaceRuntimeRegistration>();
		for (const registration of registrations) {
			const key = registrationKey(
				registration.context.ownerPluginId,
				registration.foundation.workspace.localId
			);
			if (
				next.has(key) ||
				registration.context.ownerPluginId !== registration.foundation.ownerPluginId
			) {
				throw new WorkspaceRuntimeError('capability_unavailable');
			}
			next.set(key, registration);
		}

		for (const [key, prior] of this.registrations) {
			if (next.has(key)) continue;
			this.registry.unregister(prior.context.ownerPluginId, prior.foundation.workspace.localId);
		}

		for (const registration of next.values()) {
			const { context, foundation } = registration;
			// Never retain a declaration that is no longer allowed to acquire. The
			// registry's owner-enabled callback is rechecked on every use too.
			if (!isLiveOwnerContext(context)) {
				this.registry.unregister(context.ownerPluginId, foundation.workspace.localId);
				continue;
			}
			this.registry.register(foundation, context.generation);
		}

		this.registrations.clear();
		for (const [key, registration] of next) {
			if (isLiveOwnerContext(registration.context)) this.registrations.set(key, registration);
		}
	}

	/** Acquire a current owner-bound capability for main-process use only. */
	acquire(
		ownerPluginId: string,
		workspaceLocalId: string,
		generation?: bigint
	): WorkspaceCapability {
		const registration = this.registrations.get(registrationKey(ownerPluginId, workspaceLocalId));
		if (
			!registration ||
			(generation !== undefined && generation !== registration.context.generation)
		) {
			throw new WorkspaceRuntimeError('capability_unavailable');
		}
		try {
			return this.registry.acquire(registration.context, workspaceLocalId);
		} catch (error) {
			if (error instanceof WorkspaceRegistryError) {
				throw new WorkspaceRuntimeError('capability_unavailable');
			}
			throw error;
		}
	}

	/** Revoke every declaration owned by one plugin before stopping its runtime. */
	teardown(ownerPluginId: string): void {
		for (const [key, registration] of this.registrations) {
			if (registration.context.ownerPluginId !== ownerPluginId) continue;
			this.registry.unregister(ownerPluginId, registration.foundation.workspace.localId);
			this.registrations.delete(key);
		}
	}

	/** App shutdown / plugin feature disable. */
	teardownAll(): void {
		for (const registration of this.registrations.values()) {
			this.registry.unregister(
				registration.context.ownerPluginId,
				registration.foundation.workspace.localId
			);
		}
		this.registrations.clear();
	}
}

export class WorkspaceRuntimeError extends Error {
	readonly name = 'WorkspaceRuntimeError';

	constructor(readonly code: 'capability_unavailable') {
		super(code);
	}
}

function registrationKey(ownerPluginId: string, workspaceLocalId: string): string {
	return `${ownerPluginId}\u0000${workspaceLocalId}`;
}

function isLiveOwnerContext(context: WorkspaceRegistryOwnerContext): boolean {
	return (
		context.trusted === true &&
		context.enabled === true &&
		context.grants.includes('ui:workspace') &&
		context.grants.includes('ui:interactivePanel')
	);
}

/**
 * PluginManager adapter that derives workspace registrations solely from the
 * verified active registry. A declaration's generation advances whenever it
 * appears after a stop or its canonical manifest foundation changes.
 */
export class PluginWorkspaceManagerLifecycle {
	private readonly activeOwners = new Set<string>();
	private readonly revisions = new Map<
		string,
		{ fingerprint: string; generation: bigint; active: boolean }
	>();

	constructor(
		private readonly runtime: PluginWorkspaceRuntime,
		private readonly getGrants: (pluginId: string) => readonly PermissionGrant[]
	) {}

	reconcile(records: readonly PluginRecord[]): void {
		const registrations: WorkspaceRuntimeRegistration[] = [];
		const nextActiveOwners = new Set<string>();
		for (const record of records) {
			const foundation = record.manifest?.workspaceFoundation;
			if (
				!foundation ||
				record.loadStatus !== 'ok' ||
				record.enabled !== true ||
				record.signature?.status !== 'trusted'
			) {
				continue;
			}
			const fingerprint = JSON.stringify(foundation);
			const prior = this.revisions.get(record.id);
			const generation =
				prior && prior.fingerprint === fingerprint && prior.active
					? prior.generation
					: (prior?.generation ?? 0n) + 1n;
			this.revisions.set(record.id, { fingerprint, generation, active: true });
			nextActiveOwners.add(record.id);
			registrations.push({
				context: {
					ownerPluginId: record.id,
					generation,
					trusted: true,
					enabled: true,
					grants: this.getGrants(record.id).map((grant) => grant.capability),
				},
				foundation,
			});
		}
		for (const [pluginId, revision] of this.revisions) {
			if (!nextActiveOwners.has(pluginId)) revision.active = false;
		}
		this.activeOwners.clear();
		for (const pluginId of nextActiveOwners) this.activeOwners.add(pluginId);
		this.runtime.reconcile(registrations);
	}

	teardown(pluginId: string): void {
		this.activeOwners.delete(pluginId);
		const revision = this.revisions.get(pluginId);
		if (revision) revision.active = false;
		this.runtime.teardown(pluginId);
	}

	teardownAll(): void {
		this.activeOwners.clear();
		for (const revision of this.revisions.values()) revision.active = false;
		this.runtime.teardownAll();
	}

	isOwnerEnabled(pluginId: string): boolean {
		return this.activeOwners.has(pluginId);
	}
}

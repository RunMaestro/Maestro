/**
 * Capability-bound interactive runtime contract.
 *
 * Plugin code supplies only a host-issued workspace root capability and the
 * fixed safe startup options. Binary selection, arguments, working directory,
 * environment, protocol process identity, ownership, and generation are owned
 * and validated by the host.
 */

import type { JsonValue, PanelErrorCode, UUID } from './interactive-panel';
import { isPermitted, type PermissionGrant } from './permissions';

/** Maximum canonical JSONL request frame written to a managed runtime child. */
export const MAX_INTERACTIVE_RUNTIME_INPUT_FRAME_BYTES = 3 * 1024 * 1024;
/** Maximum JSONL frame accepted from a managed runtime child's stdout data plane. */
export const MAX_INTERACTIVE_RUNTIME_OUTPUT_FRAME_BYTES = 256 * 1024;
/**
 * Interactive-runtime write calls include a small RPC wrapper around the
 * canonical child input. This remains method-specific so other host calls keep
 * the stricter generic message budget.
 */
export const MAX_INTERACTIVE_RUNTIME_WRITE_HOST_CALL_BYTES =
	MAX_INTERACTIVE_RUNTIME_INPUT_FRAME_BYTES + 16 * 1024;

/** Opaque host-minted root authority, invalidated when consent or containment changes. */
export type WorkspaceRootCapability = { readonly __hostIssuedRoot: never };

/**
 * Facts supplied by the host immediately before issuing or using an interactive
 * runtime capability. This remains pure so every host entry point applies the
 * same trust, compatibility, consent, and exact-scope requirement.
 */
export interface InteractiveRuntimeAuthorization {
	readonly signatureTrusted: boolean;
	readonly enabled: boolean;
	readonly hostCompatible: boolean;
	readonly userConsented: boolean;
	/** False once the native root is revoked, removed, or replaced. */
	readonly workspaceRootCurrent: boolean;
	readonly grants: readonly PermissionGrant[];
}

export function isInteractiveRuntimeAuthorized(
	authorization: InteractiveRuntimeAuthorization
): boolean {
	return (
		authorization.signatureTrusted &&
		authorization.enabled &&
		authorization.hostCompatible &&
		authorization.userConsented &&
		authorization.workspaceRootCurrent &&
		isPermitted(authorization.grants, 'process:interactive')
	);
}
/** The initial runtime admits no plugin-configurable startup options. */
export interface OmpSafeStartupOptions {
	readonly restore?: false;
}

export type InteractiveStopReason =
	| 'user'
	| 'workspace-deactivated'
	| 'plugin-disabled'
	| 'shutdown'
	| 'revoked';

export type RuntimeEvent =
	| { readonly kind: 'started'; readonly sequence: bigint }
	| { readonly kind: 'exit'; readonly sequence: bigint; readonly code: number | null }
	| { readonly kind: 'safe_error'; readonly sequence: bigint; readonly class: PanelErrorCode };

/** A validated, bounded JSON frame emitted by the runtime's stdout data plane. */
export interface RuntimeMessage {
	/** Per-runtime, monotonically increasing safe-integer sequence. */
	readonly sequence: number;
	/** Deeply frozen canonical JSON data; never a raw stdio chunk. */
	readonly value: JsonValue;
}

/** Closed OMP callback bridge. Root/provenance remain host-owned. */
export interface OmpHostToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly parameters: Readonly<Record<string, unknown>>;
}
export interface OmpHostToolBridge {
	catalog(runtimeId: UUID): Promise<readonly OmpHostToolDefinition[]>;
	call(
		runtimeId: UUID,
		request: { readonly id: string; readonly name: string; readonly arguments: unknown }
	): Promise<unknown>;
	cancel(runtimeId: UUID, id: string): Promise<void>;
}

/** A host-created runtime record, never a raw process, stream, or shell handle. */
export interface InteractiveRuntimeHandle {
	readonly runtimeId: UUID;
	readonly generation: bigint;
	writeCanonicalJson(request: JsonValue): Promise<void>;
	onEvent(listener: (event: RuntimeEvent) => void): () => void;
	onMessage(listener: (message: RuntimeMessage) => void): () => void;
	stop(reason: InteractiveStopReason): Promise<void>;
	readonly hostTools?: OmpHostToolBridge;
}

/**
 * The sole public runtime acquisition surface. The host resolves the root,
 * process and policy from the capability rather than plugin-provided strings.
 */
export interface MaestroInteractiveRuntimeApi {
	/**
	 * Explicit user-action path to the native chooser. A cancelled chooser
	 * returns null; plugin activation never receives a root or triggers a prompt.
	 */
	requestWorkspaceRoot(): Promise<WorkspaceRootCapability | null>;
	startOmpRuntime(input: {
		readonly workspaceRoot: WorkspaceRootCapability;
		readonly options: OmpSafeStartupOptions;
	}): Promise<InteractiveRuntimeHandle>;
}

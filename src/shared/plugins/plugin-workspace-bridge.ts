import type { ExternalSessionStatus, WorkspaceStatusSnapshot } from './workspace-foundation';

/** JSON-safe renderer projection of one registry workspace. */
export interface PluginWorkspaceProjectionDto {
	readonly ownerPluginId: string;
	readonly workspaceLocalId: string;
	readonly panelLocalId: string;
	/** Decimal encoding; Electron IPC does not clone bigint. */
	readonly generation: string;
	readonly projectionRevision: number;
	/** Registry status copied exactly, without renderer reinterpretation. */
	readonly status: WorkspaceStatusSnapshot;
	/** Registry badge copied exactly, including null. */
	readonly badge: number | null;
	readonly sessions: readonly PluginWorkspaceExternalSessionDto[];
}

/** An opaque, host-issued external session projection. */
export interface PluginWorkspaceExternalSessionDto {
	readonly externalSessionId: string;
	readonly title: string;
	readonly status: ExternalSessionStatus;
	readonly unread: number;
	readonly pendingApproval: boolean;
	readonly updatedAt: number;
	readonly snapshotToken: string;
}

/** Selected workspace session, if any. */
export interface PluginWorkspaceSelectionDto {
	readonly ownerPluginId: string;
	readonly workspaceLocalId: string;
	readonly snapshotToken: string;
}

/** Full renderer snapshot supplied only by the trusted main-window bridge. */
export interface PluginWorkspacesSnapshotDto {
	readonly connection: 'ready' | 'error';
	readonly error?: string;
	readonly workspaces: readonly PluginWorkspaceProjectionDto[];
	readonly selection: PluginWorkspaceSelectionDto | null;
}

/** Opaque session capability accepted by the host without client-supplied owner identity. */
export interface PluginWorkspaceRevealOrSelectInput {
	readonly snapshotToken: string;
}

/** Host-derived result for a currently selectable opaque session capability. */
export interface PluginWorkspaceRevealOrSelectResult {
	readonly ownerPluginId: string;
	readonly workspaceLocalId: string;
	readonly snapshotToken: string;
}

export interface PluginWorkspaceMountPanelInput {
	readonly ownerPluginId: string;
	readonly workspaceLocalId: string;
	readonly generation: string;
	readonly guestWebContentsId: number;
}

export interface PluginWorkspaceMountPanelResult {
	readonly instanceId: string;
}

export interface PluginWorkspaceUnmountPanelInput {
	readonly instanceId: string;
}

/** Narrow generic API exposed as `window.maestro.pluginWorkspaces`. */
export interface PluginWorkspacesApi {
	getSnapshot(): Promise<PluginWorkspacesSnapshotDto>;
	subscribe(listener: (snapshot: PluginWorkspacesSnapshotDto) => void): () => void;
	revealOrSelect(
		input: PluginWorkspaceRevealOrSelectInput
	): Promise<PluginWorkspaceRevealOrSelectResult | null>;
	mountPanel(input: PluginWorkspaceMountPanelInput): Promise<PluginWorkspaceMountPanelResult>;
	unmountPanel(input: PluginWorkspaceUnmountPanelInput): Promise<void>;
}

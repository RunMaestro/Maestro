/** Metadata-only view of the permission relay registry, never tool inputs or tokens. */
export interface PendingPermissionSnapshot {
	version: number;
	processIds: string[];
}

/**
 * Renderer-safe contract for the Claude Code permission relay.
 *
 * The per-spawn socket token is intentionally absent: it is main-process-only
 * authentication material and must never cross the renderer IPC boundary.
 */
export type PermissionDecision =
	| { behavior: 'allow'; updatedInput?: Record<string, unknown> }
	| { behavior: 'deny'; message: string };

/** A permission request notification the renderer may display to the user. */
export interface PermissionRequestNotification {
	requestId: string;
	sessionId: string;
	tabId?: string;
	toolName: string;
	input: Record<string, unknown>;
	createdAt: number;
}

/** Public entry points for the Claude Code permission relay. */
export {
	initPermissionRelay,
	preparePermissionRelayArgs,
	resolvePermissionResponse,
	cleanupSessionRelay,
	PERMISSION_REQUEST_CHANNEL,
} from './integration';
export { permissionRelayServer } from './PermissionRelayServer';
export type { PermissionDecision, PermissionRequest } from './types';

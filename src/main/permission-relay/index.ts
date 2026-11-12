/** Public entry points for the Claude Code permission relay. */
export {
	initPermissionRelay,
	preparePermissionRelayArgs,
	resolvePermissionResponse,
	cleanupSessionRelay,
	PERMISSION_REQUEST_CHANNEL,
} from './integration';
export { permissionRelayServer } from './PermissionRelayServer';
export { parseQuestionRequest } from './question-request';
export type {
	PermissionDecision,
	PermissionRequest,
	ParsedQuestion,
	QuestionOption,
} from './types';
export { ASK_USER_QUESTION_TOOL } from './types';

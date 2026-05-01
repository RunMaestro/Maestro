/**
 * Conversational PRD Planner — barrel re-exports.
 * @see CLAUDE-CONVERSATIONAL-PRD.md for architecture, IPC channels, persistence, and validation steps.
 */

export type {
	ConversationalPrdGateway,
	ConversationalPrdGatewayRequest,
	ConversationalPrdGatewayResponse,
	ConversationalPrdGatewayStatus,
} from './gateway';

export { StructuredConversationalPrdGateway } from './structured-gateway';

export type { IConversationalPrdStore } from './session-store';
export { InMemoryConversationalPrdStore } from './session-store';

export type { FsAdapter, PersistedConversationalPrdSession } from './file-store';
export { CONV_PRD_SESSIONS_FILE, FileConversationalPrdStore } from './file-store';

export { ConversationalPrdService } from './service';

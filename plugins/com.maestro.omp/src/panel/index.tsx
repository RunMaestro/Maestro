// WorkspaceRpcTransport supplies the frozen host-global binding in a later slice.
// This entry intentionally exports only the unprivileged panel surface until then.
export { OmpWorkspace } from './OmpWorkspace';
export type {
	OmpAttachment,
	OmpComposerMode,
	OmpConnectionState,
	OmpSessionStatus,
	OmpSubagent,
	OmpTreeNode,
	OmpUsage,
	OmpWorkspaceAdapter,
	OmpWorkspaceEvent,
	OmpWorkspaceSession,
	OmpWorkspaceSnapshot,
} from './types';
export type { OmpPanelEventKind, OmpPanelPort, OmpPanelRequestKind } from './OmpPanelPort';

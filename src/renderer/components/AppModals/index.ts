// Main orchestrator
export { AppModals } from './AppModals';
export type { AppModalsProps } from './AppModals';

// Re-export types that consumers import from AppModals
export type { PRDetails } from '../CreatePRModal';
export type { FlatFileItem } from '../FileSearchModal';
export type { RecoveryAction } from '../AgentErrorModal';
export type { MergeOptions } from '../MergeSessionModal';
export type { SendToAgentOptions } from '../SendToAgentModal';

// Group components (for direct test imports)
export { AppInfoModals } from './AppInfoModals';
export type { AppInfoModalsProps } from './AppInfoModals';

export { AppConfirmModals } from './AppConfirmModals';
export type { AppConfirmModalsProps } from './AppConfirmModals';

export { AppSessionModals } from './AppSessionModals';
export type { AppSessionModalsProps } from './AppSessionModals';

export { AppGroupModals } from './AppGroupModals';
export type { AppGroupModalsProps } from './AppGroupModals';

export { AppWorktreeModals } from './AppWorktreeModals';
export type { AppWorktreeModalsProps } from './AppWorktreeModals';

export { AppUtilityModals } from './AppUtilityModals';
export type { AppUtilityModalsProps } from './AppUtilityModals';

export { AppGroupChatModals } from './AppGroupChatModals';
export type { AppGroupChatModalsProps } from './AppGroupChatModals';

export { AppAgentModals } from './AppAgentModals';
export type { AppAgentModalsProps } from './AppAgentModals';
export type { GroupChatErrorInfo } from './AppAgentModals';

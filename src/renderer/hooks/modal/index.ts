export { useModalHandlers, type ModalHandlersReturn } from './useModalHandlers';

// Prompt Composer modal handlers
export {
	getPromptComposerInitialValue,
	usePromptComposerHandlers,
} from './usePromptComposerHandlers';
export type {
	PromptComposerInitialValueDeps,
	UsePromptComposerHandlersDeps,
	UsePromptComposerHandlersReturn,
} from './usePromptComposerHandlers';

// Quick Actions modal handlers (Cmd+K)
export { useQuickActionsHandlers } from './useQuickActionsHandlers';
export type {
	UseQuickActionsHandlersDeps,
	UseQuickActionsHandlersReturn,
} from './useQuickActionsHandlers';

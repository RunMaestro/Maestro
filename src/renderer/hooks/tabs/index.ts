export {
	useTabHandlers,
	type TabHandlersReturn,
	type CloseCurrentTabResult,
	useTerminalTabHandlers,
	type TerminalTabHandlersReturn,
} from './useTabHandlers';

// Tab export handlers (copy context, export HTML, publish gist)
export { useTabExportHandlers } from './useTabExportHandlers';
export type { UseTabExportHandlersDeps, UseTabExportHandlersReturn } from './useTabExportHandlers';

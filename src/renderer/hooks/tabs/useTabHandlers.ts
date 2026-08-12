import { useAITabHandlers } from './internal/useAITabHandlers';
import { useBrowserTabHandlers } from './internal/useBrowserTabHandlers';
import { useFilePreviewTabHandlers } from './internal/useFilePreviewTabHandlers';
import { useScrollLogHandlers } from './internal/useScrollLogHandlers';
import { useUnifiedTabHandlers } from './internal/useUnifiedTabHandlers';
import type { TabHandlersReturn } from './internal/types';

export type {
	CloseCurrentTabResult,
	FileTabOpenParams,
	TabHandlersReturn,
	TabDerivedState,
	TerminalTabHandlersReturn,
} from './internal/types';
export { useTerminalTabHandlers } from './internal/useTerminalTabHandlers';
export { getTabDerivedState, useTabDerivedState } from './internal/useTabDerivedState';

/**
 * Tab action callbacks only. Paint/derived tab strip state lives in MainPanel via
 * {@link getTabDerivedState} so MaestroConsoleInner is not on the chrome equality path.
 */
export function useTabHandlers(): TabHandlersReturn {
	const aiHandlers = useAITabHandlers();
	const filePreviewHandlers = useFilePreviewTabHandlers();
	const browserHandlers = useBrowserTabHandlers();
	const unifiedHandlers = useUnifiedTabHandlers({
		handleCloseFileTab: filePreviewHandlers.handleCloseFileTab,
	});
	const scrollLogHandlers = useScrollLogHandlers();

	return {
		...aiHandlers,
		...filePreviewHandlers,
		...browserHandlers,
		...unifiedHandlers,
		...scrollLogHandlers,
	};
}

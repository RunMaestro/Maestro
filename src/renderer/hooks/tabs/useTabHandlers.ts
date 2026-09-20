import type { RefObject } from 'react';
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
 *
 * @param inputRef - The AI composer textarea, so creating a tab can land the
 *   caret in it the way `Cmd+T` already does. Same shape as the ref
 *   `useModalHandlers` takes. Optional: a caller with no composer on screen
 *   simply creates the tab.
 */
export function useTabHandlers(
	inputRef?: RefObject<HTMLTextAreaElement | null>
): TabHandlersReturn {
	const aiHandlers = useAITabHandlers(inputRef);
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

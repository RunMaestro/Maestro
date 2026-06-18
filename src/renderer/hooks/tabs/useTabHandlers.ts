import { useAITabHandlers } from './internal/useAITabHandlers';
import { useBrowserTabHandlers } from './internal/useBrowserTabHandlers';
import { useFilePreviewTabHandlers } from './internal/useFilePreviewTabHandlers';
import { useScrollLogHandlers } from './internal/useScrollLogHandlers';
import { useTabDerivedState } from './internal/useTabDerivedState';
import { useUnifiedTabHandlers } from './internal/useUnifiedTabHandlers';
import type { TabHandlersReturn } from './internal/types';

export type {
	CloseCurrentTabResult,
	FileTabOpenParams,
	TabHandlersReturn,
	TerminalTabHandlersReturn,
} from './internal/types';
export { useTerminalTabHandlers } from './internal/useTerminalTabHandlers';

export function useTabHandlers(): TabHandlersReturn {
	const derivedState = useTabDerivedState();
	const aiHandlers = useAITabHandlers();
	const filePreviewHandlers = useFilePreviewTabHandlers();
	const browserHandlers = useBrowserTabHandlers();
	const unifiedHandlers = useUnifiedTabHandlers({
		handleCloseFileTab: filePreviewHandlers.handleCloseFileTab,
	});
	const scrollLogHandlers = useScrollLogHandlers();

	return {
		...derivedState,
		...aiHandlers,
		...filePreviewHandlers,
		...browserHandlers,
		...unifiedHandlers,
		...scrollLogHandlers,
	};
}

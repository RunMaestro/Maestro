/**
 * Tell the main process this renderer can open Prompt Link tabs.
 *
 * A `maestro://run` link clicked while Maestro was closed is delivered before
 * the window exists, and a tab cannot be opened on an agent the renderer has
 * not restored. Main holds such a link until this fires (see
 * `firePromptLink` in `src/main/prompt-links/`). Once per renderer, and only
 * while the feature is on, so a disabled Prompt Links costs no IPC at all.
 */

import { useEffect, useRef } from 'react';

export function usePromptLinksRendererReady(ready: boolean): void {
	const signalled = useRef(false);
	useEffect(() => {
		if (!ready || signalled.current) return;
		signalled.current = true;
		void window.maestro.promptLinks.rendererReady();
	}, [ready]);
}

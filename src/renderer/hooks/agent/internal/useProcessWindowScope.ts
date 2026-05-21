import { useCallback, useEffect, useRef } from 'react';
import { useOptionalWindowContext } from '../../../contexts/WindowContext';
import { parseSessionId } from '../../../utils/sessionIdParser';

function getWindowScopedSessionId(sessionId: string): string {
	if (sessionId.startsWith('group-chat-')) {
		return sessionId;
	}
	if (sessionId.endsWith('-terminal')) {
		return sessionId.slice(0, -'-terminal'.length);
	}

	return parseSessionId(sessionId).baseSessionId;
}

export function useProcessWindowScope(): (sessionId: string) => boolean {
	const windowContext = useOptionalWindowContext();
	const windowIdRef = useRef<string | null | undefined>(undefined);
	const windowSessionIdsRef = useRef<string[] | null>(null);

	useEffect(() => {
		windowIdRef.current = windowContext?.windowId;
		windowSessionIdsRef.current = windowContext ? windowContext.sessionIds : null;
	}, [windowContext?.windowId, windowContext?.sessionIds]);

	return useCallback((sessionId: string) => {
		const scopedSessionIds = windowSessionIdsRef.current;
		if (!scopedSessionIds || windowIdRef.current == null) {
			return true;
		}
		if (sessionId.startsWith('group-chat-')) {
			return true;
		}

		return scopedSessionIds.includes(getWindowScopedSessionId(sessionId));
	}, []);
}

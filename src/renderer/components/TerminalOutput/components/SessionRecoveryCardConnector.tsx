import type { LogEntry, Theme } from '../../../types';
import { useSessionStore } from '../../../stores/sessionStore';
import { SessionRecoveryCard } from '../../SessionRecoveryCard';

/**
 * Connector that reads the live tab from the session store and renders the
 * SessionRecoveryCard. Keeps LogItem's prop surface narrow (just sessionId)
 * instead of passing the full Session object through every log entry.
 */
export function SessionRecoveryCardConnector(props: {
	theme: Theme;
	sessionId: string;
	recoveryAction: NonNullable<LogEntry['recoveryAction']>;
	isRecovering: boolean;
	recoveryError: string | null;
	onRecover: (opts: {
		sessionId: string;
		tabId: string;
		lastUserPrompt: string;
		groomContext: boolean;
	}) => void;
}) {
	const tab = useSessionStore((s) => {
		const session = s.sessions.find((sess) => sess.id === props.sessionId);
		return session?.aiTabs.find((t) => t.id === props.recoveryAction.tabId);
	});
	if (!tab) return null;
	return (
		<SessionRecoveryCard
			theme={props.theme}
			sessionId={props.sessionId}
			tab={tab}
			lastUserPrompt={props.recoveryAction.lastUserPrompt}
			isRecovering={props.isRecovering}
			recoveryError={props.recoveryError}
			onRecover={props.onRecover}
		/>
	);
}

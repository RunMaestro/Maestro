import type { Theme } from '../types';
import type { Session, Group } from '../types';

interface AgentInboxProps {
	theme: Theme;
	sessions: Session[];
	groups: Group[];
	onClose: () => void;
	onNavigateToSession?: (sessionId: string, tabId?: string) => void;
}

export default function AgentInbox(_props: AgentInboxProps) {
	return <div>AgentInbox placeholder</div>;
}

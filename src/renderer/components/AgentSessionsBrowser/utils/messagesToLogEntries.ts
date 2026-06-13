import type { LogEntry } from '../../../types';
import type { SessionMessage } from '../../../hooks/agent/useSessionViewer';

// Tool-call messages are filtered OUT to match live-session behavior: tool entries
// are only added when showThinking is on, and restored tabs start with thinking off.
export function messagesToLogEntries(messages: SessionMessage[], sessionId: string): LogEntry[] {
	return messages
		.filter((msg) => !(msg.toolUse && Array.isArray(msg.toolUse) && msg.toolUse.length > 0))
		.map((msg, idx) => ({
			id: msg.uuid || `${sessionId}-${idx}`,
			timestamp: new Date(msg.timestamp).getTime(),
			source: msg.type === 'user' ? ('user' as const) : ('stdout' as const),
			text: msg.content || (msg.images && msg.images.length > 0 ? '' : '[No content]'),
			...(msg.images && msg.images.length > 0 && { images: msg.images }),
		}));
}

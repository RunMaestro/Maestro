export function generateMessageId(): string {
	return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

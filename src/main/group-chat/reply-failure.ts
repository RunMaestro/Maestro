/** A failed reply ends automatic synthesis until a new user request. */
const failedRounds = new Set<string>();
export function blockReplyRetries(chatId: string): void {
	failedRounds.add(chatId);
}
export function clearReplyFailure(chatId: string): void {
	failedRounds.delete(chatId);
}
export function canSynthesizeReplies(chatId: string): boolean {
	return !failedRounds.has(chatId);
}

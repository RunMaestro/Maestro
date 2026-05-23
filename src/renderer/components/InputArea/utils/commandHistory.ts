import type { Session } from '../../../types';

export function getCurrentCommandHistory(session: Session, isTerminalMode: boolean): string[] {
	const legacyHistory: string[] =
		(session as Session & { commandHistory?: string[] }).commandHistory || [];
	const shellHistory: string[] = session.shellCommandHistory || [];
	const aiHistory: string[] = session.aiCommandHistory || [];

	if (isTerminalMode) {
		return shellHistory.length > 0 ? shellHistory : legacyHistory;
	}

	return aiHistory.length > 0 ? aiHistory : legacyHistory;
}

export function filterCommandHistory(history: string[], filter: string): string[] {
	const filterLower = filter.toLowerCase();
	return Array.from(new Set(history))
		.filter((cmd) => cmd.toLowerCase().includes(filterLower))
		.reverse()
		.slice(0, 10);
}

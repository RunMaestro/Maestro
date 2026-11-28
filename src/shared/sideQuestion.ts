/**
 * Side questions (`/btw <question>`).
 *
 * A side question asks the tab's own model something about the conversation
 * while the tab may still be working, and keeps the exchange out of that
 * conversation. The main process answers it by resuming the tab's provider
 * session as a throwaway fork (the agent's `ephemeralForkArgs`), so the model
 * sees everything the tab has said and done, and the tab never sees the
 * question. Shared by the composer's `/btw` intercept and `maestro-cli ask --btw`.
 */

/** The slash command that asks one. */
export const SIDE_QUESTION_COMMAND = '/btw';

/**
 * How long a side question may take. It runs with tools off, so a reply is one
 * model turn; a long wait means the provider is stuck, not that it is working.
 */
export const SIDE_QUESTION_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * The question part of `/btw <question>`, or null when `text` is not a side
 * question. A bare `/btw` returns '' so the caller can say a question is needed
 * instead of sending `/btw` to the agent as a message.
 */
export function parseSideQuestion(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed === SIDE_QUESTION_COMMAND) return '';
	if (!/^\/btw\s/.test(trimmed)) return null;
	return trimmed.slice(SIDE_QUESTION_COMMAND.length).trim();
}

/**
 * The prompt the forked turn receives. Without the framing a resumed session
 * that was mid-task tends to pick the task back up ("Continuing with step 3...")
 * instead of answering, since the question arrives as the next user message.
 */
export function buildSideQuestionPrompt(question: string): string {
	return [
		'<side-question>',
		'The user is asking a quick side question while you work. Answer it from the conversation so far.',
		'Be brief. Do not use tools and do not continue the main task. This exchange is not kept in the conversation.',
		'</side-question>',
		'',
		question,
	].join('\n');
}

/** The agent a side question is put to, as `resolveSideQuestionTarget` reads it. */
export interface SideQuestionAgent {
	name: string;
	toolType: string;
	activeTabId?: string;
	/** The agent's AI tab ids. */
	tabIds: readonly string[];
}

/** Which tab a side question forks, or why it cannot be asked. */
export type SideQuestionTarget = { ok: true; tabId: string } | { ok: false; error: string };

/**
 * The tab a side question forks: the one named, else the agent's active tab. A side question is
 * Claude Code only. The desktop's `maestro-cli ask --btw` and a headless host's answer the same
 * way, so a script reads one set of refusals from every host.
 */
export function resolveSideQuestionTarget(
	agent: SideQuestionAgent,
	requestedTabId?: string
): SideQuestionTarget {
	if (agent.toolType !== 'claude-code') {
		return {
			ok: false,
			error: `${agent.name} cannot answer side questions (Claude Code agents only)`,
		};
	}
	const tabId = requestedTabId ?? agent.activeTabId;
	if (!tabId || !agent.tabIds.includes(tabId)) {
		return {
			ok: false,
			error: requestedTabId ? `No AI tab ${requestedTabId} on ${agent.name}` : 'No AI tab to ask',
		};
	}
	return { ok: true, tabId };
}

/**
 * Why `provider` cannot answer a side question about a tab, or null when it can. Resuming the
 * tab's session needs a throwaway fork (`ephemeralForkArgs`); a tab with no session yet needs a
 * turn that saves none (`noPersistenceArgs`). Without them the question would write into the
 * real conversation, or leave a new one behind.
 */
export function sideQuestionForkRefusal(
	provider: { name: string; ephemeralForkArgs?: string[]; noPersistenceArgs?: string[] },
	hasSession: boolean
): string | null {
	if (!provider.ephemeralForkArgs?.length) {
		return `${provider.name} cannot fork a session, so it cannot answer side questions.`;
	}
	if (!hasSession && !provider.noPersistenceArgs?.length) {
		return `${provider.name} cannot run a turn without saving a session, so it cannot answer side questions.`;
	}
	return null;
}

/**
 * Talking to a document: what a document-scoped voice session does differently.
 *
 * A document scope is an agent scope that also knows what the conversation is
 * about, and the three rules below are what turn that into a conversation rather
 * than a series of unrelated spoken prompts. They live here, in `shared/`,
 * because the same rules have to hold for whoever is asking: the session service
 * applies them to every turn, the Brain is told about them in its prompt, and
 * the renderer labels the HUD from the same scope.
 *
 *   1. **It stays with its agent.** The user pointed at a file inside one
 *      workspace. A Brain that re-targets the conversation to some other agent
 *      would be sending a spoken instruction about a file that agent cannot see.
 *   2. **The opening turn hands over the document.** The agent has no idea a
 *      file was right-clicked, so the first prompt says which one and asks for
 *      it to be read. Every later turn is plain, because that tab already knows.
 *   3. **It stays in one tab.** A document conversation that followed the active
 *      tab would scatter itself across the workspace the moment the user clicked
 *      somewhere else while thinking.
 */

import { getBasename } from '../formatters';
import type { DocumentVoiceScope, VoiceScope } from './protocol';
import type { RouteDecision } from './route-decision';

/** Narrow a scope to a document binding. */
export function isDocumentScope(scope: VoiceScope | null | undefined): scope is DocumentVoiceScope {
	return !!scope && scope.kind === 'document';
}

/**
 * The agent a scope is bound to, or null for the Conductor.
 *
 * The one place that knows which scope kinds carry an agent. Every caller that
 * hand-wrote `scope.kind === 'agent' ? scope.sessionId : null` was correct until
 * a document scope existed, and then reported a bound session as unbound - which
 * downgrades the HUD to "Conductor", drops the Left Bar's talking indicator, and
 * removes the routing bias that keeps the turn on the right agent.
 */
export function voiceScopeAgentId(scope: VoiceScope | null | undefined): string | null {
	if (!scope) return null;
	return scope.kind === 'agent' || scope.kind === 'document' ? scope.sessionId : null;
}

/** The file's leaf name: what the HUD shows and what the tab is called. */
export function documentScopeName(scope: DocumentVoiceScope): string {
	return getBasename(scope.path) || scope.path;
}

/**
 * The opening prompt: the request, with the document handed over in front of it.
 *
 * Sent once per conversation. It names the path rather than pasting the file,
 * because the agent can read it (and can read whatever else it turns out to
 * need), and because a document large enough to be worth talking about is too
 * large to spend a spoken turn's latency on.
 *
 * The spoken-form instruction is here rather than in the translator prompt for
 * the same reason: the translator reshapes an answer that has already been
 * written, so an agent that replied with a wall of diff has already spent the
 * time. Asking for short prose up front is what makes the reply cheap.
 */
export function buildDocumentOpeningPrompt(scope: DocumentVoiceScope, request: string): string {
	return [
		`We are talking about the document at \`${scope.path}\`. Read it first and treat it as the core context for this whole conversation. Read other files and use tools whenever they help.`,
		'This is a spoken conversation, so answer in short plain sentences unless I ask for detail.',
		'',
		request,
	].join('\n');
}

/**
 * Bind one decision to the document conversation.
 *
 * Applied AFTER the router has produced and validated a decision, so the Brain
 * still does the reading of what was said - which is what keeps "and check the
 * tests too" from being mangled - and this only fixes where it lands.
 *
 * @param pinnedTabId The tab this conversation is already living in, or null
 *                    when it has not opened one yet OR when the tab it opened is
 *                    gone. Null means the next turn opens a fresh one and hands
 *                    the document over again, which is the only honest recovery:
 *                    a new tab has never heard of the file.
 */
export function applyDocumentScope(
	decision: RouteDecision,
	scope: DocumentVoiceScope,
	pinnedTabId: string | null
): RouteDecision {
	const target = { sessionId: scope.sessionId };

	if (!pinnedTabId) {
		return {
			...decision,
			target,
			tabAction: 'new',
			tabId: undefined,
			tabName: documentScopeName(scope),
			prompt: buildDocumentOpeningPrompt(scope, decision.prompt),
		};
	}

	// `recall` rather than `current`: `current` resolves to whatever tab the
	// agent has active, and the user can click away mid-conversation. Recall names
	// the tab, and it is also what wakes it when they snoozed it instead.
	return { ...decision, target, tabAction: 'recall', tabId: pinnedTabId };
}

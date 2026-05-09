/**
 * Lazy loader for the autorun-synopsis prompt template.
 *
 * Lives outside the listener hooks so it can be initialised once at app
 * boot (via `services/promptInit`) and read synchronously inside any
 * exit-time synopsis path. Mirrors the original lazy-cache pattern that
 * shipped with the monolithic `useAgentListeners.ts`.
 */

let cachedAutorunSynopsisPrompt: string | null = null;
let agentListenersPromptsLoaded = false;

export async function loadAgentListenersPrompts(force = false): Promise<void> {
	if (agentListenersPromptsLoaded && !force) return;

	const result = await window.maestro.prompts.get('autorun-synopsis');
	if (!result.success) {
		throw new Error(`Failed to load autorun-synopsis prompt: ${result.error}`);
	}
	// `content` is typed as optional on the IPC response. Use a string fallback
	// so `cachedAutorunSynopsisPrompt` always satisfies the `string | null`
	// type contract (and `getAutorunSynopsisPrompt`'s `string` return type).
	cachedAutorunSynopsisPrompt = result.content ?? '';
	agentListenersPromptsLoaded = true;
}

export function getAutorunSynopsisPrompt(): string {
	if (!agentListenersPromptsLoaded || cachedAutorunSynopsisPrompt === null) {
		return '';
	}
	return cachedAutorunSynopsisPrompt;
}

/** Test-only: reset cached state. */
export function _resetAutorunSynopsisPromptForTests(): void {
	cachedAutorunSynopsisPrompt = null;
	agentListenersPromptsLoaded = false;
}

/**
 * tabAutoNaming - the one place an AI tab gets named from what the user asked for.
 *
 * Three surfaces want the same behavior and used to hand-roll it: the send path
 * (`useInputProcessing`), the manual "Auto" rename in the rename modal
 * (`useSessionLifecycle`), and now the inline wizard. Each copy repeated the
 * same four steps - build a capped prompt from the user's own messages, try the
 * cheap client-side pattern match, spawn the ephemeral namer, then write the
 * result back only if the tab has not been renamed in the meantime - and the
 * copies had already drifted (only one of them re-checked the tab before
 * writing). This module owns those steps so a fourth caller cannot drift again.
 *
 * Everything here is fire-and-forget. Naming is a nicety: when it fails the tab
 * keeps whatever name it had, the spinner clears, and the next send retries.
 */

import { getClaudeTokenSourceFields } from '../../shared/claudeTokenMode';
import { useSessionStore, selectSessionById, updateAiTab } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { extractQuickTabName } from '../utils/tabHelpers';
import type { AITab, Session } from '../types';

/**
 * Ceiling on the text handed to the namer. Richer context produces names that
 * survive the extractor's filters, but the whole job is a 2-4 word title - past
 * a couple of thousand characters we are paying for tokens that change nothing.
 */
export const NAMING_PROMPT_MAX_CHARS = 2000;

/**
 * The name a wizard tab carries from the moment `/wizard` starts until we know
 * what it is actually planning. Treated as "not yet named" so auto-naming may
 * replace it, which is also how we tell it apart from a name the user typed.
 */
export const WIZARD_TAB_PLACEHOLDER_NAME = 'Wizard';

/** Prefix that marks an auto-named wizard tab, e.g. `wizard: Ingest Pipeline`. */
export const WIZARD_TAB_NAME_PREFIX = 'wizard: ';

/**
 * Build the naming prompt from the user's own messages, oldest first, capped at
 * `maxChars`. Prior messages win the budget over the current one: they are what
 * established the topic, and the current message is often a follow-up like
 * "yes, do that" which names nothing on its own.
 */
export function collectNamingPrompt(
	priorMessages: string[],
	currentMessage = '',
	maxChars = NAMING_PROMPT_MAX_CHARS
): string {
	const collected: string[] = [];
	let total = 0;
	for (const raw of priorMessages) {
		const text = raw.trim();
		if (!text) continue;
		if (total + text.length > maxChars) {
			collected.push(text.substring(0, maxChars - total));
			total = maxChars;
			break;
		}
		collected.push(text);
		total += text.length;
	}

	if (collected.length === 0) return currentMessage;
	if (total >= maxChars) return collected.join('\n\n');

	const current = currentMessage.trim().substring(0, maxChars - total);
	return current ? [...collected, current].join('\n\n') : collected.join('\n\n');
}

/**
 * Whether a wizard tab still carries its placeholder name and may therefore be
 * auto-named. A tab the user renamed by hand fails this and is left alone.
 */
export function isWizardTabAutoNameable(tab: AITab): boolean {
	return !tab.name || tab.name === WIZARD_TAB_PLACEHOLDER_NAME;
}

export interface RequestTabAutoNameOptions {
	/**
	 * Agent that owns the tab. Passed in rather than looked up so the naming
	 * spawn inherits the SAME provider, cwd, env and SSH remote the caller is
	 * sending the message with.
	 */
	session: Session;
	/** AI tab to name. */
	tabId: string;
	/** Text the name is derived from - build it with `collectNamingPrompt()`. */
	prompt: string;
	/** Prepended to whatever name comes back, pattern-matched or generated. */
	prefix?: string;
	/**
	 * Guard on the tab, checked both before the namer is spawned and again
	 * against the live tab before the name is written. The second check is what
	 * keeps a slow naming turn from stomping a name the user typed while it ran.
	 * Defaults to "only name a tab that has no name".
	 */
	canApply?: (tab: AITab) => boolean;
	/**
	 * Ignore the `automaticTabNamingEnabled` setting. For the rename modal's
	 * "Auto" button, where the user asked for this name explicitly.
	 */
	force?: boolean;
	/** Distinguishes this trigger in the TabNaming logs. */
	label?: string;
}

const hasNoName = (tab: AITab): boolean => !tab.name;

function findTab(sessionId: string, tabId: string): AITab | undefined {
	const session = selectSessionById(sessionId)(useSessionStore.getState());
	return session?.aiTabs.find((t) => t.id === tabId);
}

function setGeneratingName(sessionId: string, tabId: string, isGeneratingName: boolean): void {
	updateAiTab(sessionId, tabId, (tab) => ({ ...tab, isGeneratingName }));
}

/**
 * Name an AI tab from the user's message. Fire-and-forget: returns immediately,
 * and the name lands (or does not) later.
 *
 * Tries `extractQuickTabName()` first - a PR or ticket reference names the tab
 * for free - and only spawns the ephemeral naming agent when no pattern matches.
 */
export function requestTabAutoName(options: RequestTabAutoNameOptions): void {
	const {
		session,
		tabId,
		prompt,
		prefix = '',
		canApply = hasNoName,
		force = false,
		label = 'auto',
	} = options;

	if (!force && !useSettingsStore.getState().automaticTabNamingEnabled) return;
	if (!prompt.trim()) return;

	const sessionId = session.id;
	const tab = session.aiTabs.find((t) => t.id === tabId);
	if (!tab) return;
	// A second namer over a running one just races the first for the same tab.
	if (tab.isGeneratingName) return;
	if (!canApply(tab)) return;

	const applyName = (generatedName: string, how: string) => {
		const liveTab = findTab(sessionId, tabId);
		if (!liveTab) return;
		if (!canApply(liveTab)) {
			window.maestro.logger.log('info', 'Tab naming skipped (tab already named)', 'TabNaming', {
				tabId,
				sessionId,
				label,
				generatedName,
				existingName: liveTab.name,
			});
			if (liveTab.isGeneratingName) setGeneratingName(sessionId, tabId, false);
			return;
		}
		const name = `${prefix}${generatedName}`;
		updateAiTab(sessionId, tabId, (t) => ({ ...t, name, isGeneratingName: false }));
		window.maestro.logger.log('info', `Tab named (${how}): "${name}"`, 'TabNaming', {
			tabId,
			sessionId,
			label,
			name,
		});
	};

	const quickName = extractQuickTabName(prompt);
	if (quickName) {
		applyName(quickName, 'pattern');
		return;
	}

	setGeneratingName(sessionId, tabId, true);
	window.maestro.logger.log('info', 'Tab naming started', 'TabNaming', {
		tabId,
		sessionId,
		label,
		agentType: session.toolType,
		promptLength: prompt.length,
	});

	window.maestro.tabNaming
		.generateTabName({
			userMessage: prompt,
			agentType: session.toolType,
			cwd: session.cwd,
			sessionSshRemoteConfig: session.sessionSshRemoteConfig,
			// Forward session env so naming uses the same provider auth as the chat.
			sessionCustomEnvVars: session.customEnvVars,
			// Honor the agent's Claude token source for the naming spawn. Shared
			// extractor guarantees the SAME complete triple the chat spawn forwards -
			// no partial/drifting forward possible.
			...getClaudeTokenSourceFields(session),
		})
		.then((generatedName) => {
			if (!generatedName) {
				setGeneratingName(sessionId, tabId, false);
				window.maestro.logger.log('warn', 'Tab naming returned null', 'TabNaming', {
					tabId,
					sessionId,
					label,
				});
				return;
			}
			applyName(generatedName, 'agent');
		})
		.catch((error) => {
			setGeneratingName(sessionId, tabId, false);
			window.maestro.logger.log('error', 'Tab naming failed', 'TabNaming', {
				tabId,
				sessionId,
				label,
				error: String(error),
			});
		});
}

/**
 * Name a wizard tab from the first thing the user tells it, as `wizard: <name>`.
 *
 * The wizard opens on a placeholder name because the tab exists before anyone
 * knows what it is for. This replaces that placeholder the moment there IS a
 * subject - the `/wizard <input>` argument, or the first message typed into the
 * wizard - and keeps the prefix so the tab still reads as a wizard at a glance.
 * A tab the user renamed by hand is left alone.
 */
export function requestWizardTabAutoName(
	session: Session,
	tabId: string,
	currentMessage: string,
	priorMessages: string[] = []
): void {
	requestTabAutoName({
		session,
		tabId,
		prompt: collectNamingPrompt(priorMessages, currentMessage),
		prefix: WIZARD_TAB_NAME_PREFIX,
		canApply: isWizardTabAutoNameable,
		label: 'wizard',
	});
}

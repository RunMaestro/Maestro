/**
 * The Brain's prompts and its output validator, shared by every Brain backend.
 *
 * Three implementations (a local Qwen3, OpenAI, Anthropic) have to produce the
 * SAME `RouteDecision` for the same utterance, or switching Brain providers would
 * quietly change where a spoken instruction lands. So the prompt is written once
 * here and the parser is the only thing that turns model output into a decision.
 *
 * The parser is deliberately paranoid. A model asked for JSON will eventually
 * return a fenced block, a preamble, a `sessionId` for an agent that closed while
 * it was thinking, or a confidence of 7. None of those may become a dispatch:
 * sending someone's spoken instruction to the wrong agent is the single worst
 * thing this feature can do, and it is worse than doing nothing. Every field is
 * therefore validated against the roster that was actually passed in, and
 * anything unrecognised collapses to the conductor rather than to a guess.
 */

import { voiceScopeAgentId } from '../../../shared/acappella/document-scope';
import type { RosterAgent, RosterTab } from '../../../shared/acappella/protocol';
import type { VoiceConverseContext, VoiceRouteContext } from '../../../shared/acappella/providers';
import type { RouteDecision, RouteTabAction } from '../../../shared/acappella/route-decision';
import { ROUTE_TAB_ACTIONS } from '../../../shared/acappella/route-decision';
import { splitIntoSpokenSentences } from '../../../shared/acappella/sentences';
import { PROMPT_IDS } from '../../../shared/promptDefinitions';
import { stripMarkdown } from '../../../shared/markdown';
import { getPrompt } from '../../prompt-manager';

/** Spoken replies stay short unless the caller asks for more. */
const DEFAULT_SPOKEN_SENTENCES = 2;

/** Cap on the roster handed to a model. A hundred agents is a prompt, not context. */
const MAX_ROSTER_AGENTS = 40;
const MAX_TABS_PER_AGENT = 12;

/**
 * The routing instructions, as the user may have edited them.
 *
 * `src/prompts/acappella-router.md` is a registered core prompt, so it shows up
 * in Settings > Maestro Prompts and someone whose agents are all called "api"
 * can teach the Conductor how to tell them apart. The built-in constant below is
 * the fallback for the two cases where the prompt store cannot answer: before
 * `initializePrompts()` has run, and in a unit test that never boots one. A
 * routing turn that threw because a settings subsystem was not up yet would be a
 * worse failure than routing on the default text.
 */
export function routeSystemPrompt(): string {
	try {
		const edited = getPrompt(PROMPT_IDS.ACAPPELLA_ROUTER).trim();
		if (edited) return edited;
	} catch {
		/* prompts not initialised, or the id was removed: use the built-in text */
	}
	return ROUTE_SYSTEM_PROMPT;
}

export const ROUTE_SYSTEM_PROMPT = [
	'You route spoken instructions inside Maestro, a desktop app that runs several AI coding agents at once.',
	'Given one utterance and the list of running agents, decide which agent it is for, what to do with tabs, and what prompt to actually send.',
	'',
	'Rules:',
	'- Answer with ONE JSON object and nothing else. No prose, no code fence.',
	'- "target" is either the string "conductor" or {"sessionId": "<an id from the roster>"}. Never invent an id.',
	'- Use "conductor" when the utterance is about Maestro itself, or when no agent is clearly meant.',
	'- "tabAction" is "current" (use the active tab), "new" (open a fresh tab), or "recall" (go back to an existing tab, and then "tabId" is required and must come from that agent\'s tabs).',
	'- "prompt" is what the agent should receive: the request itself, with the routing words removed. Keep the user\'s own wording.',
	'- "confidence" is 0 to 1. Be honest: a guess is 0.4, hearing an agent name by name is 0.9.',
	'',
	'Talking versus sending (only when the conversation section below says you may reply):',
	'- "reply" is one short spoken line back to the user. Setting it means you are TALKING: no agent is contacted, and the floor stays with the user.',
	'- Reply while the user is still thinking out loud, describing a problem, or has said something that is not yet a doable task.',
	'- Do NOT reply once one concrete, doable thing has been stated. Send it instead. An agent can work out the details; your job is to notice that there is a job.',
	'- When you send after a conversation, "prompt" is the distilled request - a sentence or two in the user\'s own words, not a transcript of the discussion.',
	'- Keep a reply to one or two sentences. It is spoken aloud, not read.',
].join('\n');

/**
 * The translator instructions, as the user may have edited them.
 *
 * Same arrangement as {@link routeSystemPrompt}: `src/prompts/acappella-translator.md`
 * is the editable core prompt and the constant below is the fallback for a
 * process that has not initialised the prompt store. It is read by every Brain's
 * `converse()` and by `speech/conversational-translator.ts`, so the voice a user
 * tuned is the voice they get on all three backends rather than on whichever one
 * happened to import the file.
 */
export function converseSystemPrompt(): string {
	try {
		const edited = getPrompt(PROMPT_IDS.ACAPPELLA_TRANSLATOR).trim();
		if (edited) return edited;
	} catch {
		/* prompts not initialised, or the id was removed: use the built-in text */
	}
	return CONVERSE_SYSTEM_PROMPT;
}

export const CONVERSE_SYSTEM_PROMPT = [
	"You turn an AI coding agent's written answer into something worth hearing out loud.",
	'',
	'Rules:',
	'- Speak the outcome, not the transcript. The listener has no screen.',
	'- Never read code, diffs, file paths, URLs, or command output aloud. Say what changed instead.',
	'- Plain sentences. No markdown, no bullet points, no headings.',
	'- If the answer is a question for the user, ask it directly.',
	'- Answer with the spoken text only. No preamble, no quotes around it.',
].join('\n');

/**
 * The roster block, as every Brain and the routing-context assembler render it.
 *
 * One renderer, deliberately: the assembler measures its size cap against this
 * exact text, so a second copy that formatted a tab differently would cap the
 * wrong string and the prompt would quietly overrun.
 */
export function serializeRoster(agents: readonly RosterAgent[]): string[] {
	const lines: string[] = ['Running agents:'];
	if (agents.length === 0) lines.push('  (none)');

	for (const agent of agents.slice(0, MAX_ROSTER_AGENTS)) {
		const status = agent.status ? ` ${agent.status}` : '';
		lines.push(
			`- ${agent.name} [${agent.sessionId}] (${agent.agentType}${status}) in ${agent.cwd}`
		);
		if (agent.recentWork) lines.push(`    recently: ${agent.recentWork}`);
		for (const tab of agent.tabs.slice(0, MAX_TABS_PER_AGENT)) {
			lines.push(`    tab ${tab.id}: ${describeTab(tab)}`);
		}
	}

	return lines;
}

/** The user-side message for a routing call. */
export function buildRouteUserPrompt(input: string, context: VoiceRouteContext): string {
	const lines: string[] = serializeRoster(context.roster);

	const boundAgentId = voiceScopeAgentId(context.scope);
	if (boundAgentId) {
		lines.push('', `The user is currently bound to agent ${boundAgentId}.`);
	} else if (context.activeAgentSessionId) {
		lines.push('', `The user is looking at agent ${context.activeAgentSessionId}.`);
	}

	if (context.document) {
		// The subject of the conversation, not a routing hint: the target and the
		// tab are pinned by the session service whatever the model answers. What
		// this changes is the PROMPT - "add a diagram" is useless to an agent, and
		// "add a diagram of the dispatch flow to system-overview.md" is not.
		lines.push(
			'',
			`This is a conversation about the document ${context.document.name} at ${context.document.path}.`,
			'Every utterance is about that document unless the user plainly says otherwise. Write "prompt" so it stands on its own, naming what in the document they mean.'
		);
	}

	const recent = context.recentUtterances ?? [];
	if (recent.length > 0) {
		lines.push('', 'Earlier in this conversation:');
		for (const utterance of recent.slice(-5)) lines.push(`- ${utterance}`);
	}

	const conversation = context.conversation ?? [];
	if (conversation.length > 0) {
		lines.push('', 'The conversation so far:');
		for (const turn of conversation) {
			lines.push(`${turn.role === 'user' ? 'User' : 'You'}: ${turn.text}`);
		}
	}

	if (context.conversational) {
		lines.push(
			'',
			'You may answer with "reply" instead of dispatching. Use it while the user is still working out what they want.',
			'Send the request the moment one concrete, doable thing has been stated - do not keep asking for detail an agent could work out for itself.'
		);
	}

	if (context.clarification) {
		// The answer alone is a fragment ("the API one"). Routed on its own it
		// becomes a prompt, and the request it was answering is lost.
		lines.push(
			'',
			`The user asked: ${context.clarification.utterance}`,
			`You asked back: ${context.clarification.question}`,
			'Their answer follows. Route the ORIGINAL request, using the answer only to pick the target.'
		);
	}

	if (context.retryNotes && context.retryNotes.length > 0) {
		lines.push('', 'Your previous answer was rejected:');
		for (const note of context.retryNotes) lines.push(`- ${note}`);
		lines.push('Answer again, fixing exactly those problems.');
	}

	lines.push('', `Utterance: ${input}`);
	return lines.join('\n');
}

/**
 * One tab, as a line in the roster.
 *
 * The topic is what makes recall possible at all: a tab called "Tab 3" tells a
 * model nothing, and "auth middleware rewrite" is the phrase the user will say
 * six hours later. The state is what stops a recall from being a lie - a snoozed
 * or closed tab is a legitimate target, but only if whoever picks it knows it has
 * to be woken first.
 */
function describeTab(tab: RosterTab): string {
	const label = tab.name ?? 'untitled';
	const parts = [label];
	if (tab.topic && tab.topic !== label) parts.push(`- ${tab.topic}`);
	if (tab.state && tab.state !== 'open') parts.push(`(${tab.state})`);
	return parts.join(' ');
}

/** How many earlier spoken lines a rewrite is shown. Enough to avoid repeating itself. */
const MAX_SPOKEN_MEMORY_LINES = 4;

export function buildConverseUserPrompt(agentText: string, context: VoiceConverseContext): string {
	const limit = context.maxSentences ?? DEFAULT_SPOKEN_SENTENCES;
	const lines: string[] = [];

	const spoken = context.recentSpoken ?? [];
	if (spoken.length > 0) {
		// What the listener HEARD, so the rewrite can refer back instead of
		// re-explaining, and so a second chunk of one long answer does not repeat
		// the headline the first chunk already delivered.
		lines.push('You already said, out loud:');
		for (const line of spoken.slice(-MAX_SPOKEN_MEMORY_LINES)) lines.push(`- ${line}`);
		lines.push('');
	}

	lines.push(`Say this in at most ${limit} sentence${limit === 1 ? '' : 's'}:`, '', agentText);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Turn raw model output into a decision that is safe to dispatch.
 *
 * `fallbackPrompt` is what the agent receives when the model gave no usable
 * prompt: the user's own words. An utterance that reaches an agent verbatim is a
 * worse prompt than a cleaned one and an infinitely better outcome than a turn
 * that silently did nothing.
 */
export function parseRouteDecision(
	raw: string,
	context: VoiceRouteContext,
	fallbackPrompt: string
): RouteDecision {
	const parsed = extractJsonObject(raw);
	const agent = resolveAgent(parsed?.target, context.roster);

	let tabAction = asTabAction(parsed?.tabAction);
	let tabId = typeof parsed?.tabId === 'string' ? parsed.tabId : undefined;

	if (tabAction === 'recall') {
		// A recall the executor cannot perform is worse than no recall: it fails the
		// turn instead of using the tab the user is already looking at.
		const known = agent?.tabs.some((tab) => tab.id === tabId);
		if (!known) {
			tabAction = 'current';
			tabId = undefined;
		}
	} else {
		tabId = undefined;
	}

	const prompt = asNonEmptyString(parsed?.prompt) ?? fallbackPrompt.trim();
	const tabName = tabAction === 'new' ? asNonEmptyString(parsed?.tabName) : undefined;

	return {
		target: agent ? { sessionId: agent.sessionId } : 'conductor',
		tabAction,
		tabId,
		tabName,
		prompt,
		confidence: clampConfidence(parsed?.confidence),
		// A model that asked a question instead of guessing did the right thing, so
		// the question survives parsing. Everything else on the decision is still
		// filled in: if the user answers, the answer routes; if the turn is
		// abandoned, nothing was dispatched.
		clarify: asSpokenLine(parsed?.clarify),
		reply: asSpokenLine(parsed?.reply),
	};
}

/**
 * Pull the first JSON object out of a model response.
 *
 * Brace matching rather than a regex: a `prompt` field can legally contain
 * braces, and the non-greedy regex that "worked" would truncate the object at the
 * first one.
 */
export function extractJsonObject(raw: string): Record<string, unknown> | null {
	const text = raw.trim();
	const start = text.indexOf('{');
	if (start === -1) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i++) {
		const char = text[i];

		if (inString) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') inString = true;
		else if (char === '{') depth++;
		else if (char === '}' && --depth === 0) {
			try {
				const parsed: unknown = JSON.parse(text.slice(start, i + 1));
				return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>)
					: null;
			} catch {
				return null;
			}
		}
	}

	return null;
}

/** The roster agent a target names, or null for the conductor and for junk. */
function resolveAgent(target: unknown, roster: RosterAgent[]): RosterAgent | null {
	const sessionId =
		typeof target === 'string'
			? null
			: ((target as { sessionId?: unknown })?.sessionId as string | undefined);
	if (typeof sessionId !== 'string' || !sessionId) return null;
	// The id must be one that is RUNNING. A hallucinated id would otherwise reach
	// the session service, which would correctly refuse the turn - but this is the
	// layer that knows the honest recovery is "the conductor takes it".
	return roster.find((agent) => agent.sessionId === sessionId) ?? null;
}

function asTabAction(value: unknown): RouteTabAction {
	return typeof value === 'string' && (ROUTE_TAB_ACTIONS as readonly string[]).includes(value)
		? (value as RouteTabAction)
		: 'current';
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** A clarification is spoken, so it is one line: newlines would be read aloud. */
function asSpokenLine(value: unknown): string | undefined {
	const text = asNonEmptyString(value);
	return text ? text.replace(/\s+/g, ' ') : undefined;
}

function clampConfidence(value: unknown): number {
	const num = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(num)) return 0.5;
	return Math.min(1, Math.max(0, Math.round(num * 100) / 100));
}

// ---------------------------------------------------------------------------
// Spoken form
// ---------------------------------------------------------------------------

/**
 * Trim a model's spoken rewrite to the sentence budget.
 *
 * Applied to every Brain's `converse()` output, including a hosted one that was
 * asked for two sentences and returned five. The session service already
 * announced `sentenceCount` from the same splitter, so a reply that overruns
 * would leave a client's "3 of 2" progress permanently wrong.
 */
export function limitSpokenReply(text: string, maxSentences?: number): string {
	const plain = stripMarkdown(text).replace(/\s+/g, ' ').trim();
	if (!plain) return '';
	const limit = Math.max(1, maxSentences ?? DEFAULT_SPOKEN_SENTENCES);
	return splitIntoSpokenSentences(plain).slice(0, limit).join(' ');
}

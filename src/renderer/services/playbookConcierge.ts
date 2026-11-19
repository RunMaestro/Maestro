/**
 * playbookConcierge.ts
 *
 * The guided interview that fills a playbook's open parameters before a run.
 * It is the inline wizard's turn loop with a different contract: the same
 * read-only agent turns (`sendWizardMessage`, which builds the read-only args
 * per provider and handles SSH, Grok, and stream parsing), the same
 * `parseStructuredOutput`, and a `WizardResponse` extended with a
 * `parameters` array. The rules for when it may run and what it may propose
 * are pure and live in `src/shared/playbookConcierge.ts`.
 *
 * The prompt is `playbook-concierge` (`src/prompts/playbook-concierge.md`),
 * editable in Settings > Maestro Prompts.
 */

import {
	readConciergeParameters,
	type ConciergeParameterProposal,
} from '../../shared/playbookConcierge';
import type { PlaybookFacts } from '../../shared/playbookFacts';
import type {
	PlaybookParamProposals,
	PlaybookParamSpec,
	PlaybookParamValues,
} from '../../shared/playbookParams';
import { parseStructuredOutput } from '../components/Wizard/services/wizardPrompts';
import type { InlineWizardMessage } from '../hooks/batch/inlineWizard/types';
import {
	createWizardConversationSession,
	endInlineWizardConversation,
	READY_CONFIDENCE_THRESHOLD,
	sendWizardMessage,
	type ConversationCallbacks,
	type InlineWizardConversationSession,
	type InlineWizardSendResult,
	type WizardConversationAgentConfig,
	type WizardResponse,
} from './inlineWizardConversation';

/** A concierge turn's reply: the wizard's fields plus the proposed values. */
export interface PlaybookConciergeResponse extends WizardResponse {
	parameters: ConciergeParameterProposal[];
}

/** What the prompt is built from. */
export interface PlaybookConciergeContext {
	title: string;
	/** The playbook README, when the caller has it (the Exchange does; a saved record does not). */
	readme?: string | null;
	specs: PlaybookParamSpec[];
	facts: PlaybookFacts | null;
	/** The user's stored answers. */
	stored: PlaybookParamValues;
	/** Proposals from the facts pass, shown to the agent as already known. */
	factProposals: PlaybookParamProposals;
	/** Names the agent may propose into. */
	open: string[];
	questionCap: number;
}

/** A running interview: the wizard session plus what its replies are checked against. */
export interface PlaybookConciergeConversation {
	session: InlineWizardConversationSession;
	specs: PlaybookParamSpec[];
	open: ReadonlySet<string>;
	questionCap: number;
}

/** The hidden first message: the agent opens the interview, the user has said nothing yet. */
export const CONCIERGE_KICKOFF_MESSAGE =
	'Start the interview: propose what you can find, then ask your first question.';

const CONCIERGE_STRUCTURED_OUTPUT_SUFFIX = `

IMPORTANT: This is a short read-only interview. Do not implement anything. Propose values only for the open parameters. End every turn with ONLY valid JSON in this exact format:
{"confidence": <0-100>, "ready": <true/false>, "message": "<your response>", "parameters": [{"name": "<NAME>", "value": "<text>", "source": "detected" | "asked" | "default", "evidence": "<where it came from>", "confidence": <0-100>}]}`;

let cachedPrompt: string | null = null;

/** Load (and cache) the `playbook-concierge` prompt, customizations applied. */
export async function loadPlaybookConciergePrompt(force = false): Promise<string> {
	if (cachedPrompt !== null && !force) return cachedPrompt;
	const result = await window.maestro.prompts.get('playbook-concierge');
	if (!result.success || typeof result.content !== 'string') {
		throw new Error(`Failed to load playbook-concierge prompt: ${result.error ?? 'empty'}`);
	}
	cachedPrompt = result.content;
	return cachedPrompt;
}

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/**
 * Fill the prompt template. One pass over `{{NAME}}` tokens, so a README or a
 * value that itself contains `{{...}}` is inserted literally and never
 * substituted again. Unknown tokens are left as they are.
 */
export function buildPlaybookConciergePrompt(
	template: string,
	context: PlaybookConciergeContext
): string {
	const known: Record<string, { value: string; source: string; evidence?: string }> = {};
	for (const spec of context.specs) {
		const answer = context.stored[spec.name]?.trim();
		if (answer) known[spec.name] = { value: answer, source: 'user' };
		else if (spec.default?.trim()) known[spec.name] = { value: spec.default, source: 'default' };
		else if (context.factProposals[spec.name]) {
			const proposal = context.factProposals[spec.name];
			known[spec.name] = {
				value: proposal.value,
				source: 'detected',
				evidence: proposal.evidence,
			};
		}
	}
	const replacements: Record<string, string> = {
		PLAYBOOK_TITLE: context.title,
		PLAYBOOK_README: context.readme?.trim() || '(This playbook has no README.)',
		PARAMETER_SPECS_JSON: json(
			context.specs.map(({ source: _source, ...spec }) => ({
				...spec,
				open: context.open.includes(spec.name),
			}))
		),
		KNOWN_VALUES_JSON: json(known),
		FACTS_JSON: json(context.facts ?? { unavailable: true }),
		OPEN_PARAMETERS: context.open.length > 0 ? context.open.join(', ') : '(none)',
		QUESTION_CAP: String(context.questionCap),
		READY_CONFIDENCE_THRESHOLD: String(READY_CONFIDENCE_THRESHOLD),
	};
	return template.replace(/\{\{([A-Z_]+)\}\}/g, (token, name: string) =>
		Object.prototype.hasOwnProperty.call(replacements, name) ? replacements[name] : token
	);
}

/**
 * Parse one concierge reply. The wizard fields go through the shared
 * `parseStructuredOutput` (same fallbacks, same ready threshold); the
 * `parameters` array is read from the same JSON object and filtered by
 * `readConciergeParameters`. With `requireStructured` (Grok), a reply that is
 * not valid JSON is a failure rather than a plain-text message.
 */
export function parsePlaybookConciergeResponse(
	text: string,
	requireStructured: boolean,
	specs: PlaybookParamSpec[],
	open: ReadonlySet<string>
): PlaybookConciergeResponse | null {
	const result = parseStructuredOutput(text);
	const structured = result.structured;
	if (!structured) return null;
	if (
		requireStructured &&
		(!result.parseSuccess || !structured.message.trim() || !Number.isFinite(structured.confidence))
	) {
		return null;
	}
	return {
		confidence: structured.confidence,
		ready: structured.ready,
		message: structured.message,
		parameters: result.parseSuccess
			? readConciergeParameters(result.raw?.parameters, specs, open)
			: [],
	};
}

/** Open an interview on an agent. Nothing spawns until the first message. */
export function startPlaybookConcierge(
	agent: WizardConversationAgentConfig,
	template: string,
	context: PlaybookConciergeContext
): PlaybookConciergeConversation {
	const systemPrompt = buildPlaybookConciergePrompt(template, context);
	return {
		session: createWizardConversationSession(agent, systemPrompt, 'playbook-concierge'),
		specs: context.specs,
		open: new Set(context.open),
		questionCap: context.questionCap,
	};
}

/** One read-only interview turn. */
export function sendPlaybookConciergeMessage(
	conversation: PlaybookConciergeConversation,
	message: string,
	history: InlineWizardMessage[],
	callbacks?: ConversationCallbacks
): Promise<InlineWizardSendResult<PlaybookConciergeResponse>> {
	return sendWizardMessage<PlaybookConciergeResponse>(
		conversation.session,
		message,
		history,
		callbacks,
		{
			structuredOutputSuffix: CONCIERGE_STRUCTURED_OUTPUT_SUFFIX,
			parseResponse: (text, requireStructured) =>
				parsePlaybookConciergeResponse(
					text,
					requireStructured,
					conversation.specs,
					conversation.open
				),
		}
	);
}

/** Stop an interview and kill its turn if one is running. */
export function endPlaybookConcierge(conversation: PlaybookConciergeConversation): Promise<void> {
	return endInlineWizardConversation(conversation.session);
}

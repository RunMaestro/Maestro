/**
 * Spoken notices: shared, process-agnostic pieces.
 *
 * When an agent finishes a turn, Maestro can say one line about it aloud
 * ("Backend finished: tests pass, two files changed"). The line is written by
 * the `spoken-notices` Local Models task and spoken with a local voice. It is
 * opt-in: the `spokenNotices` setting is `off` until the user changes it.
 *
 * Everything here is pure: the setting's vocabulary, the gate that decides
 * whether a finished turn is spoken about, the line that needs no model, the
 * input a model is shown, the cleanup of what it wrote, and the result shape
 * that travels over IPC and the CLI bridge. The queue, the model call, and the
 * audio are main-process only (`src/main/local-models/spoken-notices.ts`).
 */

/**
 * When a finished turn is spoken about.
 *
 * - `off`: never. The default.
 * - `unfocused`: only while no Maestro window has focus, which is when the
 *   person is somewhere a toast cannot reach them.
 * - `always`: every finished turn, whether or not Maestro is in front.
 */
export const SPOKEN_NOTICE_MODES = ['off', 'unfocused', 'always'] as const;

export type SpokenNoticeMode = (typeof SPOKEN_NOTICE_MODES)[number];

export const DEFAULT_SPOKEN_NOTICE_MODE: SpokenNoticeMode = 'off';

/** The settings key the mode is stored under. */
export const SPOKEN_NOTICES_SETTING_KEY = 'spokenNotices';

export const SPOKEN_NOTICE_MODE_LABELS: Readonly<Record<SpokenNoticeMode, string>> = Object.freeze({
	off: 'Off',
	unfocused: 'When Maestro is not focused',
	always: 'Always',
});

export function isSpokenNoticeMode(value: unknown): value is SpokenNoticeMode {
	return typeof value === 'string' && (SPOKEN_NOTICE_MODES as readonly string[]).includes(value);
}

/**
 * Read a stored mode. Speaking aloud is consent, so anything that is not one of
 * the three words (a value from another build, a hand-edited file) reads as
 * `off` rather than as the nearest match.
 */
export function asSpokenNoticeMode(value: unknown): SpokenNoticeMode {
	return isSpokenNoticeMode(value) ? value : DEFAULT_SPOKEN_NOTICE_MODE;
}

/** Whether a finished turn is spoken about, given the mode and where focus is. */
export function shouldSpeakNotice(mode: SpokenNoticeMode, appFocused: boolean): boolean {
	if (mode === 'always') return true;
	if (mode === 'unfocused') return !appFocused;
	return false;
}

/** The longest line a notice speaks. About fifteen seconds of speech. */
export const SPOKEN_NOTICE_MAX_CHARS = 220;

/** The longest text `maestro-cli notify speak` and the Test button accept. */
export const SPOKEN_NOTICE_MAX_REQUEST_CHARS = 600;

/** How much of the user's request a model is shown. */
const NOTICE_PROMPT_MAX_CHARS = 400;

/**
 * How much of the agent's reply a model is shown. The END of the reply is kept:
 * an agent says what it did last, after the work.
 */
const NOTICE_RESPONSE_MAX_CHARS = 2400;

/** What the renderer knows about a turn that just finished. */
export interface AgentFinishedNotice {
	/** The agent's name in the Left Bar. */
	agentName: string;
	/** What the user asked for. */
	prompt?: string;
	/** What the agent answered. */
	response?: string;
}

/** The reply shape the `spoken-notice-local` prompt asks for. */
export const SPOKEN_NOTICE_REPLY_SCHEMA: Record<string, unknown> = {
	type: 'object',
	properties: {
		summary: { type: 'string', maxLength: SPOKEN_NOTICE_MAX_CHARS },
	},
	required: ['summary'],
	additionalProperties: false,
};

/** Why a notice was not spoken. */
export type SpokenNoticeSkipCode =
	/** The `spokenNotices` setting is off. */
	| 'setting-off'
	/** The mode is `unfocused` and a Maestro window has focus. */
	| 'app-focused'
	/** A voice session is live. It speaks for itself. */
	| 'voice-session-active'
	/** Nothing in this process can speak (the standalone runner, a browser client). */
	| 'no-speaker'
	/** There was nothing to say once the text was cleaned. */
	| 'empty'
	/** It waited so long behind other notices that it was no longer news. */
	| 'stale'
	/** Newer notices pushed it out of the queue. */
	| 'superseded'
	/** It was cut off or dropped because a voice session started. */
	| 'cancelled'
	/** The voice could not speak. The message names why. */
	| 'speech-failed';

/** Where the spoken line came from. */
export type SpokenNoticeLineSource =
	/** The assigned model wrote it. */
	| 'model'
	/** `<agent name> finished`, which needs no model. */
	| 'fallback'
	/** The caller supplied the text (`maestro-cli notify speak`, the Test button). */
	| 'given';

/** Every outcome is an answer, never a rejection. */
export type SpokenNoticeResult =
	| {
			spoken: true;
			/** The words that were spoken. */
			text: string;
			lineSource: SpokenNoticeLineSource;
	  }
	| {
			spoken: false;
			code: SpokenNoticeSkipCode;
			/** Written for a person. */
			message: string;
	  };

/**
 * The line that needs no model: who finished, and nothing else. Spoken when
 * the `spoken-notices` task is off, when its model cannot run, and when the
 * model wrote nothing usable.
 */
export function fallbackNoticeLine(agentName: string | undefined): string {
	const name = flattenForSpeech(agentName ?? '');
	return name ? `${name} finished` : 'An agent finished';
}

/** Keep the END of a long text, marking that the start was cut. */
function keepTail(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `[...] ${text.slice(text.length - maxChars)}`;
}

/** Keep the START of a long text, marking that the end was cut. */
function keepHead(text: string, maxChars: number): string {
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)} [...]`;
}

/**
 * Cut a finished-turn report down to what a model is shown, before it crosses
 * a process boundary. An agent's reply can be megabytes, and none of it past
 * these caps is ever read.
 */
export function boundAgentFinishedNotice(notice: AgentFinishedNotice): AgentFinishedNotice {
	const bounded: AgentFinishedNotice = { agentName: notice.agentName };
	const prompt = notice.prompt?.trim();
	if (prompt) bounded.prompt = keepHead(prompt, NOTICE_PROMPT_MAX_CHARS);
	const response = notice.response?.trim();
	if (response) bounded.response = keepTail(response, NOTICE_RESPONSE_MAX_CHARS);
	return bounded;
}

/**
 * The user turn handed to the model (the instructions are the
 * `spoken-notice-local` prompt, sent as the system turn). Capped so it fits a
 * small local context whatever the agent wrote.
 */
export function formatSpokenNoticeInput(notice: AgentFinishedNotice): string {
	const { agentName, prompt, response } = boundAgentFinishedNotice(notice);
	const parts = [`Agent: ${flattenForSpeech(agentName) || 'unnamed'}`];
	if (prompt) parts.push(`The request:\n${prompt}`);
	parts.push(response ? `The agent's reply:\n${response}` : "The agent's reply: (none)");
	return parts.join('\n\n');
}

/**
 * Turn text into something a voice can read: one line, with the markup a voice
 * would otherwise pronounce or stumble on removed.
 */
function flattenForSpeech(text: string): string {
	return (
		text
			// Fenced code is never worth reading aloud.
			.replace(/```[\s\S]*?```/g, ' ')
			// A markdown link speaks as its label.
			.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
			.replace(/https?:\/\/\S+/g, ' ')
			.replace(/[`*_#>|~]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

/** Cut at the last word that fits, so a voice never ends mid-word. */
function capAtWord(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const cut = text.slice(0, maxChars);
	// The cut already fell between two words when the next character is a space.
	const lastSpace = text[maxChars] === ' ' ? -1 : cut.lastIndexOf(' ');
	return (lastSpace > maxChars / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/, '');
}

/**
 * Clean text a caller wants spoken: flattened to one speakable line and capped.
 * `null` when nothing is left to say.
 */
export function cleanSpokenText(
	text: unknown,
	maxChars: number = SPOKEN_NOTICE_MAX_CHARS
): string | null {
	if (typeof text !== 'string') return null;
	const flat = capAtWord(flattenForSpeech(text), maxChars);
	return flat === '' ? null : flat;
}

/**
 * The full line for a model's summary: `<agent name> finished: <summary>`.
 * `null` when the model wrote nothing usable, so the caller speaks the
 * fallback line instead. The agent's name is put in front by this function,
 * never by the model, so a small model cannot rename or drop the agent.
 */
export function composeNoticeLine(agentName: string | undefined, summary: unknown): string | null {
	const lead = fallbackNoticeLine(agentName);
	const room = SPOKEN_NOTICE_MAX_CHARS - lead.length - 2;
	if (room < 20) return null;
	const cleaned = cleanSpokenText(
		typeof summary === 'string' ? summary.replace(/^["'\s]+|["'\s]+$/g, '') : summary,
		room
	);
	if (!cleaned) return null;
	return `${lead}: ${cleaned.replace(/[.\s]+$/, '')}`;
}

/** Read the `summary` field of a model reply that followed the schema. */
export function parseSpokenNoticeReply(json: unknown): string | null {
	if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
	const summary = (json as { summary?: unknown }).summary;
	return typeof summary === 'string' && summary.trim() !== '' ? summary : null;
}

function optionalText(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
	return value;
}

/**
 * Validate a finished-turn report that crossed a process boundary. A bad
 * report throws with a message a person can act on.
 */
export function parseAgentFinishedNotice(value: unknown): AgentFinishedNotice {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('A finished-turn notice needs an agent name.');
	}
	const record = value as Record<string, unknown>;
	if (typeof record.agentName !== 'string' || record.agentName.trim() === '') {
		throw new Error('A finished-turn notice needs an agent name.');
	}
	const notice: AgentFinishedNotice = { agentName: record.agentName };
	const prompt = optionalText(record, 'prompt');
	if (prompt) notice.prompt = prompt;
	const response = optionalText(record, 'response');
	if (response) notice.response = response;
	return notice;
}

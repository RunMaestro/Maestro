/**
 * Prompt Links - `maestro://run/<token>` URLs that open a new AI tab in one
 * agent and send one prompt there.
 *
 * A link that runs a prompt is a code-execution path: anyone who gets a user to
 * click a `maestro://` URL (an email, a web page, a calendar invite from a
 * stranger) reaches an agent that runs with the user's credentials. So the URL
 * carries ONLY an opaque, random token. The agent, the prompt, the use budget
 * and the expiry live in Maestro, keyed by a hash of that token:
 *
 *   - A forged link names no token Maestro knows, so it does nothing.
 *   - A leaked link can only run the prompt its owner wrote, never a new one.
 *   - Links are one-shot by default; `maxUses` widens that on purpose.
 *   - Any link can be revoked on its own, and expires if the owner asked.
 *
 * The feature is an Encore Feature, off by default. These are the pure rules
 * every process shares; the store lives in `src/main/prompt-links/`.
 */

import { parseScheduleDuration } from './cue/scheduled-tasks';

/** Random bytes in a token: 256 bits, so guessing one is not a plan. */
export const PROMPT_LINK_TOKEN_BYTES = 32;

/**
 * Longest prompt a link may carry. The prompt never travels in the URL, so
 * this is a sanity bound on the store, not a URL-length limit.
 */
export const PROMPT_LINK_MAX_PROMPT_CHARS = 100_000;

/** Longest label. */
export const PROMPT_LINK_MAX_LABEL_CHARS = 120;

/** Highest finite use budget. Above this, ask for unlimited explicitly. */
export const PROMPT_LINK_MAX_USES = 10_000;

/**
 * Where the new tab opens when the link fires. `background` leaves the user's
 * view alone and raises a toast; `foreground` brings Maestro forward on the
 * new tab.
 */
export type PromptLinkOpenMode = 'background' | 'foreground';

export const PROMPT_LINK_OPEN_MODES: readonly PromptLinkOpenMode[] = ['background', 'foreground'];

/** A stored link as every surface sees it. The token hash never leaves main. */
export interface PromptLinkPublic {
	id: string;
	/** Agent (Maestro session) the prompt runs in. */
	agentId: string;
	prompt: string;
	label?: string;
	createdAt: number;
	/** Epoch ms after which the link refuses to run. Absent = never expires. */
	expiresAt?: number;
	/** How many times the link may run. `null` = unlimited. */
	maxUses: number | null;
	useCount: number;
	lastUsedAt?: number;
	revokedAt?: number;
	open: PromptLinkOpenMode;
}

/** What a create call returns. `url` is shown once: only its hash is kept. */
export interface PromptLinkCreated {
	link: PromptLinkPublic;
	url: string;
}

export interface PromptLinkCreateInput {
	agentId: string;
	prompt: string;
	label?: string;
	/** Defaults to 1 (one-shot). `null` = unlimited. */
	maxUses?: number | null;
	/** Epoch ms. Absent = never expires. */
	expiresAt?: number;
	/** Defaults to `background`. */
	open?: PromptLinkOpenMode;
}

export type PromptLinkStatus = 'active' | 'spent' | 'expired' | 'revoked';

/** Why a fired link did not run. */
export type PromptLinkRefusal =
	| 'disabled'
	| 'not-found'
	| 'revoked'
	| 'expired'
	| 'spent'
	| 'in-flight'
	| 'agent-missing'
	| 'not-ready';

/** The link's state at `now`. Revoked wins over everything, then expiry, then use. */
export function promptLinkStatus(
	link: PromptLinkPublic,
	now: number = Date.now()
): PromptLinkStatus {
	if (link.revokedAt !== undefined) return 'revoked';
	if (link.expiresAt !== undefined && now >= link.expiresAt) return 'expired';
	if (link.maxUses !== null && link.useCount >= link.maxUses) return 'spent';
	return 'active';
}

/** Uses left, or `null` when the link is unlimited. Never negative. */
export function promptLinkUsesLeft(link: PromptLinkPublic): number | null {
	if (link.maxUses === null) return null;
	return Math.max(0, link.maxUses - link.useCount);
}

/** "One-shot, unused", "2 of 5 used", "3 used, unlimited". */
export function describePromptLinkUses(link: PromptLinkPublic): string {
	if (link.maxUses === null) {
		return link.useCount === 0 ? 'Unlimited, unused' : `${link.useCount} used, unlimited`;
	}
	if (link.maxUses === 1) return link.useCount === 0 ? 'One-shot, unused' : 'One-shot, used';
	return `${link.useCount} of ${link.maxUses} used`;
}

/** The sentence a refusal shows. Written for a toast and for CLI output alike. */
export function describePromptLinkRefusal(reason: PromptLinkRefusal): string {
	switch (reason) {
		case 'disabled':
			return 'Prompt Links is turned off. Turn it on in Settings > Encore Features to run prompt links.';
		case 'not-found':
			return 'This prompt link is not known to this Maestro. It may be mistyped, from another machine, or forged.';
		case 'revoked':
			return 'This prompt link was revoked.';
		case 'expired':
			return 'This prompt link has expired.';
		case 'spent':
			return 'This prompt link has already been used.';
		case 'in-flight':
			return 'This prompt link is already running. A second click was ignored.';
		case 'agent-missing':
			return 'The agent this prompt link targets no longer exists.';
		case 'not-ready':
			return 'Maestro was not ready to open a tab. The link was not used; click it again.';
	}
}

/**
 * Check a create request. Returns the problem as a sentence, or `null` when the
 * input is valid. `now` bounds the expiry so a link cannot be born expired.
 */
export function validatePromptLinkInput(
	input: PromptLinkCreateInput,
	now: number = Date.now()
): string | null {
	if (!input.agentId || typeof input.agentId !== 'string')
		return 'Choose the agent the link runs in.';
	if (typeof input.prompt !== 'string' || input.prompt.trim().length === 0) {
		return 'Write the prompt the link sends.';
	}
	if (input.prompt.length > PROMPT_LINK_MAX_PROMPT_CHARS) {
		return `The prompt is longer than ${PROMPT_LINK_MAX_PROMPT_CHARS.toLocaleString()} characters.`;
	}
	if (input.label !== undefined) {
		if (typeof input.label !== 'string') return 'The label must be text.';
		if (input.label.length > PROMPT_LINK_MAX_LABEL_CHARS) {
			return `The label is longer than ${PROMPT_LINK_MAX_LABEL_CHARS} characters.`;
		}
	}
	if (input.maxUses !== undefined && input.maxUses !== null) {
		if (
			!Number.isInteger(input.maxUses) ||
			input.maxUses < 1 ||
			input.maxUses > PROMPT_LINK_MAX_USES
		) {
			return `Uses must be a whole number from 1 to ${PROMPT_LINK_MAX_USES.toLocaleString()}, or unlimited.`;
		}
	}
	if (input.expiresAt !== undefined) {
		if (!Number.isFinite(input.expiresAt)) return 'The expiry is not a valid time.';
		if (input.expiresAt <= now) return 'The expiry is already in the past.';
	}
	if (input.open !== undefined && !PROMPT_LINK_OPEN_MODES.includes(input.open)) {
		return 'Open must be "background" or "foreground".';
	}
	return null;
}

/**
 * Parse a `--uses` value: a positive whole number, or `unlimited`. Returns
 * `undefined` when the text is neither, so the caller can say so.
 */
export function parsePromptLinkUses(text: string): number | null | undefined {
	const trimmed = text.trim().toLowerCase();
	if (trimmed === 'unlimited' || trimmed === 'inf' || trimmed === 'infinite') return null;
	if (!/^\d+$/.test(trimmed)) return undefined;
	const n = Number(trimmed);
	return Number.isInteger(n) && n >= 1 && n <= PROMPT_LINK_MAX_USES ? n : undefined;
}

/**
 * Parse an `--expires` value (`30d`, `12h`, `90m`) into an absolute epoch ms.
 * `never` means no expiry. Returns `undefined` when unparseable or zero.
 */
export function parsePromptLinkExpiry(
	text: string,
	now: number = Date.now()
): number | null | undefined {
	const trimmed = text.trim().toLowerCase();
	if (trimmed === 'never') return null;
	const ms = parseScheduleDuration(trimmed);
	if (ms === null || ms <= 0) return undefined;
	return now + ms;
}

/** Expiry choices the create form offers. `null` = never. */
export const PROMPT_LINK_EXPIRY_PRESETS: readonly {
	id: string;
	label: string;
	ms: number | null;
}[] = [
	{ id: 'never', label: 'Never', ms: null },
	{ id: '1d', label: '1 day', ms: 86_400_000 },
	{ id: '7d', label: '7 days', ms: 7 * 86_400_000 },
	{ id: '30d', label: '30 days', ms: 30 * 86_400_000 },
	{ id: '90d', label: '90 days', ms: 90 * 86_400_000 },
];

/**
 * Resolve a link by full id or unique id prefix, the way the CLI accepts it.
 * Returns the link, or the reason it could not be picked.
 */
export function resolvePromptLinkId(
	links: readonly PromptLinkPublic[],
	idOrPrefix: string
): { link: PromptLinkPublic } | { error: string } {
	const needle = idOrPrefix.trim();
	if (!needle) return { error: 'Name the prompt link to act on.' };
	const exact = links.find((l) => l.id === needle);
	if (exact) return { link: exact };
	const matches = links.filter((l) => l.id.startsWith(needle));
	if (matches.length === 1) return { link: matches[0] };
	if (matches.length === 0) return { error: `No prompt link matches "${needle}".` };
	return { error: `"${needle}" matches ${matches.length} prompt links. Use more of the id.` };
}

// ============================================================================
// `maestro-cli prompt-link` wire request
// ============================================================================

export type PromptLinkCommandRequest =
	| { action: 'create'; input: PromptLinkCreateInput }
	| { action: 'list' }
	| { action: 'revoke'; id: string };

export interface PromptLinkCommandResult {
	success: boolean;
	error?: string;
	link?: PromptLinkPublic;
	links?: PromptLinkPublic[];
	url?: string;
}

/**
 * Validate the shape of a `prompt_link_command` message. Field-level rules
 * (prompt length, expiry in the future) are `validatePromptLinkInput`'s job and
 * run again in the store, so a hand-built message cannot skip them.
 */
export function parsePromptLinkCommandRequest(
	raw: Record<string, unknown>
): { ok: true; request: PromptLinkCommandRequest } | { ok: false; error: string } {
	const action = raw.action;
	if (action === 'list') return { ok: true, request: { action: 'list' } };
	if (action === 'revoke') {
		if (typeof raw.id !== 'string' || !raw.id.trim()) {
			return { ok: false, error: 'revoke needs the id of the prompt link' };
		}
		return { ok: true, request: { action: 'revoke', id: raw.id.trim() } };
	}
	if (action === 'create') {
		const input = raw.input;
		if (!input || typeof input !== 'object') return { ok: false, error: 'create needs an input' };
		const i = input as Record<string, unknown>;
		const maxUses = i.maxUses;
		if (maxUses !== undefined && maxUses !== null && typeof maxUses !== 'number') {
			return { ok: false, error: 'maxUses must be a number or null' };
		}
		if (i.expiresAt !== undefined && typeof i.expiresAt !== 'number') {
			return { ok: false, error: 'expiresAt must be a number' };
		}
		if (i.open !== undefined && i.open !== 'background' && i.open !== 'foreground') {
			return { ok: false, error: 'open must be "background" or "foreground"' };
		}
		return {
			ok: true,
			request: {
				action: 'create',
				input: {
					agentId: typeof i.agentId === 'string' ? i.agentId : '',
					prompt: typeof i.prompt === 'string' ? i.prompt : '',
					...(typeof i.label === 'string' && i.label.trim() ? { label: i.label.trim() } : {}),
					...(maxUses !== undefined ? { maxUses: maxUses as number | null } : {}),
					...(typeof i.expiresAt === 'number' ? { expiresAt: i.expiresAt } : {}),
					...(i.open === 'background' || i.open === 'foreground' ? { open: i.open } : {}),
				},
			},
		};
	}
	return { ok: false, error: `Unknown prompt-link action: ${String(action)}` };
}

/**
 * Board auto-decompose (Board Phase 5) - OPTIONAL, OFF by default.
 *
 * When a board has `autoDecompose: true`, the dispatcher may take a `triage`
 * card, run ONE LLM pass over it, and fan it into a small graph of child cards
 * with their parent dependencies wired. This is a strictly additive layer: with
 * the flag off (the default), triage cards are never auto-expanded and simply
 * wait for manual promotion, so the manual Board (Phases 1-4) stays fully
 * useful on its own.
 *
 * This module is framework-free (no Electron, no filesystem, no prompt-registry
 * import) so it runs in the CLI `board tick` and the desktop dispatcher alike.
 * The prompt template and the spawn are injected; the caller loads the editable
 * `board-decompose` prompt (`getPrompt` in main, `getCliPrompt` in the CLI) and
 * supplies the agent-spawn callback.
 *
 * Runaway guard: at most `maxPerTick` triage cards are decomposed per pass
 * (default 3, mirroring Hermes' `auto_decompose_per_tick`). A decomposed triage
 * card is moved OUT of `triage` (to `done`) so it is never re-expanded on the
 * next tick.
 */

import type { Board, BoardCard, CardRun } from '../../shared/board/types';
import { generateUUID } from '../../shared/uuid';

/** Default cap on triage cards decomposed per tick. Mirrors Hermes' default. */
export const DEFAULT_AUTO_DECOMPOSE_PER_TICK = 3;

/**
 * Spawn callback: run one LLM pass over the built decomposition `prompt` for a
 * given triage card and return the raw agent output (or `null` on failure).
 */
export type DecomposeSpawn = (prompt: string, triageCard: BoardCard) => Promise<string | null>;

/** Injected side effects for {@link autoDecomposeBoard}. */
export interface AutoDecomposeDeps {
	/** Run the decomposition LLM pass. */
	spawn: DecomposeSpawn;
	/**
	 * The editable `board-decompose` prompt template. `{{CARD_TITLE}}` and
	 * `{{CARD_BODY}}` are substituted per card. When omitted, a compact built-in
	 * fallback template is used so the feature still works headlessly.
	 */
	promptTemplate?: string;
	/** ISO clock, injectable for tests. */
	now?: () => string;
	/** Triage cards decomposed per tick. Defaults to {@link DEFAULT_AUTO_DECOMPOSE_PER_TICK}. */
	maxPerTick?: number;
	/** Optional structured log sink. */
	onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
	/**
	 * Re-read the board from its source of truth. Supply this (together with
	 * {@link save}) whenever OTHER writers can touch the board while an LLM pass
	 * is in flight - which is the case on the desktop, where the dispatcher
	 * persists card status changes on every heartbeat.
	 *
	 * An LLM pass takes minutes. Without a reload we would append the children to
	 * the snapshot loaded at tick start and persist THAT, silently reverting every
	 * status change the dispatcher made in the meantime. Same reload-before-save
	 * pattern the dispatcher's own `finalize()` uses.
	 *
	 * When omitted, the mutations are applied to the passed-in `board` and the
	 * caller persists it (the CLI's single-shot `board tick`, where nothing else
	 * is writing during the pass).
	 */
	reload?: () => Board | null;
	/** Persist a merged board. Required when {@link reload} is supplied. */
	save?: (board: Board) => void;
}

/** One parsed child card from the LLM output. */
export interface DecomposedChild {
	title: string;
	body: string;
	/** Zero-based indices of OTHER children in the same array that must finish first. */
	dependsOn: number[];
}

/** Compact fallback used when no editable template is supplied. */
const FALLBACK_TEMPLATE = [
	'Decompose this task into 2-6 concrete child cards (or a single card restating it if it is already atomic).',
	'',
	'Title: {{CARD_TITLE}}',
	'',
	'Body:',
	'{{CARD_BODY}}',
	'',
	'Respond with ONLY a ```json fenced block containing an array of',
	'{ "title": string, "body": string, "dependsOn": number[] } where dependsOn holds',
	'zero-based indices of earlier cards that must finish first. Keep the graph acyclic.',
].join('\n');

/** Substitute the card fields into a decomposition prompt template. */
export function buildDecomposePrompt(template: string, card: BoardCard): string {
	return template
		.replace(/\{\{CARD_TITLE\}\}/g, card.title)
		.replace(/\{\{CARD_BODY\}\}/g, card.body || '(no additional detail)');
}

/**
 * Parse an LLM decomposition response into child cards. Tolerant of prose around
 * a fenced ```json block and of a bare top-level JSON array. Returns `[]` when
 * nothing usable is found (the caller then leaves the triage card untouched).
 *
 * Each returned child has a non-empty `title`; `dependsOn` is filtered to valid,
 * in-range, non-self indices so a malformed graph can never introduce a cycle or
 * a dangling parent.
 */
export function parseDecomposition(output: string): DecomposedChild[] {
	if (!output || typeof output !== 'string') return [];

	const raw = extractJsonArray(output);
	if (!raw) return [];

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];

	const children: DecomposedChild[] = [];
	for (const entry of parsed) {
		if (!entry || typeof entry !== 'object') continue;
		const e = entry as Record<string, unknown>;
		const title = typeof e.title === 'string' ? e.title.trim() : '';
		if (!title) continue;
		const body = typeof e.body === 'string' ? e.body.trim() : '';
		const dependsOn = Array.isArray(e.dependsOn)
			? e.dependsOn.filter(
					(n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0
				)
			: [];
		children.push({ title, body, dependsOn });
	}

	// Clamp dependsOn to valid, non-self, in-range indices now that we know the
	// final child count. This guarantees the produced sub-graph is acyclic
	// (edges only point to strictly-earlier cards).
	const count = children.length;
	return children.map((child, index) => ({
		...child,
		dependsOn: Array.from(
			new Set(child.dependsOn.filter((dep) => dep < count && dep !== index && dep < index))
		),
	}));
}

/** Pull the first ```json ...``` block, else the first bare [ ... ] array. */
function extractJsonArray(output: string): string | null {
	const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced && fenced[1].trim().startsWith('[')) {
		return fenced[1].trim();
	}
	const start = output.indexOf('[');
	const end = output.lastIndexOf(']');
	if (start >= 0 && end > start) {
		return output.slice(start, end + 1);
	}
	return null;
}

/**
 * Run the auto-decompose pass for one board, mutating it in place. Returns the
 * number of triage cards that were successfully decomposed.
 *
 * STRICT GATE: returns 0 immediately when `board.autoDecompose` is not `true`.
 *
 * Persistence depends on the injected deps: with `reload`/`save` wired, each
 * decomposition is merged into a freshly-read board and persisted here (see
 * {@link AutoDecomposeDeps.reload}); without them, mutations land on the passed
 * `board` and the caller persists it once this resolves.
 */
export async function autoDecomposeBoard(board: Board, deps: AutoDecomposeDeps): Promise<number> {
	if (board.autoDecompose !== true) return 0;

	const now = deps.now ?? (() => new Date().toISOString());
	const maxPerTick =
		deps.maxPerTick && deps.maxPerTick > 0 ? deps.maxPerTick : DEFAULT_AUTO_DECOMPOSE_PER_TICK;
	const template = deps.promptTemplate?.trim() ? deps.promptTemplate : FALLBACK_TEMPLATE;

	const triage = board.cards.filter((c) => c.status === 'triage').slice(0, maxPerTick);
	if (triage.length === 0) return 0;

	let decomposed = 0;
	for (const card of triage) {
		const prompt = buildDecomposePrompt(template, card);
		let output: string | null;
		try {
			output = await deps.spawn(prompt, card);
		} catch (err) {
			deps.onLog?.('warn', `decompose spawn failed for "${card.id}": ${errText(err)}`);
			continue;
		}
		if (!output) {
			deps.onLog?.('warn', `decompose produced no output for "${card.id}"`);
			continue;
		}

		const children = parseDecomposition(output);
		if (children.length === 0) {
			deps.onLog?.('warn', `decompose produced no parseable children for "${card.id}"`);
			continue;
		}

		if (!applyDecomposition(board, card, children, now(), deps)) continue;
		decomposed++;
		deps.onLog?.('info', `decomposed "${card.title}" into ${children.length} child card(s)`);
	}

	return decomposed;
}

/**
 * Merge one card's children into the board and (when reloading) persist.
 * Returns false when the decomposition was dropped, so the caller does not
 * count it.
 *
 * With `reload`/`save` wired, the merge lands on a board read fresh from disk
 * rather than on the minutes-old snapshot this pass started from - everything
 * the dispatcher persisted in between survives. The freshly-read triage card is
 * re-checked before appending: if it is gone, or no longer `triage` (a human
 * moved it, or a racing pass already expanded it), the result is discarded
 * rather than resurrecting a retired card or double-expanding it.
 */
function applyDecomposition(
	board: Board,
	card: BoardCard,
	children: DecomposedChild[],
	nowIso: string,
	deps: AutoDecomposeDeps
): boolean {
	if (!deps.reload || !deps.save) {
		appendChildren(board, card, children, nowIso);
		return true;
	}

	const fresh = deps.reload();
	if (!fresh) {
		deps.onLog?.('warn', `decompose: board vanished before "${card.id}" could be merged`);
		return false;
	}
	const freshTriage = fresh.cards.find((c) => c.id === card.id);
	if (!freshTriage) {
		deps.onLog?.('warn', `decompose: card "${card.id}" was deleted while decomposing`);
		return false;
	}
	if (freshTriage.status !== 'triage') {
		deps.onLog?.(
			'warn',
			`decompose: card "${card.id}" left triage while decomposing - discarding result`
		);
		return false;
	}

	appendChildren(fresh, freshTriage, children, nowIso);
	deps.save(fresh);
	return true;
}

/**
 * Append `children` to the board as new `todo` cards, wiring each child's parents
 * to the triage card (lineage + gate) plus its resolved sibling dependencies, and
 * move the triage card to `done` so it is not re-expanded next tick.
 */
function appendChildren(
	board: Board,
	triage: BoardCard,
	children: DecomposedChild[],
	nowIso: string
): void {
	// Mint ids first so sibling dependsOn indices can map to real card ids.
	const ids = children.map(() => generateUUID());
	for (let i = 0; i < children.length; i++) {
		const child = children[i];
		const siblingParents = child.dependsOn
			.map((dep) => ids[dep])
			.filter((id): id is string => !!id);
		const newCard: BoardCard = {
			id: ids[i],
			title: child.title,
			body: child.body,
			// Depend on the triage umbrella (which we mark done below) + siblings.
			parents: Array.from(new Set([triage.id, ...siblingParents])),
			status: 'todo',
			createdAt: nowIso,
			updatedAt: nowIso,
		};
		// Inherit the triage card's assignee (role and/or pinned agent) so children
		// run under the same assignment. Both are optional (Phase 6), but the triage
		// card always has at least one, so children stay valid.
		if (triage.assigneeProfileId) newCard.assigneeProfileId = triage.assigneeProfileId;
		if (triage.assigneeAgentId) newCard.assigneeAgentId = triage.assigneeAgentId;
		board.cards.push(newCard);
	}

	// Retire the triage card so it is never decomposed again. Record a run note.
	const run: CardRun = {
		attempt: (triage.runs?.length ?? 0) + 1,
		startedAt: nowIso,
		endedAt: nowIso,
		outcome: 'done',
		summary: `Auto-decomposed into ${children.length} child card(s).`,
	};
	triage.runs = [...(triage.runs ?? []), run];
	triage.status = 'done';
	triage.updatedAt = nowIso;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

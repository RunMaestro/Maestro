/**
 * Claude Transcript Sanitizer
 *
 * Strips subscription-account thinking shells out of a Claude Code JSONL
 * transcript so it can be safely resumed under the API token source.
 *
 * Why this exists
 * ---------------
 * maestro-p's interactive turns persist thinking blocks as signature-only
 * shells: the `thinking` text is empty but a `signature` (bound to the
 * subscription account that produced it) is retained. When the wrapper exits
 * with code 2 mid-turn (Max-plan quota), the controller respawns the same
 * prompt under `claude --print --resume`, which re-sends those blocks to the
 * Anthropic API. The API rejects the request with:
 *
 *   400 messages.N.content.M: `thinking` or `redacted_thinking` blocks in the
 *   latest assistant message cannot be modified. These blocks must remain as
 *   they were in the original response.
 *
 * because the signature is account-scoped (subscription, not API). Once a
 * poisoned block is in history, every subsequent `--resume` re-hits the same
 * 400, which is what makes a conversation get permanently "stuck".
 *
 * Scope: empty-thinking shells only
 * ---------------------------------
 * Only blocks with **empty** `thinking` text are stripped. Valid API-account
 * thinking blocks always carry non-empty reasoning text alongside their
 * signature, and Anthropic's API requires them to be re-sent verbatim when
 * extended thinking is enabled on the next turn - removing them would itself
 * trip the same 400. The signature-only shell pattern is unique to maestro-p,
 * so the narrow predicate is the only safe target.
 *
 * Transform
 * ---------
 *   - For every assistant message, remove empty-thinking shells (any
 *     `thinking` / `redacted_thinking` block with `thinking === ''`).
 *   - If a message's content becomes empty, drop the whole row and re-link any
 *     descendants (`parentUuid`) to the dropped row's parent so the linked-list
 *     threading Claude Code relies on stays intact (transitively, in case of
 *     consecutive dropped rows).
 *   - Non-message rows (attachment, last-prompt, mode, ...) are preserved; only
 *     their `parentUuid` is re-linked when it pointed at a dropped row.
 *
 * The file is rewritten atomically (temp file + rename). A one-time `.bak`
 * sibling is written before the first mutation so the original is recoverable.
 *
 * Idempotent: a transcript with no empty thinking shells is left byte-for-byte
 * unchanged and reports `sanitized: false`. Safe to run on pure-API transcripts.
 */

import * as fs from 'fs';

const THINKING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);

export interface SanitizeResult {
	/** True when the transcript was rewritten (at least one block removed). */
	sanitized: boolean;
	/** Assistant rows dropped because their content became empty. */
	droppedRows: number;
	/** Thinking blocks removed from rows that retained other content. */
	strippedBlocks: number;
	/** Path of the `.bak` written before mutation, or null when untouched. */
	backupPath: string | null;
}

interface ParsedRow {
	raw: string;
	obj: Record<string, unknown> | null;
}

/**
 * Empty-thinking shell: a `thinking` / `redacted_thinking` block whose `thinking`
 * text is the empty string. This is what maestro-p persists for subscription-
 * account turns and the only shape we strip. API-account thinking blocks always
 * have non-empty reasoning text and are preserved verbatim.
 *
 * `redacted_thinking` blocks may legitimately lack a `thinking` field; treat a
 * missing field as empty for the same reason - they carry only an account-bound
 * signature with no resumable reasoning content.
 */
function isStrippableThinkingShell(block: unknown): boolean {
	if (!block || typeof block !== 'object') return false;
	const b = block as { type?: unknown; thinking?: unknown };
	if (!THINKING_BLOCK_TYPES.has(b.type as string)) return false;
	const thinking = b.thinking;
	if (thinking === undefined) return true;
	return typeof thinking === 'string' && thinking.length === 0;
}

function getMessage(obj: Record<string, unknown>): Record<string, unknown> | null {
	const msg = obj.message;
	return msg && typeof msg === 'object' ? (msg as Record<string, unknown>) : null;
}

/**
 * Strip thinking blocks from the transcript at `transcriptPath`.
 *
 * Returns a no-op result (and leaves the file untouched) when the path doesn't
 * exist or contains no thinking blocks. Throws only on unexpected I/O failures
 * the caller should surface; malformed individual lines are passed through
 * verbatim rather than dropped.
 */
export function stripThinkingFromTranscript(transcriptPath: string): SanitizeResult {
	const noop: SanitizeResult = {
		sanitized: false,
		droppedRows: 0,
		strippedBlocks: 0,
		backupPath: null,
	};

	if (!fs.existsSync(transcriptPath)) return noop;

	const original = fs.readFileSync(transcriptPath, 'utf8');
	// Preserve trailing-newline shape: split on \n, the final element is the
	// trailing-newline remainder (usually "") which we re-join unchanged.
	const lines = original.split('\n');

	const rows: ParsedRow[] = lines.map((raw: string) => {
		const trimmed = raw.trim();
		if (trimmed.length === 0) return { raw, obj: null };
		try {
			const obj = JSON.parse(trimmed) as Record<string, unknown>;
			return { raw, obj };
		} catch {
			return { raw, obj: null };
		}
	});

	// Pass 1: decide which rows to drop and which to rewrite, and remember each
	// dropped row's parentUuid so descendants can be re-linked.
	const droppedParentByUuid = new Map<string, string | null>();
	let droppedRows = 0;
	let strippedBlocks = 0;

	for (const row of rows) {
		if (!row.obj) continue;
		const msg = getMessage(row.obj);
		const content = msg?.content;
		if (!Array.isArray(content)) continue;

		const thinkingCount = content.filter(isStrippableThinkingShell).length;
		if (thinkingCount === 0) continue;

		const remaining = content.filter((b) => !isStrippableThinkingShell(b));
		if (remaining.length === 0) {
			const uuid = typeof row.obj.uuid === 'string' ? row.obj.uuid : null;
			const parentUuid =
				typeof row.obj.parentUuid === 'string' ? (row.obj.parentUuid as string) : null;
			if (uuid) droppedParentByUuid.set(uuid, parentUuid);
			droppedRows += 1;
		} else {
			strippedBlocks += thinkingCount;
		}
	}

	if (droppedRows === 0 && strippedBlocks === 0) return noop;

	// Resolve a parentUuid past any chain of dropped rows.
	const resolveParent = (parentUuid: string | null): string | null => {
		let current = parentUuid;
		const seen = new Set<string>();
		while (current && droppedParentByUuid.has(current)) {
			if (seen.has(current)) break; // cycle guard
			seen.add(current);
			current = droppedParentByUuid.get(current) ?? null;
		}
		return current;
	};

	// Pass 2: emit the rewritten transcript.
	const outLines: string[] = [];
	for (const row of rows) {
		if (!row.obj) {
			outLines.push(row.raw);
			continue;
		}

		const uuid = typeof row.obj.uuid === 'string' ? row.obj.uuid : null;
		if (uuid && droppedParentByUuid.has(uuid)) {
			// This row was dropped.
			continue;
		}

		let mutated = false;
		const obj = row.obj;

		// Re-link parentUuid if it pointed at a dropped row.
		const parentUuid = typeof obj.parentUuid === 'string' ? (obj.parentUuid as string) : null;
		if (parentUuid && droppedParentByUuid.has(parentUuid)) {
			obj.parentUuid = resolveParent(parentUuid);
			mutated = true;
		}

		// Strip thinking blocks from a surviving (mixed-content) message.
		const msg = getMessage(obj);
		const content = msg?.content;
		if (Array.isArray(content) && content.some(isStrippableThinkingShell)) {
			msg!.content = content.filter((b) => !isStrippableThinkingShell(b));
			mutated = true;
		}

		outLines.push(mutated ? JSON.stringify(obj) : row.raw);
	}

	const output = outLines.join('\n');

	// Back up the original once, then rewrite atomically.
	const backupPath = `${transcriptPath}.maestro-presanitize.bak`;
	if (!fs.existsSync(backupPath)) {
		fs.writeFileSync(backupPath, original, 'utf8');
	}

	const tmpPath = `${transcriptPath}.maestro-sanitize.tmp`;
	fs.writeFileSync(tmpPath, output, 'utf8');
	fs.renameSync(tmpPath, transcriptPath);

	return { sanitized: true, droppedRows, strippedBlocks, backupPath };
}

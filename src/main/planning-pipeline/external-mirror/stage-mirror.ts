/**
 * stage-mirror.ts
 *
 * External mirror extension — appends pipeline stage-transition and retry audit
 * lines to an existing work-item markdown mirror file.
 *
 * ## Design goals
 *
 * - **Append-only**: the existing frontmatter and body sections are never
 *   touched.  Only the `## Stage transitions` section at the end of the file
 *   is modified, which keeps git diffs minimal and chronological.
 * - **Dependency-injected I/O**: all filesystem access is channelled through
 *   `StageMirrorDeps`.  No `import fs` here — this makes unit tests trivial
 *   (no temp files, no mocks of Node built-ins).
 * - **Best-effort / non-blocking**: callers choose what to do when
 *   `appended: false` is returned (mirror file not yet created).  This module
 *   never throws for an absent file; it only throws for I/O errors that the
 *   caller must handle.
 *
 * ## Line format
 *
 * Stage transition:
 *   `- 2026-04-30T18:42:01Z — agent:session-abc moved from runner-active to needs-review [attempt 2] [reason: "pr-opened"]`
 *
 * Retry event:
 *   `- 2026-04-30T18:42:01Z — system:planning-pipeline RETRY attempt=2 reason: "claim expired"`
 *
 * @see stage-mirror-types.ts — StageTransitionEntry
 * @see src/main/delivery-planner/external-mirror.ts — full-rewrite mirror (writeExternalMirror)
 */

import type { StageTransitionEntry } from './stage-mirror-types';

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

/**
 * Injected I/O operations used by `appendStageTransition` and
 * `appendRetryEvent`.
 *
 * The production implementation wraps `node:fs/promises`; tests use stubs.
 */
export interface StageMirrorDeps {
	/**
	 * Read the current contents of the mirror file at `filePath`.
	 * Returns `null` when the file does not exist yet (ENOENT), so that
	 * callers can distinguish "missing" from other I/O errors.
	 */
	readMirrorFile(filePath: string): Promise<string | null>;
	/**
	 * Overwrite the mirror file at `filePath` with `content`.
	 * The implementation is expected to create parent directories as needed.
	 */
	writeMirrorFile(filePath: string, content: string): Promise<void>;
	/**
	 * Resolve the canonical mirror file path for a given work-item ID.
	 * The path must already exist on disk for the append to succeed.
	 */
	mirrorPathFor(workItemId: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export interface AppendResult {
	/** Resolved path of the mirror file. */
	path: string;
	/**
	 * `true`  — the line was appended successfully.
	 * `false` — the mirror file did not exist; the caller may choose to create
	 *           it first and then retry.
	 */
	appended: boolean;
}

// ---------------------------------------------------------------------------
// Section header constant
// ---------------------------------------------------------------------------

const SECTION_HEADER = '## Stage transitions';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a single stage-transition audit line to the mirror file.
 *
 * Behaviour:
 * - If the file does not exist, returns `{ appended: false }` without writing.
 * - If the `## Stage transitions` section is absent, it is appended at the end.
 * - The new line is always placed at the end of the section (chronological order).
 */
export async function appendStageTransition(
	deps: StageMirrorDeps,
	entry: StageTransitionEntry
): Promise<AppendResult> {
	const path = await deps.mirrorPathFor(entry.workItemId);
	const existing = await deps.readMirrorFile(path);

	if (existing === null) {
		return { path, appended: false };
	}

	const line = formatTransitionLine(entry);
	const updated = appendToSection(existing, line);
	await deps.writeMirrorFile(path, updated);
	return { path, appended: true };
}

/**
 * Convenience wrapper that records a retry event in the same
 * `## Stage transitions` section using a distinct log-line format.
 */
export async function appendRetryEvent(
	deps: StageMirrorDeps,
	args: {
		workItemId: string;
		attempt: number;
		reason: string;
		occurredAt: string;
	}
): Promise<AppendResult> {
	const path = await deps.mirrorPathFor(args.workItemId);
	const existing = await deps.readMirrorFile(path);

	if (existing === null) {
		return { path, appended: false };
	}

	const line = formatRetryLine(args);
	const updated = appendToSection(existing, line);
	await deps.writeMirrorFile(path, updated);
	return { path, appended: true };
}

// ---------------------------------------------------------------------------
// Line formatters
// ---------------------------------------------------------------------------

/**
 * Format a stage-transition audit line.
 *
 * Pattern:
 *   `- <timestamp> — <actor.type>:<actor.id> moved from <fromStage|none> to <toStage> [attempt N] [reason: "..."]`
 */
function formatTransitionLine(entry: StageTransitionEntry): string {
	const from = entry.fromStage ?? 'none';
	let line = `- ${entry.occurredAt} — ${entry.actor.type}:${entry.actor.id} moved from ${from} to ${entry.toStage}`;

	if (entry.attempt !== undefined) {
		line += ` [attempt ${entry.attempt}]`;
	}

	if (entry.reason !== undefined) {
		line += ` [reason: "${entry.reason}"]`;
	}

	return line;
}

/**
 * Format a retry-event audit line.
 *
 * Pattern:
 *   `- <timestamp> — system:planning-pipeline RETRY attempt=N reason: "..."`
 */
function formatRetryLine(args: { attempt: number; reason: string; occurredAt: string }): string {
	return `- ${args.occurredAt} — system:planning-pipeline RETRY attempt=${args.attempt} reason: "${args.reason}"`;
}

// ---------------------------------------------------------------------------
// Section management
// ---------------------------------------------------------------------------

/**
 * Append `line` under the `## Stage transitions` section in `content`.
 *
 * If the section does not exist it is created at the end of the file,
 * separated from any preceding content by a blank line.
 *
 * Existing lines in the section are preserved; the new line is placed last.
 */
function appendToSection(content: string, line: string): string {
	const sectionIdx = content.indexOf(SECTION_HEADER);

	if (sectionIdx === -1) {
		// Section absent — create it at the end.
		const trimmed = content.trimEnd();
		return `${trimmed}\n\n${SECTION_HEADER}\n\n${line}\n`;
	}

	// Section exists — find the end of it (next `##` heading or EOF).
	const afterHeader = sectionIdx + SECTION_HEADER.length;
	const nextSectionIdx = findNextSection(content, afterHeader);

	if (nextSectionIdx === -1) {
		// Section runs to EOF — append at the very end.
		const trimmed = content.trimEnd();
		return `${trimmed}\n${line}\n`;
	}

	// There is a subsequent section — insert before it.
	const before = content.slice(0, nextSectionIdx).trimEnd();
	const after = content.slice(nextSectionIdx);
	return `${before}\n${line}\n\n${after}`;
}

/**
 * Return the index of the next `##` heading that starts after `fromIndex`,
 * or `-1` if none exists.
 */
function findNextSection(content: string, fromIndex: number): number {
	const rest = content.slice(fromIndex);
	// Match a `##` that is at the start of a line (after a newline).
	const match = rest.match(/\n##\s/);

	if (!match || match.index === undefined) {
		return -1;
	}

	// +1 for the leading `\n` that the regex consumed but isn't a section char.
	return fromIndex + match.index + 1;
}

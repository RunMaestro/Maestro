/**
 * Token usage and cost for a whole Claude Code session, subagents included.
 *
 * Claude Code writes a subagent's conversation to its own transcript at
 * `<sessionId>/subagents/agent-*.jsonl`, beside the parent's `<sessionId>.jsonl`.
 * None of those API calls appear in the parent file, so pricing the parent alone
 * leaves every Task/subagent call out of the session's cost. Every Claude stats
 * reader goes through here rather than calling `computeClaudeUsageCost` on the
 * parent's content directly.
 *
 * Shared because the CLI (sync fs) and the main process (async fs) both price
 * sessions and must agree. Never import this from the renderer.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createClaudeUsageAccumulator, type ClaudeUsageBreakdown } from './modelPricing';

/** Read failures that mean "no subagent transcript here", not "something is wrong". */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR']);

function isAbsent(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === 'string' && ABSENT_CODES.has(code);
}

/** The directory holding a session's subagent transcripts. */
export function claudeSubagentDir(sessionFilePath: string): string {
	return path.join(sessionFilePath.replace(/\.jsonl$/, ''), 'subagents');
}

/**
 * Each subagent transcript a session spawned, read one at a time (async). A
 * caller that only folds the contents into a total holds one file at a time
 * instead of every subagent's transcript at once.
 */
export async function* iterateClaudeSubagentTranscripts(
	sessionFilePath: string
): AsyncGenerator<string> {
	const dir = claudeSubagentDir(sessionFilePath);
	let names: string[];
	try {
		names = await fs.promises.readdir(dir);
	} catch (error) {
		if (isAbsent(error)) return;
		throw error;
	}
	for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
		let content: string;
		try {
			content = await fs.promises.readFile(path.join(dir, name), 'utf-8');
		} catch (error) {
			if (isAbsent(error)) continue;
			throw error;
		}
		yield content;
	}
}

/** Contents of every subagent transcript a session spawned (async). */
export async function readClaudeSubagentTranscripts(sessionFilePath: string): Promise<string[]> {
	const contents: string[] = [];
	for await (const content of iterateClaudeSubagentTranscripts(sessionFilePath)) {
		contents.push(content);
	}
	return contents;
}

/** Contents of every subagent transcript a session spawned (sync, for the CLI). */
export function readClaudeSubagentTranscriptsSync(sessionFilePath: string): string[] {
	const dir = claudeSubagentDir(sessionFilePath);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch (error) {
		if (isAbsent(error)) return [];
		throw error;
	}
	const contents: string[] = [];
	for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
		try {
			contents.push(fs.readFileSync(path.join(dir, name), 'utf-8'));
		} catch (error) {
			if (!isAbsent(error)) throw error;
		}
	}
	return contents;
}

/**
 * Price a session from contents already in hand: its own transcript plus its
 * subagents'. The parser counts each API response once across all of them, so
 * the result is the same as pricing them as one document. They are never joined
 * into one: on a long session with many subagents the joined string can pass
 * V8's maximum string length (MAESTRO-17M).
 */
export function computeClaudeUsageWithSubagents(
	parentContent: string,
	subagentContents: readonly string[]
): ClaudeUsageBreakdown {
	const usage = createClaudeUsageAccumulator();
	usage.add(parentContent);
	for (const content of subagentContents) usage.add(content);
	return usage.finish();
}

/** Usage and cost for a session file plus its subagents (async), one subagent file at a time. */
export async function computeClaudeSessionUsage(
	sessionFilePath: string,
	parentContent: string
): Promise<ClaudeUsageBreakdown> {
	const usage = createClaudeUsageAccumulator();
	usage.add(parentContent);
	for await (const content of iterateClaudeSubagentTranscripts(sessionFilePath)) {
		usage.add(content);
	}
	return usage.finish();
}

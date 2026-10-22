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
import { computeClaudeUsageCost, type ClaudeUsageBreakdown } from './modelPricing';

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

/** Contents of every subagent transcript a session spawned (async). */
export async function readClaudeSubagentTranscripts(sessionFilePath: string): Promise<string[]> {
	const dir = claudeSubagentDir(sessionFilePath);
	let names: string[];
	try {
		names = await fs.promises.readdir(dir);
	} catch (error) {
		if (isAbsent(error)) return [];
		throw error;
	}
	const contents: string[] = [];
	for (const name of names.filter((n) => n.endsWith('.jsonl')).sort()) {
		try {
			contents.push(await fs.promises.readFile(path.join(dir, name), 'utf-8'));
		} catch (error) {
			if (!isAbsent(error)) throw error;
		}
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
 * subagents'. The parser is line-based and counts each API response once, so the
 * parent and its subagent transcripts can simply be priced as one document.
 */
export function computeClaudeUsageWithSubagents(
	parentContent: string,
	subagentContents: readonly string[]
): ClaudeUsageBreakdown {
	if (subagentContents.length === 0) return computeClaudeUsageCost(parentContent);
	return computeClaudeUsageCost([parentContent, ...subagentContents].join('\n'));
}

/** Usage and cost for a session file plus its subagents (async). */
export async function computeClaudeSessionUsage(
	sessionFilePath: string,
	parentContent: string
): Promise<ClaudeUsageBreakdown> {
	return computeClaudeUsageWithSubagents(
		parentContent,
		await readClaudeSubagentTranscripts(sessionFilePath)
	);
}

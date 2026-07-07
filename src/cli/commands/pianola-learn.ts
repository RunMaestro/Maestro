/**
 * Pianola learn CLI command.
 *
 * `pianola learn` crawls the installed CLIs' native transcripts (Claude Code +
 * Codex) into a labeled decision corpus: every awaiting-input moment paired with
 * how the user actually replied, classified via the shared brain. This is the raw
 * material Pianola synthesizes its decision profile and hard-rule suggestions
 * from. Split out of pianola.ts (the watcher shell) so each command file stays
 * focused; the Encore gate is shared via `ensurePianolaEnabled`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ensurePianolaEnabled } from './pianola';
import {
	parseClaudeTranscriptLine,
	parseCodexTranscriptLine,
	parseClaudeCwd,
	parseCodexCwd,
	extractDecisionPairs,
	aggregateDecisionPairs,
	type DecisionPair,
	type TranscriptAgent,
} from '../../shared/pianola/transcript-mining';
import type { PianolaMessage } from '../../shared/pianola/types';

const LEARN_MAX_FILE_BYTES = 50 * 1024 * 1024; // skip transcripts larger than 50 MB
const LEARN_DEFAULT_SESSION_LIMIT = 300; // per agent, newest first
const LEARN_DEFAULT_STDOUT_PAIRS = 200; // pairs printed inline when no --out

export interface PianolaLearnOptions {
	agent?: string;
	limit?: string;
	out?: string;
	maxPairs?: string;
	since?: string;
	project?: string;
	exclude?: string;
	json?: boolean;
}

/** Recursively collect files under a directory whose name matches `match`. */
function collectTranscriptFiles(
	dir: string,
	match: (name: string) => boolean
): { path: string; mtime: number }[] {
	const out: { path: string; mtime: number }[] = [];
	const walk = (d: string): void => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(d, { withFileTypes: true });
		} catch {
			return; // unreadable dir (missing/permission) - skip
		}
		for (const entry of entries) {
			const full = path.join(d, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (match(entry.name)) {
				try {
					out.push({ path: full, mtime: fs.statSync(full).mtimeMs });
				} catch {
					// unreadable file - skip
				}
			}
		}
	};
	walk(dir);
	return out;
}

/** Read a transcript file's lines, skipping anything too large to mine safely. */
function readTranscriptLines(file: string): string[] | null {
	try {
		const stat = fs.statSync(file);
		if (stat.size > LEARN_MAX_FILE_BYTES) return null;
		return fs.readFileSync(file, 'utf-8').split('\n');
	} catch {
		return null;
	}
}

/** Mine one transcript file into decision pairs using the per-agent parser. */
function minePairsFromFile(agent: TranscriptAgent, file: string): DecisionPair[] {
	const lines = readTranscriptLines(file);
	if (!lines) return [];
	const sessionId = path.basename(file, '.jsonl');
	const messages: PianolaMessage[] = [];
	let projectPath: string | undefined;
	for (const line of lines) {
		const parsed =
			agent === 'claude-code' ? parseClaudeTranscriptLine(line) : parseCodexTranscriptLine(line);
		if (parsed) messages.push(parsed);
		if (!projectPath) {
			projectPath = agent === 'claude-code' ? parseClaudeCwd(line) : parseCodexCwd(line);
		}
	}
	if (messages.length === 0) return [];
	return extractDecisionPairs(messages, { agent, sessionId, projectPath });
}

/**
 * Crawl the installed CLIs' native transcripts and emit a labeled decision
 * corpus: every awaiting-input moment paired with how the user actually replied,
 * classified via the shared brain. This is the raw material Pianola synthesizes
 * its decision profile and hard-rule suggestions from. Output is JSON for Pianola
 * to consume (compact with --json); use --out to write the full corpus to a file.
 */
export function pianolaLearn(options: PianolaLearnOptions): void {
	ensurePianolaEnabled(options.json);

	const requested = (options.agent ?? 'claude-code,codex')
		.split(',')
		.map((a) => a.trim())
		.filter(Boolean);
	const agents: TranscriptAgent[] = [];
	for (const a of requested) {
		if ((a === 'claude-code' || a === 'codex') && !agents.includes(a)) agents.push(a);
	}
	if (agents.length === 0) {
		const message = '--agent must include claude-code and/or codex';
		if (options.json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(message);
		process.exit(1);
	}

	const sessionLimit = options.limit
		? Math.max(1, parseInt(options.limit, 10) || LEARN_DEFAULT_SESSION_LIMIT)
		: LEARN_DEFAULT_SESSION_LIMIT;

	// --since filters transcripts by last-modified date (cheap, before parsing).
	let sinceMs = 0;
	if (options.since) {
		const parsed = Date.parse(options.since);
		if (isNaN(parsed)) {
			const message = `--since must be a date (e.g. 2026-06-01), got "${options.since}"`;
			if (options.json) console.log(JSON.stringify({ success: false, error: message }));
			else console.error(message);
			process.exit(1);
		}
		sinceMs = parsed;
	}

	// --project / --exclude scope by the session's originating path (cwd), so the
	// user can learn from representative work and drop noise (e.g. dev sessions).
	const projectNeedle = options.project?.toLowerCase();
	const excludeNeedle = options.exclude?.toLowerCase();

	const home = os.homedir();
	const allPairs: DecisionPair[] = [];
	const scanned: Record<string, { files: number; sessionsWithDecisions: number }> = {};

	for (const agent of agents) {
		const dir =
			agent === 'claude-code'
				? path.join(home, '.claude', 'projects')
				: path.join(home, '.codex', 'sessions');
		const match =
			agent === 'claude-code'
				? (n: string): boolean => n.endsWith('.jsonl')
				: (n: string): boolean => /^rollout-.*\.jsonl$/i.test(n);
		const files = collectTranscriptFiles(dir, match)
			.filter((f) => f.mtime >= sinceMs)
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, sessionLimit);
		let sessionsWithDecisions = 0;
		for (const file of files) {
			let pairs = minePairsFromFile(agent, file.path);
			// Path-scope filters: a pair with no known projectPath is kept only when
			// no --project filter is set (we cannot confirm a match), and is never
			// dropped by --exclude (we cannot confirm exclusion).
			if (projectNeedle) {
				pairs = pairs.filter((p) => p.projectPath?.toLowerCase().includes(projectNeedle));
			}
			if (excludeNeedle) {
				pairs = pairs.filter((p) => !p.projectPath?.toLowerCase().includes(excludeNeedle));
			}
			if (pairs.length > 0) sessionsWithDecisions += 1;
			allPairs.push(...pairs);
		}
		scanned[agent] = { files: files.length, sessionsWithDecisions };
	}

	const aggregates = aggregateDecisionPairs(allPairs);
	const totalFiles = Object.values(scanned).reduce((n, s) => n + s.files, 0);

	if (options.out) {
		const outPath = path.resolve(options.out);
		fs.writeFileSync(
			outPath,
			JSON.stringify({ scanned, pairCount: allPairs.length, aggregates, pairs: allPairs }, null, 2),
			'utf-8'
		);
		if (options.json) {
			console.log(
				JSON.stringify({
					success: true,
					scanned,
					pairCount: allPairs.length,
					aggregates,
					out: outPath,
				})
			);
		} else {
			console.log(
				`Mined ${allPairs.length} decision(s) from ${totalFiles} transcript(s). Full corpus written to ${outPath}`
			);
		}
		return;
	}

	const maxPairs = options.maxPairs
		? Math.max(0, parseInt(options.maxPairs, 10) || LEARN_DEFAULT_STDOUT_PAIRS)
		: LEARN_DEFAULT_STDOUT_PAIRS;
	const payload = {
		success: true,
		scanned,
		pairCount: allPairs.length,
		aggregates,
		pairs: allPairs.slice(0, maxPairs),
		truncated: allPairs.length > maxPairs,
	};
	console.log(JSON.stringify(payload, null, options.json ? 0 : 2));
}

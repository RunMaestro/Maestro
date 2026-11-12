/**
 * Who may reach the continuity digest.
 *
 * The digest is evidence for a person who asked to see it. It must not enter a
 * prompt, a transcript, the system prompt or a forwarded context on its own, and
 * the cheapest way to keep that true is to make every caller a decision: this
 * test lists, exactly, the production files that import the digest and the
 * preview or name their entry points. A new caller fails here until someone
 * reads why it wants the digest and updates the list on purpose. A caller that
 * is removed fails too, so the list cannot rot into a general permission.
 *
 * It reads source text, so it needs no mocks and sees what a runtime test of one
 * path would miss: a new path nobody thought to test.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

function listSources(dir: string, found: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) listSources(full, found);
		else if (/\.tsx?$/.test(entry.name)) found.push(full);
	}
	return found;
}

/** Source without comments, so a sentence that names a function is not a use of it. */
function code(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const FILES = listSources(SRC).map((file) => ({
	relative: path.relative(SRC, file).split(path.sep).join('/'),
	text: code(fs.readFileSync(file, 'utf8')),
}));

const filesWhere = (test: (text: string) => boolean): string[] =>
	FILES.filter((file) => test(file.text))
		.map((file) => file.relative)
		.sort();

const importing = (module: string) => (text: string) =>
	new RegExp(`(?:from|import\\()\\s*['"][^'"]*/${module}['"]`).test(text);
const naming = (symbol: string) => (text: string) => new RegExp(`\\b${symbol}\\b`).test(text);

describe('who reaches the continuity digest', () => {
	it('is imported only by the preview and the summarization service', () => {
		expect(filesWhere(importing('contextDigest'))).toEqual([
			'renderer/services/contextSummarizer.ts',
			'shared/continuityPreview.ts',
		]);
	});

	it('has its preview imported only by the service and the explicit hook', () => {
		expect(filesWhere(importing('continuityPreview'))).toEqual([
			'renderer/hooks/agent/useSummarizeAndContinue.ts',
			'renderer/services/contextSummarizer.ts',
		]);
	});

	it('is built through one service method that nothing but the preview calls', () => {
		expect(filesWhere(naming('buildContinuityDigest'))).toEqual([
			'renderer/services/contextSummarizer.ts',
		]);
		expect(filesWhere(naming('buildContextDigest'))).toEqual([
			'renderer/services/contextSummarizer.ts',
			'shared/contextDigest.ts',
			'shared/continuityPreview.ts',
		]);
	});

	it('is previewed only by the explicit action and the remote request that runs it', () => {
		expect(filesWhere(naming('previewContinuity'))).toEqual([
			// App hands the hook's function to the remote-request listener.
			'renderer/App.tsx',
			'renderer/hooks/agent/useSummarizeAndContinue.ts',
			'renderer/services/contextSummarizer.ts',
			// `maestro-cli tab continuity`'s renderer end.
			'renderer/services/tabContextOps.ts',
		]);
		expect(filesWhere(naming('readContinuityHistory'))).toEqual([
			'renderer/hooks/agent/useSummarizeAndContinue.ts',
			'renderer/services/contextSummarizer.ts',
		]);
		expect(filesWhere(naming('planContinuityPreview'))).toEqual([
			'renderer/services/contextSummarizer.ts',
			'shared/continuityPreview.ts',
		]);
	});

	it('is turned into wire text in one place', () => {
		expect(filesWhere(naming('continuityWire'))).toEqual([
			'renderer/hooks/agent/useSummarizeAndContinue.ts',
			'shared/continuityPreview.ts',
		]);
	});

	// The paths where automatic injection would do harm. They are named so that
	// a rename or a move cannot quietly take one out of this check.
	const GUARDED = [
		// Forwarding another tab's or agent's context.
		'renderer/hooks/agent/useMergeTransferHandlers.ts',
		'renderer/hooks/agent/useMergeSession.ts',
		'renderer/hooks/agent/useSendToAgent.ts',
		'renderer/services/crossAgentMentions.ts',
		'renderer/services/crossAgentHandoff.ts',
		'renderer/services/queuedPrompt.ts',
		// Compaction and grooming: they summarize, they do not carry the digest.
		// (The summarization service itself is checked below: it builds the preview too.)
		'renderer/services/contextGroomer.ts',
		'renderer/services/contextCompaction.ts',
		// What a session is started with.
		'shared/maestroSystemPrompt.ts',
		'shared/embeddedSystemPrompt.ts',
		'shared/newSessionMessage.ts',
		'shared/maestro-lib/turns/assemble.ts',
		'shared/maestro-lib/launch/launch-plan.ts',
		'shared/maestro-lib/launch/prompt-delivery.ts',
		'main/utils/system-prompt-delivery.ts',
		'main/utils/maestro-system-prompt.ts',
		'main/utils/context-groomer.ts',
		// Unattended automation.
		'main/cue/cue-executor.ts',
		'main/cue/cue-dispatch-service.ts',
	];

	it.each(GUARDED)('keeps %s free of the digest and the preview', (file) => {
		const found = FILES.find((candidate) => candidate.relative === file);
		expect(found, `${file} must exist, or this guard protects nothing`).toBeDefined();
		const text = found?.text ?? '';
		expect(importing('contextDigest')(text)).toBe(false);
		expect(importing('continuityPreview')(text)).toBe(false);
		expect(/\b(?:previewContinuity|buildContinuityDigest|buildContextDigest)\b/.test(text)).toBe(
			false
		);
	});

	it('keeps the summarization prompt builders from naming the digest', () => {
		const summarizer = FILES.find(
			(file) => file.relative === 'renderer/services/contextSummarizer.ts'
		)?.text;
		expect(summarizer).toBeDefined();
		const builders = [
			...(summarizer ?? '').matchAll(
				/private (?:buildSummarizationPrompt|buildConsolidationPrompt)\([\s\S]*?\n\t\}\n/g
			),
		];
		expect(builders).toHaveLength(2);
		for (const [body] of builders) {
			expect(body).not.toMatch(/digest|continuity|previewContinuity/i);
		}
	});

	it('keeps the main process from building one at all', () => {
		const mainReaders = filesWhere(
			(text) => importing('contextDigest')(text) || importing('continuityPreview')(text)
		).filter((file) => file.startsWith('main/') || file.startsWith('cli/'));
		expect(mainReaders).toEqual([]);
	});
});

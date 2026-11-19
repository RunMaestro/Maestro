import { describe, it, expect } from 'vitest';
import {
	buildFinalSummaryFacts,
	playbookRunReportStatus,
	renderFinalSummaryFactsMarkdown,
	renderPlaybookReportMarkdown,
	type FinalSummaryFactsParams,
	type PlaybookRunReport,
	type PlaybookRunReportStatus,
} from '../../shared/playbookRunReport';
import type { DirectorNotesNarrative } from '../../shared/directorNotesNarrative';

const docs = (...names: string[]) => names.map((filename) => ({ filename }));

const baseParams: FinalSummaryFactsParams = {
	wasStopped: false,
	totalCompletedTasks: 4,
	totalElapsedMs: 125_000,
	stalledDocuments: new Map(),
	documents: docs('01-SETUP.md', '02-BUILD.md'),
	loopEnabled: false,
	loopIteration: 0,
	totalInputTokens: 1200,
	totalOutputTokens: 300,
	totalCost: 0.42,
};

const narrative: DirectorNotesNarrative = {
	version: 1,
	sections: [
		{
			kind: 'accomplishments',
			title: 'Accomplishments',
			items: [{ text: 'Added the release workflow' }],
		},
	],
};

function makeReport(
	status: PlaybookRunReportStatus,
	overrides: Partial<PlaybookRunReport> = {},
	params: Partial<FinalSummaryFactsParams> = {}
): PlaybookRunReport {
	return {
		playbookName: 'Release Pipeline',
		status,
		facts: buildFinalSummaryFacts({ ...baseParams, ...params }),
		parameters: [],
		startedAt: Date.UTC(2026, 10, 19, 10, 0, 0),
		finishedAt: Date.UTC(2026, 10, 19, 10, 2, 5),
		...overrides,
	};
}

function sectionOrder(markdown: string): string[] {
	return markdown
		.split('\n')
		.filter((line) => line.startsWith('## '))
		.map((line) => line.slice(3));
}

describe('buildFinalSummaryFacts', () => {
	it('flattens stalled documents into plain data', () => {
		const facts = buildFinalSummaryFacts({
			...baseParams,
			stalledDocuments: new Map([['02-BUILD.md', 'no progress in 3 runs']]),
		});
		expect(facts.statusText).toBe('completed with stalls');
		expect(facts.stalledDocuments).toEqual([
			{ filename: '02-BUILD.md', reason: 'no progress in 3 runs' },
		]);
		expect(facts.documents).toEqual(['01-SETUP.md', '02-BUILD.md']);
		expect(JSON.parse(JSON.stringify(facts))).toEqual(facts);
	});

	it('counts loops only when looping', () => {
		expect(buildFinalSummaryFacts(baseParams).loopsCompleted).toBe(1);
		expect(
			buildFinalSummaryFacts({ ...baseParams, loopEnabled: true, loopIteration: 2 }).loopsCompleted
		).toBe(3);
	});

	it('renders the summary block without the achievement line', () => {
		const markdown = renderFinalSummaryFactsMarkdown(buildFinalSummaryFacts(baseParams));
		expect(markdown.startsWith('**Auto Run Summary**')).toBe(true);
		expect(markdown).toContain('- **Status:** Completed');
		expect(markdown).not.toContain('Achievement');
		expect(markdown).not.toMatch(/\n\n/);
	});
});

describe('playbookRunReportStatus', () => {
	it('maps every summary status', () => {
		expect(playbookRunReportStatus({ statusText: 'completed' })).toBe('completed');
		expect(playbookRunReportStatus({ statusText: 'completed with stalls' })).toBe('partial');
		expect(playbookRunReportStatus({ statusText: 'stalled' })).toBe('failed');
		expect(playbookRunReportStatus({ statusText: 'stopped' })).toBe('stopped');
	});

	it('treats a halt as a failure unless the user stopped the run', () => {
		expect(playbookRunReportStatus({ statusText: 'completed' }, true)).toBe('failed');
		expect(playbookRunReportStatus({ statusText: 'stopped' }, true)).toBe('stopped');
	});
});

describe('renderPlaybookReportMarkdown', () => {
	it('renders a completed run with every section in order', () => {
		const markdown = renderPlaybookReportMarkdown(
			makeReport('completed', {
				narrative,
				howToUse: 'Run `npm run release` from the repo root.',
				nextSteps: ['Tag the first release', '  '],
				evidence: {
					source: 'git',
					createdFiles: ['.github/workflows/release.yml'],
					changedFiles: ['package.json'],
					deletedFiles: [],
					branch: 'feat/release',
					prUrl: 'https://github.com/acme/app/pull/7',
				},
				parameters: [{ name: 'BRANCH', value: 'main', source: 'you' }],
			})
		);

		expect(markdown.startsWith('# Release Pipeline\n')).toBe(true);
		expect(markdown).toContain('**Status:** Completed · 4 tasks completed');
		expect(sectionOrder(markdown)).toEqual([
			'What was done',
			'How to use it',
			'Next steps',
			'Files changed',
			'Configuration',
		]);
		// The narrative's own sections sit one level under "What was done".
		expect(markdown).toContain('### Accomplishments');
		expect(markdown).toContain('- Added the release workflow');
		expect(markdown).toContain('Run `npm run release` from the repo root.');
		expect(markdown).toContain('- Tag the first release');
		expect(markdown).not.toMatch(/^- \s*$/m);
		expect(markdown).toContain('_From git:');
		expect(markdown).toContain('- **Branch:** `feat/release`');
		expect(markdown).toContain('- **Pull request:** https://github.com/acme/app/pull/7');
		expect(markdown).toContain('**Created** (1)');
		expect(markdown).toContain('- `.github/workflows/release.yml`');
		expect(markdown).not.toContain('**Deleted**');
		expect(markdown).toContain('| BRANCH | main | you |');
		expect(markdown).not.toContain('What did not happen');
		expect(markdown).toContain('Duration: 2m 5s');
		expect(markdown).toContain('Tokens: 1,500 (1,200 in / 300 out)');
		expect(markdown).toContain('Cost: $0.42');
		expect(markdown.endsWith('\n')).toBe(true);
	});

	it('renders the facts as "What was done" when there is no narrative', () => {
		const markdown = renderPlaybookReportMarkdown(
			makeReport('completed', {}, { loopEnabled: true, loopIteration: 1 })
		);
		expect(sectionOrder(markdown)).toEqual(['What was done']);
		expect(markdown).toContain('- **Tasks completed:** 4');
		expect(markdown).toContain('- **Documents:** `01-SETUP.md`, `02-BUILD.md`');
		expect(markdown).toContain('- **Loops completed:** 2');
	});

	it('puts "What did not happen" above the narrative on a partial run', () => {
		const markdown = renderPlaybookReportMarkdown(
			makeReport(
				'partial',
				{ narrative },
				{ stalledDocuments: new Map([['02-BUILD.md', 'no progress in 3 runs']]) }
			)
		);
		expect(markdown).toContain(
			'**Status:** Partially completed · 4 tasks completed · Completed with 1 stalled document(s)'
		);
		expect(sectionOrder(markdown)).toEqual(['What did not happen', 'What was done']);
		expect(markdown).toContain('- `02-BUILD.md`: no progress in 3 runs');
	});

	it('renders a failed run with its stalls first and no stall sentence on a halt', () => {
		const stalled = renderPlaybookReportMarkdown(
			makeReport(
				'failed',
				{},
				{
					stalledDocuments: new Map([
						['01-SETUP.md', 'blocked'],
						['02-BUILD.md', 'blocked'],
					]),
				}
			)
		);
		expect(stalled).toContain('**Status:** Failed');
		expect(stalled).toContain('Stalled - All 2 document(s) stopped making progress');
		expect(sectionOrder(stalled)[0]).toBe('What did not happen');

		const halted = renderPlaybookReportMarkdown(makeReport('failed'));
		expect(halted).toContain('**Status:** Failed · 4 tasks completed\n');
		expect(halted).toContain('The run ended before every task was finished.');
		expect(sectionOrder(halted)).toEqual(['What did not happen', 'What was done']);
	});

	it('renders a stopped run without a failure card', () => {
		const markdown = renderPlaybookReportMarkdown(
			makeReport(
				'stopped',
				{
					evidence: {
						source: 'mtime',
						createdFiles: [],
						changedFiles: [],
						deletedFiles: [],
					},
				},
				{
					wasStopped: true,
					totalCompletedTasks: 1,
					totalInputTokens: 0,
					totalOutputTokens: 0,
					totalCost: 0,
				}
			)
		);
		expect(markdown).toContain('**Status:** Stopped · 1 task completed\n');
		expect(sectionOrder(markdown)).toEqual(['What was done', 'Files changed']);
		expect(markdown).toContain('_From file modification times:');
		expect(markdown).toContain('No file changes were detected.');
		expect(markdown).not.toContain('Tokens:');
		expect(markdown).toContain('Cost: $0.00');
	});

	it('keeps table cells and inline code intact', () => {
		const markdown = renderPlaybookReportMarkdown(
			makeReport('completed', {
				parameters: [
					{ name: 'PATTERN', value: 'a|b\nc', source: 'detected' },
					{ name: 'EMPTY', value: '', source: 'unresolved' },
				],
				evidence: {
					source: 'git',
					createdFiles: ['odd`name.md'],
					changedFiles: [],
					deletedFiles: [],
				},
			})
		);
		expect(markdown).toContain('| PATTERN | a\\|b c | detected |');
		expect(markdown).toContain('| EMPTY | _empty_ | unresolved |');
		expect(markdown).toContain('- `` odd`name.md ``');
	});
});

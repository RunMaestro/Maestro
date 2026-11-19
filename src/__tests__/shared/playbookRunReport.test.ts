import { describe, it, expect } from 'vitest';
import {
	buildFinalSummaryFacts,
	buildPlaybookRunReport,
	buildPlaybookRunReportProblems,
	playbookReportFooterParts,
	playbookReportSections,
	playbookRunReportStatus,
	renderFinalSummaryFactsMarkdown,
	renderPlaybookReportMarkdown,
	stripLeadingPlaybookReport,
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
			'**Status:** Partially completed · 4 tasks completed · 1 stalled document'
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
		expect(stalled).toContain('**Status:** Failed · 4 tasks completed · 2 stalled documents');
		expect(stalled).not.toContain('Completed with');
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

describe('playbookReportSections', () => {
	const STATUSES: PlaybookRunReportStatus[] = ['completed', 'partial', 'failed', 'stopped'];

	it.each(STATUSES)('joins into exactly the rendered document (%s)', (status) => {
		const report = makeReport(
			status,
			{
				narrative,
				howToUse: 'Run `npm run release`.',
				nextSteps: ['Tag the release'],
				evidence: {
					source: 'git',
					changedFiles: ['src/a.ts'],
					createdFiles: [],
					deletedFiles: [],
				},
				parameters: [{ name: 'BRANCH', value: 'main', source: 'default' }],
			},
			status === 'partial' || status === 'failed'
				? { stalledDocuments: new Map([['02-BUILD.md', 'No progress']]) }
				: {}
		);
		const s = playbookReportSections(report);
		const joined =
			[
				s.title,
				s.whatDidNotHappen,
				s.whatWasDone,
				s.howToUse,
				s.nextSteps,
				s.filesChanged,
				s.configuration,
				s.footer,
			]
				.filter(Boolean)
				.join('\n\n') + '\n';
		expect(joined).toBe(renderPlaybookReportMarkdown(report));
	});

	it("drops the narrative's Next Steps only when the report has its own", () => {
		const withSteps: DirectorNotesNarrative = {
			version: 1,
			sections: [
				...narrative.sections,
				{ kind: 'nextSteps', title: 'Next Steps', items: [{ text: 'Re-run verify' }] },
			],
		};
		const own = playbookReportSections(
			makeReport('completed', { narrative: withSteps, nextSteps: ['Re-run verify'] })
		);
		expect(own.whatWasDone).toContain('Added the release workflow');
		expect(own.whatWasDone).not.toContain('Next Steps');
		expect(own.nextSteps).toContain('Re-run verify');

		const none = playbookReportSections(makeReport('completed', { narrative: withSteps }));
		expect(none.whatWasDone).toContain('### Next Steps');
		expect(none.whatWasDone).toContain('Re-run verify');
	});

	it('leaves out the sections with nothing to say', () => {
		const s = playbookReportSections(makeReport('completed'));
		expect(s.whatDidNotHappen).toBeUndefined();
		expect(s.howToUse).toBeUndefined();
		expect(s.nextSteps).toBeUndefined();
		expect(s.filesChanged).toBeUndefined();
		expect(s.configuration).toBeUndefined();
		expect(s.whatWasDone).toMatch(/^## What was done/);
	});

	it('gives the footer facts as plain phrases for the modal', () => {
		const parts = playbookReportFooterParts(makeReport('completed'));
		expect(parts[0]).toMatch(/^Duration: /);
		expect(parts).toContain('Tokens: 1,500 (1,200 in / 300 out)');
		expect(parts.some((part) => part.startsWith('Cost: '))).toBe(true);
		expect(parts.at(-1)).toBe('Finished: 2026-11-19T10:02:05.000Z');
	});
});

describe('buildPlaybookRunReportProblems', () => {
	it('leads with the last error, then each stall at its last recorded task', () => {
		const problems = buildPlaybookRunReportProblems({
			stalledDocuments: [
				{ filename: '01-SETUP.md', reason: 'no progress in 3 runs' },
				{ filename: '02-BUILD.md', reason: 'blocked' },
			],
			failures: [
				{ kind: 'stall', documentFilename: '01-SETUP.md', taskIndex: 1 },
				{ kind: 'error', documentFilename: '02-BUILD.md', taskIndex: 0 },
				{ kind: 'stall', documentFilename: '01-SETUP.md', taskIndex: 2 },
			],
			lastError: {
				kind: 'error',
				document: '02-BUILD.md',
				taskIndex: 0,
				message: 'Context limit reached',
			},
		});
		expect(problems).toEqual([
			{ kind: 'error', document: '02-BUILD.md', taskIndex: 0, message: 'Context limit reached' },
			{ kind: 'stall', document: '01-SETUP.md', taskIndex: 2, message: 'no progress in 3 runs' },
			{ kind: 'stall', document: '02-BUILD.md', message: 'blocked' },
		]);
	});

	it('is empty for a clean run', () => {
		expect(buildPlaybookRunReportProblems({ stalledDocuments: [], lastError: null })).toEqual([]);
	});
});

describe('buildPlaybookRunReport', () => {
	const base = {
		playbookName: 'Release Pipeline',
		parameters: [],
		startedAt: 1,
		finishedAt: 2,
	};

	it('derives the status and keeps only the tiers it was given', () => {
		const report = buildPlaybookRunReport({
			...base,
			playbookId: 'pb-1',
			facts: buildFinalSummaryFacts(baseParams),
			evidence: null,
			authored: {},
			cwd: '/work',
		});
		expect(report).toEqual({
			...base,
			playbookId: 'pb-1',
			status: 'completed',
			facts: buildFinalSummaryFacts(baseParams),
			cwd: '/work',
		});
	});

	it('carries the Exchange source and the Auto Run folder a failure report needs', () => {
		const report = buildPlaybookRunReport({
			...base,
			source: { marketplaceId: 'research-market', sourceVersion: '2026-08-14' },
			autoRunFolderPath: '/autorun',
			facts: buildFinalSummaryFacts(baseParams),
		});
		expect(report.source).toEqual({
			marketplaceId: 'research-market',
			sourceVersion: '2026-08-14',
		});
		expect(report.autoRunFolderPath).toBe('/autorun');
	});

	it('marks a halted run failed and leads its problems with the halt', () => {
		const report = buildPlaybookRunReport({
			...base,
			facts: buildFinalSummaryFacts(baseParams),
			halted: true,
			lastError: { kind: 'halt', document: '02-BUILD.md', taskIndex: 1, message: 'blocked' },
		});
		expect(report.status).toBe('failed');
		expect(report.problems).toEqual([
			{ kind: 'halt', document: '02-BUILD.md', taskIndex: 1, message: 'blocked' },
		]);
	});

	it('makes a run with some stalled documents partial, with each stall located', () => {
		const report = buildPlaybookRunReport({
			...base,
			facts: buildFinalSummaryFacts({
				...baseParams,
				stalledDocuments: new Map([['01-SETUP.md', 'no progress']]),
			}),
			failures: [{ kind: 'stall', documentFilename: '01-SETUP.md', taskIndex: 2 }],
			evidence: { source: 'git', changedFiles: ['a.ts'], createdFiles: [], deletedFiles: [] },
			authored: { narrative, howToUse: 'Run it.', nextSteps: ['Ship'] },
		});
		expect(report).toMatchObject({
			status: 'partial',
			problems: [{ kind: 'stall', document: '01-SETUP.md', taskIndex: 2, message: 'no progress' }],
			evidence: { source: 'git', changedFiles: ['a.ts'] },
			narrative,
			howToUse: 'Run it.',
			nextSteps: ['Ship'],
		});
	});

	it('reports a stopped run as stopped whatever else happened', () => {
		const report = buildPlaybookRunReport({
			...base,
			facts: buildFinalSummaryFacts({ ...baseParams, wasStopped: true }),
			halted: true,
		});
		expect(report.status).toBe('stopped');
	});
});

describe('What did not happen', () => {
	it('names the document and the 1-based task of the error and each stall', () => {
		const report = makeReport(
			'partial',
			{
				narrative,
				problems: [
					{ kind: 'error', document: '02-BUILD.md', taskIndex: 2, message: 'Rate limited' },
					{ kind: 'stall', document: '01-SETUP.md', taskIndex: 0, message: 'no progress' },
				],
			},
			{ stalledDocuments: new Map([['01-SETUP.md', 'no progress']]) }
		);
		const section = playbookReportSections(report).whatDidNotHappen!;
		expect(section).toContain('**The run hit an error** at task 3 of `02-BUILD.md`: Rate limited');
		expect(section).toContain('- task 1 of `01-SETUP.md`: no progress');
		expect(section.indexOf('Rate limited')).toBeLessThan(section.indexOf('no progress'));
		// The card sits above the narrative in the copied document.
		const markdown = renderPlaybookReportMarkdown(report);
		expect(sectionOrder(markdown)).toEqual(['What did not happen', 'What was done']);
	});

	it('says the agent halted the run, and where', () => {
		const section = playbookReportSections(
			makeReport('failed', {
				problems: [
					{ kind: 'halt', document: '02-BUILD.md', taskIndex: 1, message: 'missing credentials' },
				],
			})
		).whatDidNotHappen!;
		expect(section).toContain(
			'**The agent halted the run** at task 2 of `02-BUILD.md`: missing credentials'
		);
		expect(section).not.toContain('The run ended before every task was finished.');
	});

	it('is not rendered for completed or stopped runs, even with problems', () => {
		const problems = [{ kind: 'error' as const, document: 'a.md', taskIndex: 0, message: 'x' }];
		expect(playbookReportSections(makeReport('completed', { problems })).whatDidNotHappen).toBe(
			undefined
		);
		expect(playbookReportSections(makeReport('stopped', { problems })).whatDidNotHappen).toBe(
			undefined
		);
	});
});

describe('stripLeadingPlaybookReport', () => {
	it('returns the History text after the report it leads with', () => {
		const report = makeReport('completed', { narrative });
		const text = `${renderPlaybookReportMarkdown(report).trimEnd()}\n\n**Auto Run Summary**\n- **Status:** Completed`;
		expect(stripLeadingPlaybookReport(text, report)).toBe(
			'**Auto Run Summary**\n- **Status:** Completed'
		);
	});

	it('returns text that does not start with the report whole', () => {
		const report = makeReport('completed');
		expect(stripLeadingPlaybookReport('**Auto Run Summary**', report)).toBe('**Auto Run Summary**');
	});
});

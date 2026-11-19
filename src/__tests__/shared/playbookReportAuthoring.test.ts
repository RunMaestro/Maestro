import { describe, expect, it } from 'vitest';
import {
	PLAYBOOK_REPORTS_DIR,
	buildPlaybookRunReportParameters,
	extractMarkdownSection,
	fillPlaybookReportPrompt,
	formatPlaybookReportFilesChanged,
	formatPlaybookReportRunFacts,
	formatPlaybookReportSynopses,
	latestPlaybookReportJsonName,
	parseMarkdownListItems,
	parsePlaybookReportAnswer,
	parsePlaybookReportSynthesis,
	parsePlaybookRunReportJson,
	playbookReportFileStem,
	playbookReportNarrativeAllowed,
	playbookReportProjectFileName,
	playbookReportRelativePaths,
	playbookReportSlug,
	REPORT_SYNOPSES_MAX,
} from '../../shared/playbookReportAuthoring';
import { buildFinalSummaryFacts } from '../../shared/playbookRunReport';
import { fileTimestampSlug } from '../../shared/formatters';

const NARRATIVE = {
	version: 1,
	sections: [
		{
			kind: 'accomplishments',
			title: 'Accomplishments',
			items: [{ text: 'Installed the bus.' }],
		},
		{ kind: 'challenges', title: 'Challenges', items: [] },
		{ kind: 'nextSteps', title: 'Next Steps', items: [{ text: 'Send a message.' }] },
	],
};

const FENCED_NARRATIVE = '```json\n' + JSON.stringify(NARRATIVE, null, 2) + '\n```';

function facts(overrides: Partial<Parameters<typeof buildFinalSummaryFacts>[0]> = {}) {
	return buildFinalSummaryFacts({
		wasStopped: false,
		totalCompletedTasks: 3,
		totalElapsedMs: 60_000,
		stalledDocuments: new Map(),
		documents: [{ filename: 'pb/one' }, { filename: 'pb/two' }],
		loopEnabled: false,
		loopIteration: 0,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCost: 0,
		...overrides,
	});
}

describe('report file paths', () => {
	it('slugs a playbook name to lowercase ASCII words joined by hyphens', () => {
		expect(playbookReportSlug('Message Bus: Setup (v2)')).toBe('message-bus-setup-v2');
		expect(playbookReportSlug('  Café Déjà Vu  ')).toBe('cafe-deja-vu');
	});

	it('falls back to "playbook" when nothing usable is left', () => {
		expect(playbookReportSlug('!!!')).toBe('playbook');
		expect(playbookReportSlug('')).toBe('playbook');
	});

	it('caps the slug without leaving a trailing hyphen', () => {
		const slug = playbookReportSlug(`${'a'.repeat(59)} tail`);
		expect(slug.length).toBeLessThanOrEqual(60);
		expect(slug.endsWith('-')).toBe(false);
	});

	it('names both files <slug>-<timestamp> under .maestro-reports', () => {
		const finishedAt = new Date(2026, 10, 19, 8, 5, 9).getTime();
		expect(playbookReportFileStem('Message Bus', finishedAt)).toBe(
			`message-bus-${fileTimestampSlug(finishedAt)}`
		);
		expect(playbookReportRelativePaths('Message Bus', finishedAt)).toEqual({
			json: `${PLAYBOOK_REPORTS_DIR}/message-bus-20261119-080509.json`,
			markdown: `${PLAYBOOK_REPORTS_DIR}/message-bus-20261119-080509.md`,
		});
	});
});

describe('playbookReportNarrativeAllowed', () => {
	it('narrates completed and partial runs only', () => {
		expect(playbookReportNarrativeAllowed('completed')).toBe(true);
		expect(playbookReportNarrativeAllowed('partial')).toBe(true);
		expect(playbookReportNarrativeAllowed('failed')).toBe(false);
		expect(playbookReportNarrativeAllowed('stopped')).toBe(false);
	});
});

describe('extractMarkdownSection', () => {
	const doc = [
		'# Report',
		'',
		'## How to use it',
		'',
		'Run `bus send hi`.',
		'',
		'### Troubleshooting',
		'Check the log.',
		'',
		'## Next steps',
		'- One',
	].join('\n');

	it('returns the body up to the next heading of the same level, sub-headings included', () => {
		expect(extractMarkdownSection(doc, 'How to use it')).toBe(
			'Run `bus send hi`.\n\n### Troubleshooting\nCheck the log.'
		);
	});

	it('matches the heading at any level, ignoring case, emphasis, and a trailing colon', () => {
		expect(extractMarkdownSection('### **NEXT STEPS:**\n- a', 'Next steps')).toBe('- a');
	});

	it('runs to the end of the text for the last section', () => {
		expect(extractMarkdownSection(doc, 'Next steps')).toBe('- One');
	});

	it('ignores a heading inside a code fence', () => {
		const fenced = '```md\n## How to use it\nnot this\n```\n\n## How to use it\nthis';
		expect(extractMarkdownSection(fenced, 'How to use it')).toBe('this');
	});

	it('keeps a fenced block inside the section', () => {
		const text =
			'## How to use it\n\n```bash\n# not a heading\nbus send\n```\n\n## Next steps\n- x';
		expect(extractMarkdownSection(text, 'How to use it')).toBe(
			'```bash\n# not a heading\nbus send\n```'
		);
	});

	it('is undefined for a missing heading or an empty section', () => {
		expect(extractMarkdownSection(doc, 'Missing')).toBeUndefined();
		expect(extractMarkdownSection('## How to use it\n\n## Next steps\n- a', 'How to use it')).toBe(
			undefined
		);
	});
});

describe('parseMarkdownListItems', () => {
	it('reads bullets, numbers, and checkboxes, joining continuation lines', () => {
		expect(
			parseMarkdownListItems('- First\n  still first\n* Second\n1. Third\n- [ ] Fourth')
		).toEqual(['First still first', 'Second', 'Third', 'Fourth']);
	});

	it('folds nested items into their parent', () => {
		expect(parseMarkdownListItems('- Parent\n  - child\n- Next')).toEqual([
			'Parent - child',
			'Next',
		]);
	});

	it('treats a section with no list as one item', () => {
		expect(parseMarkdownListItems('Just do the thing.')).toEqual(['Just do the thing.']);
		expect(parseMarkdownListItems('   ')).toEqual([]);
	});
});

describe('parsePlaybookReportAnswer', () => {
	it('reads the narrative, How to use it, and Next steps', () => {
		const raw = [
			'Here is the report.',
			'',
			FENCED_NARRATIVE,
			'',
			'## How to use it',
			'',
			'Run `bus send hello` from `scripts/`.',
			'',
			'## Next steps',
			'',
			'- Send a first message.',
			'- If the scanner does not fire, restart Cue.',
		].join('\n');
		const parts = parsePlaybookReportAnswer(raw);
		expect(parts.narrative).toEqual(NARRATIVE);
		expect(parts.howToUse).toBe('Run `bus send hello` from `scripts/`.');
		expect(parts.nextSteps).toEqual([
			'Send a first message.',
			'If the scanner does not fire, restart Cue.',
		]);
	});

	it('does not mistake a JSON example in How to use it for the narrative', () => {
		const raw = [
			'## How to use it',
			'',
			'Send this payload:',
			'```json',
			'{ "to": "agent", "body": "hi" }',
			'```',
		].join('\n');
		const parts = parsePlaybookReportAnswer(raw);
		expect(parts.narrative).toBeUndefined();
		expect(parts.howToUse).toContain('"body": "hi"');
	});

	it('still finds a narrative written after the authored sections', () => {
		const raw = ['## How to use it', '', 'Use it.', '', FENCED_NARRATIVE].join('\n');
		expect(parsePlaybookReportAnswer(raw).narrative).toEqual(NARRATIVE);
	});

	it('leaves out every part it cannot read, and never throws', () => {
		expect(parsePlaybookReportAnswer('')).toEqual({});
		expect(parsePlaybookReportAnswer('Nothing structured here.')).toEqual({});
		expect(parsePlaybookReportAnswer(undefined as unknown as string)).toEqual({});
		expect(parsePlaybookReportAnswer('{"version": 2, "sections": []}')).toEqual({});
	});

	it('handles CRLF line endings', () => {
		const raw = '## How to use it\r\n\r\nUse it.\r\n\r\n## Next steps\r\n- Go\r\n';
		expect(parsePlaybookReportAnswer(raw)).toEqual({ howToUse: 'Use it.', nextSteps: ['Go'] });
	});
});

describe('parsePlaybookReportSynthesis', () => {
	it('reads a bare or fenced narrative', () => {
		expect(parsePlaybookReportSynthesis(JSON.stringify(NARRATIVE))).toEqual(NARRATIVE);
		expect(parsePlaybookReportSynthesis(FENCED_NARRATIVE)).toEqual(NARRATIVE);
	});

	it('is undefined for prose or an empty narrative', () => {
		expect(parsePlaybookReportSynthesis('All done!')).toBeUndefined();
		expect(parsePlaybookReportSynthesis('{"version": 1, "sections": []}')).toBeUndefined();
	});
});

describe('prompt building', () => {
	it('fills known tokens once and leaves unknown ones', () => {
		expect(
			fillPlaybookReportPrompt('{{PLAYBOOK_NAME}} / {{AGENT_NAME}} / {{REPORT_DOCUMENT}}', {
				PLAYBOOK_NAME: 'Bus',
				REPORT_DOCUMENT: 'Mentions {{PLAYBOOK_NAME}} literally',
			})
		).toBe('Bus / {{AGENT_NAME}} / Mentions {{PLAYBOOK_NAME}} literally');
	});

	it('lists synopses oldest first, marks failures, and flattens newlines', () => {
		expect(
			formatPlaybookReportSynopses([
				{ document: 'pb/one', summary: 'Did a\nthing', success: true },
				{ document: 'pb/two', summary: '  ', success: true },
				{ document: 'pb/two', summary: 'Broke', success: false },
			])
		).toBe('- [pb/one] Did a thing\n- [pb/two] (failed) Broke');
	});

	it('keeps the newest synopses over the cap and says how many were left out', () => {
		const synopses = Array.from({ length: REPORT_SYNOPSES_MAX + 2 }, (_, i) => ({
			document: 'pb/one',
			summary: `Task ${i}`,
			success: true,
		}));
		const lines = formatPlaybookReportSynopses(synopses).split('\n');
		expect(lines[0]).toBe('(The first 2 synopses are left out.)');
		expect(lines[1]).toBe('- [pb/one] Task 2');
		expect(lines).toHaveLength(REPORT_SYNOPSES_MAX + 1);
	});

	it('says when there are no synopses', () => {
		expect(formatPlaybookReportSynopses([])).toBe('(No task reported a synopsis.)');
	});

	it('lists the run facts with stalled documents', () => {
		const text = formatPlaybookReportRunFacts(
			'partial',
			facts({ stalledDocuments: new Map([['pb/two', 'No progress']]) })
		);
		expect(text).toContain('- Status: Partially completed');
		expect(text).toContain('- Tasks completed: 3');
		expect(text).toContain('- Documents: pb/one, pb/two');
		expect(text).toContain('- Stalled: pb/two (No progress)');
	});

	it('lists changed files with the branch and pull request first', () => {
		expect(
			formatPlaybookReportFilesChanged({
				source: 'git',
				createdFiles: ['a.ts'],
				changedFiles: ['b.ts'],
				deletedFiles: ['c.ts'],
				branch: 'feat/x',
				prUrl: 'https://github.com/o/r/pull/1',
			})
		).toBe(
			[
				'- pull request: https://github.com/o/r/pull/1',
				'- branch: feat/x',
				'- created: a.ts',
				'- changed: b.ts',
				'- deleted: c.ts',
			].join('\n')
		);
	});

	it('says when no evidence was recorded or nothing changed', () => {
		expect(formatPlaybookReportFilesChanged(undefined)).toBe('(Not recorded for this run.)');
		expect(
			formatPlaybookReportFilesChanged({
				source: 'mtime',
				createdFiles: [],
				changedFiles: [],
				deletedFiles: [],
			})
		).toBe('(No file changes were detected.)');
	});

	it('caps the file list', () => {
		const createdFiles = Array.from({ length: 105 }, (_, i) => `f${i}.ts`);
		const text = formatPlaybookReportFilesChanged({
			source: 'git',
			createdFiles,
			changedFiles: [],
			deletedFiles: [],
		});
		expect(text.split('\n')).toHaveLength(101);
		expect(text.endsWith('- (5 more files)')).toBe(true);
	});
});

describe('buildPlaybookRunReportParameters', () => {
	it('lists each spec with its resolved value and provenance', () => {
		expect(
			buildPlaybookRunReportParameters({
				specs: [
					{ name: 'PR_URL', type: 'url', required: true, source: 'prose' },
					{ name: 'MAX_ITEMS', type: 'number', required: false, default: '5', source: 'prose' },
					{ name: 'NOTES', type: 'string', required: false, source: 'prose' },
				],
				values: { PR_URL: ' https://github.com/o/r/pull/1 ' },
			})
		).toEqual([
			{ name: 'PR_URL', value: 'https://github.com/o/r/pull/1', source: 'you' },
			{ name: 'MAX_ITEMS', value: '5', source: 'default' },
			{ name: 'NOTES', value: '', source: 'unresolved' },
		]);
	});

	it('is empty for an ad-hoc run', () => {
		expect(buildPlaybookRunReportParameters(undefined)).toEqual([]);
	});
});

describe('playbookReportProjectFileName', () => {
	it('names the project copy <slug>-REPORT-<timestamp>.md', () => {
		const savedAt = new Date(2026, 10, 19, 14, 3, 7).getTime();
		expect(playbookReportProjectFileName('Message Bus', savedAt)).toBe(
			'message-bus-REPORT-20261119-140307.md'
		);
	});
});

describe('latestPlaybookReportJsonName', () => {
	it('picks the newest JSON by the timestamp in its name, not by its slug', () => {
		expect(
			latestPlaybookReportJsonName([
				'zebra-20261118-090000.json',
				'alpha-20261119-080000.json',
				'alpha-20261119-080000.md',
				'zebra-20261120-070000.md',
			])
		).toBe('alpha-20261119-080000.json');
	});

	it('ignores names that are not saved reports', () => {
		expect(latestPlaybookReportJsonName(['notes.json', 'readme.md'])).toBeUndefined();
		expect(latestPlaybookReportJsonName([])).toBeUndefined();
	});
});

describe('parsePlaybookRunReportJson', () => {
	const report = {
		playbookName: 'Message Bus',
		status: 'partial',
		facts: facts(),
		parameters: [],
		startedAt: 1,
		finishedAt: 2,
	};

	it('reads a saved report back', () => {
		expect(parsePlaybookRunReportJson(JSON.stringify(report))).toEqual(report);
	});

	it('refuses text that is not a report', () => {
		expect(parsePlaybookRunReportJson('not json')).toBeUndefined();
		expect(parsePlaybookRunReportJson('null')).toBeUndefined();
		expect(
			parsePlaybookRunReportJson(JSON.stringify({ ...report, status: 'exploded' }))
		).toBeUndefined();
		expect(
			parsePlaybookRunReportJson(JSON.stringify({ ...report, facts: { documents: [] } }))
		).toBeUndefined();
		const { parameters: _parameters, ...noParameters } = report;
		expect(parsePlaybookRunReportJson(JSON.stringify(noParameters))).toBeUndefined();
	});
});

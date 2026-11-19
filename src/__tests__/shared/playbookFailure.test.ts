import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
	MAESTRO_APP_REPO,
	PLAYBOOK_CONTENT_REPO,
	PLAYBOOK_FAILURE_FINGERPRINT_MARKER,
	buildPlaybookFailureIssue,
	buildPlaybookFailureRecurrenceComment,
	describePlaybookFailureParameters,
	isPlaybookFailureKind,
	playbookFailureFingerprintComment,
	playbookFailureFromRunReport,
	playbookFailureFingerprint,
	playbookFailureKindForAgentError,
	pristineSourceRelativePath,
	routePlaybookFailure,
	taskLineAtIndex,
	type PlaybookFailureKind,
	type PlaybookFailureReport,
} from '../../shared/playbookFailure';
import type { PlaybookRunReport } from '../../shared/playbookRunReport';

const coords = {
	playbookId: 'research-market',
	sourceVersion: '2026-08-14',
	documentFilename: '3_EVALUATE.md',
	taskIndex: 2,
	kind: 'stall' as PlaybookFailureKind,
};

const PRISTINE = [
	'# Evaluate',
	'',
	'- [ ] Read [PR_URL] and list the files.',
	'',
	'```markdown',
	'- [ ] An example task inside a fence, not a task.',
	'```',
	'',
	'- [x] Summarize the change.',
	'- [ ] Score each finding against [MAX_ITEMS].',
].join('\n');

function report(overrides: Partial<PlaybookFailureReport> = {}): PlaybookFailureReport {
	return {
		...coords,
		agentProvider: 'claude-code',
		appVersion: '1.2.3',
		parameters: [
			{ name: 'PR_URL', value: 'https://github.com/acme/secret-repo/pull/7', provenance: 'you' },
			{ name: 'MAX_ITEMS', value: '10', provenance: 'default' },
		],
		...overrides,
	};
}

describe('playbookFailureFingerprint', () => {
	it('is 16 lowercase hex characters', () => {
		expect(playbookFailureFingerprint(coords)).toMatch(/^[0-9a-f]{16}$/);
	});

	it('is a fixed value for fixed coordinates, so every install produces the same one', () => {
		// Pinned: changing the serialization splits every existing bucket on the server.
		const expected = createHash('sha256')
			.update(
				'{"documentFilename":"3_EVALUATE","kind":"stall","playbookId":"research-market","sourceVersion":"2026-08-14","taskIndex":2}'
			)
			.digest('hex')
			.slice(0, 16);
		expect(playbookFailureFingerprint(coords)).toBe(expected);
		expect(playbookFailureFingerprint({ ...coords })).toBe(playbookFailureFingerprint(coords));
	});

	it('ignores a trailing .md so the desktop and the CLI agree', () => {
		expect(playbookFailureFingerprint({ ...coords, documentFilename: '3_EVALUATE' })).toBe(
			playbookFailureFingerprint(coords)
		);
	});

	it('changes with every coordinate', () => {
		const base = playbookFailureFingerprint(coords);
		expect(playbookFailureFingerprint({ ...coords, playbookId: 'other' })).not.toBe(base);
		expect(playbookFailureFingerprint({ ...coords, sourceVersion: '2026-09-01' })).not.toBe(base);
		expect(playbookFailureFingerprint({ ...coords, documentFilename: '4_FIX.md' })).not.toBe(base);
		expect(playbookFailureFingerprint({ ...coords, taskIndex: 3 })).not.toBe(base);
		expect(playbookFailureFingerprint({ ...coords, kind: 'halt' })).not.toBe(base);
	});

	it('treats a missing version as an empty one', () => {
		expect(playbookFailureFingerprint({ ...coords, sourceVersion: undefined })).toBe(
			playbookFailureFingerprint({ ...coords, sourceVersion: '' })
		);
	});
});

describe('routePlaybookFailure', () => {
	it.each<[PlaybookFailureKind, string]>([
		['stall', PLAYBOOK_CONTENT_REPO],
		['error', PLAYBOOK_CONTENT_REPO],
		['halt', PLAYBOOK_CONTENT_REPO],
		['watchdog', MAESTRO_APP_REPO],
		['auth', MAESTRO_APP_REPO],
		['spawn', MAESTRO_APP_REPO],
	])('routes %s to %s', (kind, repo) => {
		expect(routePlaybookFailure({ kind })).toBe(repo);
	});

	it('names the two repos', () => {
		expect(PLAYBOOK_CONTENT_REPO).toBe('RunMaestro/Maestro-Playbooks');
		expect(MAESTRO_APP_REPO).toBe('RunMaestro/Maestro');
	});
});

describe('playbookFailureKindForAgentError', () => {
	it('classifies the watchdog, auth, and spawn failures as app failures', () => {
		expect(playbookFailureKindForAgentError({ type: 'unknown', source: 'host-supervision' })).toBe(
			'watchdog'
		);
		expect(playbookFailureKindForAgentError({ type: 'auth_expired' })).toBe('auth');
		expect(playbookFailureKindForAgentError({ type: 'agent_not_installed' })).toBe('spawn');
	});

	it('classifies any other agent error as a plain error', () => {
		expect(playbookFailureKindForAgentError({ type: 'rate_limited' })).toBe('error');
		expect(playbookFailureKindForAgentError({ type: 'token_exhaustion' })).toBe('error');
	});
});

describe('taskLineAtIndex', () => {
	it('counts checked and unchecked tasks and skips fenced examples', () => {
		expect(taskLineAtIndex(PRISTINE, 0)).toBe('- [ ] Read [PR_URL] and list the files.');
		expect(taskLineAtIndex(PRISTINE, 1)).toBe('- [x] Summarize the change.');
		expect(taskLineAtIndex(PRISTINE, 2)).toBe('- [ ] Score each finding against [MAX_ITEMS].');
	});

	it('returns null past the end or for a bad index', () => {
		expect(taskLineAtIndex(PRISTINE, 3)).toBeNull();
		expect(taskLineAtIndex(PRISTINE, -1)).toBeNull();
		expect(taskLineAtIndex(PRISTINE, 1.5)).toBeNull();
	});
});

describe('pristineSourceRelativePath', () => {
	it('points into the pristine source folder with one .md', () => {
		expect(pristineSourceRelativePath('3_EVALUATE.md')).toBe(
			'.maestro-playbook/source/3_EVALUATE.md'
		);
		expect(pristineSourceRelativePath('3_EVALUATE')).toBe('.maestro-playbook/source/3_EVALUATE.md');
	});
});

describe('describePlaybookFailureParameters', () => {
	it('sends the shape of a value, never the value', () => {
		const lines = describePlaybookFailureParameters([
			{ name: 'PR_URL', value: 'https://github.com/acme/secret-repo/pull/7', provenance: 'you' },
			{ name: 'MAX_ITEMS', value: '10', provenance: 'default' },
			{ name: 'COVERAGE_TARGET', value: '80', provenance: 'detected' },
			{ name: 'OUTPUT_FOLDER', value: '/Users/someone/private', provenance: 'you' },
			{ name: 'WIN_FOLDER', value: 'C:\\work\\client', provenance: 'you' },
			{ name: 'HOME_FOLDER', value: '~/notes', provenance: 'you' },
			{ name: 'MARKET_TOPIC', value: 'robotic lawnmowers', provenance: 'you' },
			{ name: 'CORPUS_SOURCE', provenance: 'unresolved' },
		]);
		expect(lines).toEqual([
			'- `PR_URL`: set (url)',
			'- `MAX_ITEMS`: default',
			'- `COVERAGE_TARGET`: set (number)',
			'- `OUTPUT_FOLDER`: set (path, withheld)',
			'- `WIN_FOLDER`: set (path, withheld)',
			'- `HOME_FOLDER`: set (path, withheld)',
			'- `MARKET_TOPIC`: set (18 chars)',
			'- `CORPUS_SOURCE`: unset',
		]);
		const joined = lines.join('\n');
		for (const leak of ['acme', 'secret-repo', '/Users/someone', 'client', 'notes', 'lawnmowers']) {
			expect(joined).not.toContain(leak);
		}
	});

	it('leaves a secret-looking name out entirely', () => {
		const lines = describePlaybookFailureParameters([
			{ name: 'API_TOKEN', value: 'sk-abc', provenance: 'you' },
			{ name: 'GITHUB_KEY', provenance: 'default' },
			{ name: 'DB_PASSWORD', provenance: 'unresolved' },
			{ name: 'TOPIC', value: 'x', provenance: 'you' },
		]);
		expect(lines).toEqual(['- `TOPIC`: set (1 chars)']);
	});
});

describe('buildPlaybookFailureIssue', () => {
	it('builds the title, routes the repo, and embeds the fingerprint as an HTML comment', () => {
		const issue = buildPlaybookFailureIssue(report(), { pristineSource: PRISTINE });
		expect(issue.repo).toBe(PLAYBOOK_CONTENT_REPO);
		expect(issue.fingerprint).toBe(playbookFailureFingerprint(coords));
		expect(issue.title).toBe('Playbook research-market: stalled at 3_EVALUATE.md task 3');
		expect(issue.body).toContain(
			`<!-- ${PLAYBOOK_FAILURE_FINGERPRINT_MARKER}: ${issue.fingerprint} -->`
		);
		expect(issue.body.trimEnd().endsWith('-->')).toBe(true);
	});

	it('carries the playbook, version, document, task, kind, provider, and app version', () => {
		const { body } = buildPlaybookFailureIssue(report(), { pristineSource: PRISTINE });
		expect(body).toContain('| Playbook | `research-market` |');
		expect(body).toContain('| Version | `2026-08-14` |');
		expect(body).toContain('| Document | `3_EVALUATE.md` |');
		expect(body).toContain('| Task | 3 (index 2) |');
		expect(body).toContain('| Failure | Stalled: the task made no progress |');
		expect(body).toContain('| Agent provider | claude-code |');
		expect(body).toContain('| Maestro version | 1.2.3 |');
	});

	it('quotes the pristine task line, with its parameter tokens unexpanded', () => {
		const { body } = buildPlaybookFailureIssue(report(), { pristineSource: PRISTINE });
		expect(body).toContain('```markdown\n- [ ] Score each finding against [MAX_ITEMS].\n```');
	});

	it('says the task is unavailable rather than reading another copy', () => {
		const { body } = buildPlaybookFailureIssue(report());
		expect(body).toContain('_The shipped copy of this task was not available._');
		expect(body).not.toContain('```markdown');
	});

	it('lengthens the fence when the task line holds backticks', () => {
		const { body } = buildPlaybookFailureIssue(report({ taskIndex: 0 }), {
			pristineSource: '- [ ] Run ```npm test``` first',
		});
		expect(body).toContain('````markdown\n- [ ] Run ```npm test``` first\n````');
	});

	it('sends parameter shapes and never a value, a path, or a secret name', () => {
		const { body } = buildPlaybookFailureIssue(
			report({
				parameters: [
					{
						name: 'PR_URL',
						value: 'https://github.com/acme/secret-repo/pull/7',
						provenance: 'you',
					},
					{ name: 'MAX_ITEMS', value: '10', provenance: 'default' },
					{ name: 'GH_TOKEN', value: 'ghp_live', provenance: 'you' },
					{ name: 'TARGET_BRANCH', value: 'feature/acme-launch', provenance: 'you' },
				],
			}),
			{ pristineSource: PRISTINE }
		);
		expect(body).toContain('- `PR_URL`: set (url)');
		expect(body).toContain('- `MAX_ITEMS`: default');
		expect(body).toContain('- `TARGET_BRANCH`: set (19 chars)');
		for (const leak of ['acme', 'secret-repo', 'GH_TOKEN', 'ghp_live', 'feature/']) {
			expect(body).not.toContain(leak);
		}
	});

	it('omits the parameter section when nothing is left to show', () => {
		const { body } = buildPlaybookFailureIssue(
			report({ parameters: [{ name: 'API_KEY', value: 'x', provenance: 'you' }] })
		);
		expect(body).not.toContain('### Configured parameters');
	});

	it('routes an app failure to the app repo', () => {
		const issue = buildPlaybookFailureIssue(report({ kind: 'watchdog' }));
		expect(issue.repo).toBe(MAESTRO_APP_REPO);
		expect(issue.title).toBe('Playbook research-market: timed out at 3_EVALUATE.md task 3');
	});

	it('marks a missing version as unknown', () => {
		const { body } = buildPlaybookFailureIssue(report({ sourceVersion: undefined }));
		expect(body).toContain('| Version | unknown |');
	});
});

describe('fingerprint search surface', () => {
	it('shows the fingerprint in the table, so issue search can find it', () => {
		const issue = buildPlaybookFailureIssue(report());
		expect(issue.body).toContain(`| Fingerprint | \`${issue.fingerprint}\` |`);
	});

	it('ends the body with the fingerprint comment', () => {
		const issue = buildPlaybookFailureIssue(report());
		expect(issue.body.endsWith(playbookFailureFingerprintComment(issue.fingerprint))).toBe(true);
	});
});

describe('buildPlaybookFailureRecurrenceComment', () => {
	it('names the version and provider, and carries the fingerprint', () => {
		expect(
			buildPlaybookFailureRecurrenceComment(
				{ appVersion: '1.4.0', agentProvider: 'codex' },
				'0123456789abcdef'
			)
		).toBe(
			`Also hit on Maestro 1.4.0 with codex.\n\n<!-- ${PLAYBOOK_FAILURE_FINGERPRINT_MARKER}: 0123456789abcdef -->`
		);
	});

	it('says unknown rather than leaving a blank', () => {
		expect(
			buildPlaybookFailureRecurrenceComment({ appVersion: '', agentProvider: '' }, 'ff')
		).toContain('Also hit on Maestro an unknown version with an unknown provider.');
	});
});

describe('isPlaybookFailureKind', () => {
	it.each(['stall', 'error', 'halt', 'watchdog', 'auth', 'spawn'])('accepts %s', (kind) => {
		expect(isPlaybookFailureKind(kind)).toBe(true);
	});

	it.each(['stopped', '', 3, null, undefined])('refuses %s', (kind) => {
		expect(isPlaybookFailureKind(kind)).toBe(false);
	});
});

describe('playbookFailureFromRunReport', () => {
	type RunReportInput = Pick<PlaybookRunReport, 'status' | 'source' | 'problems' | 'parameters'>;
	const runReport = (overrides: Partial<RunReportInput> = {}): RunReportInput => ({
		status: 'partial',
		source: { marketplaceId: 'research-market', sourceVersion: '2026-08-14' },
		problems: [
			{ kind: 'stall', document: 'research-market/3_EVALUATE', taskIndex: 2, message: 'stuck' },
		],
		parameters: [{ name: 'MAX_ITEMS', value: '10', source: 'default' }],
		...overrides,
	});

	it('locates the failure by shipped filename and points at the pristine copy', () => {
		expect(playbookFailureFromRunReport(runReport(), 'claude-code')).toEqual({
			report: {
				playbookId: 'research-market',
				sourceVersion: '2026-08-14',
				documentFilename: '3_EVALUATE',
				taskIndex: 2,
				kind: 'stall',
				agentProvider: 'claude-code',
				parameters: [{ name: 'MAX_ITEMS', value: '10', provenance: 'default' }],
			},
			pristineDocumentPath: 'research-market/.maestro-playbook/source/3_EVALUATE.md',
		});
	});

	it('produces the same fingerprint as the runner coordinates', () => {
		const draft = playbookFailureFromRunReport(runReport(), 'claude-code')!;
		expect(playbookFailureFingerprint(draft.report)).toBe(playbookFailureFingerprint(coords));
	});

	it('handles a document at the top of the Auto Run folder', () => {
		const draft = playbookFailureFromRunReport(
			runReport({ problems: [{ kind: 'halt', document: 'PLAN.md', taskIndex: 0, message: 'x' }] }),
			'codex'
		);
		expect(draft?.pristineDocumentPath).toBe('.maestro-playbook/source/PLAN.md');
		expect(draft?.report.documentFilename).toBe('PLAN');
	});

	it('files the app failure class the agent error carried', () => {
		const draft = playbookFailureFromRunReport(
			runReport({
				problems: [
					{
						kind: 'error',
						document: 'research-market/3_EVALUATE',
						taskIndex: 1,
						message: 'login expired',
						failureKind: 'auth',
					},
				],
			}),
			'claude-code'
		);
		expect(draft?.report.kind).toBe('auth');
		expect(routePlaybookFailure(draft!.report)).toBe(MAESTRO_APP_REPO);
	});

	it('skips problems with no task and reports the first located one', () => {
		const draft = playbookFailureFromRunReport(
			runReport({
				problems: [
					{ kind: 'stall', document: 'research-market/1_PLAN', message: 'no task' },
					{ kind: 'stall', document: 'research-market/2_RUN', taskIndex: 4, message: 'x' },
				],
			}),
			'claude-code'
		);
		expect(draft?.report.documentFilename).toBe('2_RUN');
		expect(draft?.report.taskIndex).toBe(4);
	});

	it.each([
		['a completed run', { status: 'completed' as const }],
		['a stopped run', { status: 'stopped' as const }],
		['a local playbook', { source: undefined }],
		['a run with no located problem', { problems: [] }],
	])('returns null for %s', (_label, overrides) => {
		expect(playbookFailureFromRunReport(runReport(overrides), 'claude-code')).toBeNull();
	});
});

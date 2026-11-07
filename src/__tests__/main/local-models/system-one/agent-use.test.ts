/**
 * @file agent-use.test.ts
 *
 * The rules that read a System One agent run (`helpers/systemOneAgentTask.ts`):
 * the list and its labels, what an agent's answer file says, how it scores, and
 * what Claude Code's JSON stream says the agent did with System One. The opt-in
 * suite that runs a real agent (`agent-use-e2e.test.ts`) records these readings
 * and `docs/architecture/local-models.md` reports them, so a misread here would
 * report an agent as keying its items when it asked about places in a list, or
 * as ignoring System One when it used it.
 *
 * The commands are cut down from real runs against Claude Opus 5.5.
 *
 * It also holds the one rule of the test CLI bridge that must never fail: it
 * does not write the discovery file into the live app's folder.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

import { startCliBridge } from '../../../helpers/cliBridge';
import {
	SECURITY_TASK_DEFAULT_ITEMS,
	readClaudeRun,
	readSecurityAnswer,
	readSystemOneUse,
	scoreSecurityAnswer,
	securityTaskCommits,
	securityTaskInput,
	securityTaskLabels,
	securityTaskPrompt,
} from '../../../helpers/systemOneAgentTask';

const CLI = 'node "/repo/dist/cli/maestro-cli.js"';

const lines = (...events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');

const toolUse = (name: string, input: unknown) => ({
	type: 'assistant',
	message: { content: [{ type: 'tool_use', id: 't', name, input }] },
});
const bash = (command: string) => toolUse('Bash', { command });

describe('the job', () => {
	it('is the playbook wording, with the size of the list it names', () => {
		expect(securityTaskPrompt()).toBe(
			'Here are 40 one-line commit messages in `commits.txt`. Which ones describe a security fix? Write the line numbers to `security.txt`.'
		);
		expect(securityTaskPrompt(400)).toContain('Here are 400 one-line commit messages');
	});

	it('has 40 distinct messages by default, 12 of them security fixes', () => {
		const commits = securityTaskCommits();
		expect(commits).toHaveLength(SECURITY_TASK_DEFAULT_ITEMS);
		expect(commits).toHaveLength(40);
		expect(new Set(commits.map((commit) => commit.message)).size).toBe(40);
		expect(securityTaskLabels(commits)).toEqual([2, 5, 9, 12, 15, 19, 22, 26, 29, 32, 35, 38]);
	});

	it('writes one message a line, so a line number is a key', () => {
		const commits = securityTaskCommits();
		const written = securityTaskInput(commits).split('\n');
		expect(written).toHaveLength(41);
		expect(written[40]).toBe('');
		expect(written[1]).toBe(commits[1].message);
	});

	it('builds a longer list with the labels still known, the same list every time', () => {
		const commits = securityTaskCommits(400);
		expect(commits).toHaveLength(400);
		expect(new Set(commits.map((commit) => commit.message)).size).toBe(400);
		expect(securityTaskLabels(commits)).toHaveLength(120);
		expect(securityTaskCommits(400)).toEqual(commits);
		// Shuffled: the fixes do not sit every 40 lines where the base list has them.
		expect(securityTaskLabels(commits).slice(0, 12)).not.toEqual(
			securityTaskLabels(securityTaskCommits())
		);
		// A label follows its message, whatever area it is filed under.
		for (const commit of commits) {
			const base = securityTaskCommits().find((entry) => commit.message.endsWith(entry.message));
			expect(base?.security, commit.message).toBe(commit.security);
		}
	});

	it('refuses a size the list cannot be built at', () => {
		for (const items of [0, 39, 60, 440, Number.NaN]) {
			expect(() => securityTaskCommits(items), String(items)).toThrow(/not /);
		}
	});
});

describe('readSecurityAnswer', () => {
	it('reads one number a line', () => {
		expect(readSecurityAnswer('2\n5\n9\n')).toEqual([2, 5, 9]);
	});

	it('reads every number on a line that holds only numbers', () => {
		expect(readSecurityAnswer('2, 5, 9\n12 15\n[19]')).toEqual([2, 5, 9, 12, 15, 19]);
	});

	it('reads only the first number of a line with words: the rest belong to the message', () => {
		expect(
			readSecurityAnswer('9: Bump lodash from 4.17.15 to 4.17.21\nLine 12 - redirect_uri')
		).toEqual([9, 12]);
	});

	it('drops numbers outside the list and repeats, and sorts', () => {
		expect(readSecurityAnswer('38\n0\n41\n2\n2\n')).toEqual([2, 38]);
		expect(readSecurityAnswer('399\n41\n', 400)).toEqual([41, 399]);
	});

	it('reads nothing from an empty file', () => {
		expect(readSecurityAnswer('')).toEqual([]);
	});
});

describe('scoreSecurityAnswer', () => {
	const commits = securityTaskCommits();
	const labels = securityTaskLabels(commits);

	it('scores the labels as exact', () => {
		expect(scoreSecurityAnswer(labels, commits)).toMatchObject({
			truePositives: 12,
			falsePositives: [],
			falseNegatives: [],
			precision: 1,
			recall: 1,
			f1: 1,
			accuracy: 1,
			exact: true,
		});
	});

	it('names what was listed wrongly and what was left out', () => {
		// Line 3 is the typo in SECURITY.md; line 38 (reset tokens) is left out.
		const score = scoreSecurityAnswer([...labels.slice(0, 11), 3], commits);
		expect(score.falsePositives).toEqual([3]);
		expect(score.falseNegatives).toEqual([38]);
		expect(score.truePositives).toBe(11);
		expect(score.precision).toBeCloseTo(11 / 12);
		expect(score.recall).toBeCloseTo(11 / 12);
		expect(score.accuracy).toBeCloseTo(38 / 40);
		expect(score.exact).toBe(false);
	});

	it('scores an empty answer as no recall, not as an error', () => {
		expect(scoreSecurityAnswer([], commits)).toMatchObject({
			precision: 1,
			recall: 0,
			f1: 0,
			exact: false,
		});
	});
});

describe('readSystemOneUse', () => {
	it('reads an agent that read the list and judged it itself', () => {
		const use = readSystemOneUse(
			lines(
				toolUse('Read', { file_path: '/tmp/run/on-1/commits.txt' }),
				toolUse('Write', { file_path: '/tmp/run/on-1/security.txt', content: '2\n5\n' })
			)
		);
		expect(use).toMatchObject({
			toolCalls: 2,
			invocations: [],
			verbs: {},
			ranGuide: false,
			guideBeforeFirstAsk: null,
			keying: 'none',
			readList: true,
			usedJevCli: false,
		});
	});

	it('reads a guide that no question followed', () => {
		const use = readSystemOneUse(
			lines(bash(`${CLI} s1 guide`), toolUse('Read', { file_path: 'commits.txt' }))
		);
		expect(use.verbs).toEqual({ guide: 1 });
		expect(use.ranGuide).toBe(true);
		expect(use.guideBeforeFirstAsk).toBeNull();
		expect(use.keying).toBe('none');
	});

	it('reads the guide first, then a keyed rank, with the list never read', () => {
		const use = readSystemOneUse(
			lines(
				bash(`wc -l commits.txt && head -5 commits.txt && ${CLI} s1 guide`),
				bash(
					`${CLI} s1 rank --query "commits that fix a security vulnerability" --candidates-file commits.txt --min 0.3 --json > rank.json; echo "exit $?"`
				),
				bash(`python3 - <<'E'\nimport json\nr=json.load(open('rank.json'))\nE`)
			)
		);
		expect(use.verbs).toEqual({ guide: 1, rank: 1 });
		expect(use.guideBeforeFirstAsk).toBe(true);
		expect(use.keying).toBe('keyed');
		// `wc -l` and `head -5` size the job. They do not put the list in context.
		expect(use.readList).toBe(false);
		expect(use.invocations.map(({ verb }) => verb)).toEqual(['guide', 'rank']);
	});

	it('says when a question came before the guide', () => {
		const use = readSystemOneUse(
			lines(
				bash(`${CLI} s1 batch --input commits.txt --noul sec 'Is this a security fix?'`),
				bash(`${CLI} s1 guide`)
			)
		);
		expect(use.guideBeforeFirstAsk).toBe(false);
		expect(use.keying).toBe('keyed');
	});

	it('reads one item to a request as per-item', () => {
		const use = readSystemOneUse(
			lines(
				bash(
					`while IFS= read -r line; do ${CLI} s1 yes 'Does this commit message describe a security fix?' -s "$line"; done < commits.txt`
				)
			)
		);
		expect(use.verbs).toEqual({ yes: 1 });
		expect(use.keying).toBe('per-item');
		expect(use.readList).toBe(false);
	});

	it('reads a question about a place in the list as indexed', () => {
		expect(
			readSystemOneUse(lines(bash(`${CLI} s1 yes 'Is line 7 a security fix?' -s @commits.txt`)))
				.keying
		).toBe('indexed');
	});

	it('reads the whole list as the state of one question as indexed', () => {
		for (const command of [
			`${CLI} s1 ask --choice which 'Which messages are security fixes?' a b -s @commits.txt`,
			`${CLI} s1 pick 'Which kind?' a b --state-file ./commits.txt`,
			`cat commits.txt | ${CLI} s1 yes 'Are there security fixes here?'`,
		]) {
			expect(readSystemOneUse(lines(bash(command))).keying, command).toBe('indexed');
		}
	});

	it('counts a keyed verb beside an indexed question as indexed', () => {
		const use = readSystemOneUse(
			lines(
				bash(`${CLI} s1 rank --query "security fix" --candidates-file commits.txt`),
				bash(`${CLI} s1 yes 'Is commit 12 a security fix?' -s @commits.txt`)
			)
		);
		expect(use.keying).toBe('indexed');
	});

	it('counts several verbs in one command, in order', () => {
		const use = readSystemOneUse(
			lines(bash(`${CLI} s1 guide; ${CLI} s1 cost @commits.txt && ${CLI} s1 usage`))
		);
		expect(use.invocations.map(({ verb }) => verb)).toEqual(['guide', 'cost', 'usage']);
		expect(use.commands).toHaveLength(1);
	});

	it('reads a command that prints the whole list as reading it', () => {
		expect(readSystemOneUse(lines(bash('cat -n commits.txt'))).readList).toBe(true);
		expect(readSystemOneUse(lines(bash('nl commits.txt | tail -400'))).readList).toBe(true);
		expect(readSystemOneUse(lines(bash('wc -l commits.txt'))).readList).toBe(false);
		expect(readSystemOneUse(lines(bash('grep -c fix commits.txt'))).readList).toBe(false);
	});

	it('tells the standalone jev CLI from System One', () => {
		expect(readSystemOneUse(lines(bash(`jev yes 'Is this a fix?' -s "Fix XSS"`))).usedJevCli).toBe(
			true
		);
		expect(readSystemOneUse(lines(bash(`${CLI} s1 yes 'Is this a fix?' -s x`))).usedJevCli).toBe(
			false
		);
		expect(readSystemOneUse(lines(bash('ls ~/.claude/skills/jev'))).usedJevCli).toBe(false);
	});

	it('skips lines that are not JSON', () => {
		const use = readSystemOneUse(`warning: something\n${lines(bash(`${CLI} s1 guide`))}\n{"type":`);
		expect(use.verbs).toEqual({ guide: 1 });
	});
});

describe('readClaudeRun', () => {
	const init = {
		type: 'system',
		subtype: 'init',
		model: 'claude-opus-5-5',
		skills: ['code-review', 'simplify'],
		mcp_servers: [{ name: 'claude.ai Claude Docs', status: 'connected' }],
	};
	const result = {
		type: 'result',
		subtype: 'success',
		is_error: false,
		num_turns: 4,
		total_cost_usd: 0.2508764,
		result: ' 12 of the 40 commits describe a security fix. ',
		usage: {
			input_tokens: 6,
			output_tokens: 1197,
			cache_read_input_tokens: 80002,
			cache_creation_input_tokens: 26364,
		},
	};

	it("reads the harness's own account of a turn", () => {
		expect(readClaudeRun(lines(init, result))).toEqual({
			model: 'claude-opus-5-5',
			skills: ['code-review', 'simplify'],
			mcpServers: ['claude.ai Claude Docs'],
			turns: 4,
			costUsd: 0.2508764,
			inputTokens: 6,
			outputTokens: 1197,
			cacheReadTokens: 80002,
			cacheWriteTokens: 26364,
			finalMessage: '12 of the 40 commits describe a security fix.',
		});
	});

	it('reports a result that is an error', () => {
		const failed = { ...result, subtype: 'error_max_turns', is_error: true, result: '' };
		expect(readClaudeRun(lines(init, failed)).error).toBe('error_max_turns');
	});

	it('reports a stream with no result', () => {
		expect(readClaudeRun(lines(init)).error).toBe('The stream ended without a result.');
	});
});

describe('startCliBridge', () => {
	const pinned = process.env.MAESTRO_USER_DATA;

	afterEach(() => {
		if (pinned === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = pinned;
	});

	it('refuses to write the discovery file unless the data folder is pinned to the one it was given', async () => {
		const dataDir = path.join(os.tmpdir(), 'cli-bridge-never-created');

		delete process.env.MAESTRO_USER_DATA;
		await expect(startCliBridge(dataDir)).rejects.toThrow(/MAESTRO_USER_DATA must already name/);

		process.env.MAESTRO_USER_DATA = path.join(os.tmpdir(), 'somewhere-else');
		await expect(startCliBridge(dataDir)).rejects.toThrow(/MAESTRO_USER_DATA must already name/);
	});
});

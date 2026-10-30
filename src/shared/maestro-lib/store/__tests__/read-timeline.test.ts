import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTimeline, type ReadTimelineInput } from '../read-timeline';
import { historyFilePath } from '../read-history';
import { journeyFilePath } from '../read-journey';
import {
	computerHistoryDir,
	segmentRelativePath,
	segmentStartMs,
} from '../../../computer-history/paths';

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const MIN = 60_000;
const SHA = 'abc1234def5678abc1234def5678abc1234def56';

function jsonl(entries: unknown[]): string {
	return entries.map((e) => `${JSON.stringify(e)}\n`).join('');
}

describe('readTimeline', () => {
	let dir: string;
	let input: (overrides?: Partial<ReadTimelineInput>) => ReadTimelineInput;

	function write(file: string, content: string): void {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lib-timeline-'));
		const paths = { userDataDir: dir, historyDir: path.join(dir, 'history') };
		input = (overrides = {}) => ({
			paths,
			agents: [{ id: 'agent-1', cwd: '/repo', gitCwd: '/repo' }],
			sources: ['history', 'journey', 'git'],
			sinceMs: NOW - 60 * MIN,
			runGit: async () => `${SHA}\x1f${Math.floor((NOW - 5 * MIN) / 1000)}\x1fAda\x1fShip it\n`,
			now: NOW,
			...overrides,
		});
		write(
			historyFilePath(paths.historyDir, 'agent-1'),
			jsonl([
				{
					id: 'h-old',
					type: 'USER',
					timestamp: NOW - 120 * MIN,
					summary: 'old',
					projectPath: '/repo',
				},
				{
					id: 'h-1',
					type: 'USER',
					timestamp: NOW - 30 * MIN,
					summary: 'fixed it',
					projectPath: '/repo',
				},
			])
		);
		write(
			journeyFilePath(dir, 'agent-1'),
			jsonl([
				{ ts: NOW - 20 * MIN, agentId: 'agent-1', kind: 'file.save', target: '/repo/src/a.ts' },
			])
		);
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('merges history, journey, and git in time order inside the window', async () => {
		const { events, notes } = await readTimeline(input());
		expect(events.map((e) => [e.source, e.text, e.ref])).toEqual([
			['history', 'USER: fixed it', 'h-1'],
			['journey', 'user saved src/a.ts', undefined],
			['git', 'commit by Ada: Ship it', SHA],
		]);
		expect(notes).toEqual([]);
	});

	it('reads only the sources asked for', async () => {
		const runGit = vi.fn(async () => '');
		const { events } = await readTimeline(input({ sources: ['journey'], runGit }));
		expect(events.map((e) => e.source)).toEqual(['journey']);
		expect(runGit).not.toHaveBeenCalled();
	});

	it('runs git once per working directory, and not for an agent without one', async () => {
		const runGit = vi.fn(async () => '');
		await readTimeline(
			input({
				runGit,
				agents: [
					{ id: 'agent-1', cwd: '/repo', gitCwd: '/repo' },
					{ id: 'agent-2', cwd: '/repo', gitCwd: '/repo' },
					{ id: 'ssh-agent', cwd: '/remote/repo' },
				],
			})
		);
		expect(runGit).toHaveBeenCalledTimes(1);
		expect(runGit).toHaveBeenCalledWith('/repo', expect.arrayContaining(['log', '--first-parent']));
	});

	it('reads a refusing git as no commits, and a git that never answered as a note', async () => {
		const refused = await readTimeline(input({ runGit: async () => null }));
		expect(refused.events).toHaveLength(2);
		expect(refused.notes).toEqual([]);

		const throwing = await readTimeline(
			input({
				runGit: async () => {
					throw new Error('ETIMEDOUT');
				},
			})
		);
		expect(throwing.events).toHaveLength(2);
		expect(throwing.notes).toEqual(['git: no commits from /repo (ETIMEDOUT)']);
	});

	it('greps the line text and applies the caps', async () => {
		expect((await readTimeline(input({ grep: /src\/a/ }))).events.map((e) => e.source)).toEqual([
			'journey',
		]);
		expect((await readTimeline(input({ tail: 1 }))).events.map((e) => e.source)).toEqual(['git']);
	});

	it('searches and bounds the window before the read cap, so an older match survives', async () => {
		// 600 journey saves in the window, only the OLDEST of which matches.
		write(
			journeyFilePath(dir, 'agent-1'),
			jsonl(
				Array.from({ length: 600 }, (_, i) => ({
					ts: NOW - 50 * MIN + i,
					agentId: 'agent-1',
					kind: 'file.save',
					target: i === 0 ? '/repo/needle.ts' : `/repo/f${i}.ts`,
				}))
			)
		);
		const searched = await readTimeline(input({ sources: ['journey'], grep: /needle/ }));
		expect(searched.events.map((e) => e.text)).toEqual(['user saved needle.ts']);

		// An --until before the newest 500 still finds the older entries.
		const early = await readTimeline(input({ sources: ['journey'], untilMs: NOW - 50 * MIN + 10 }));
		expect(early.events).toHaveLength(11);
	});

	it('greps commits after reading past the usual cap', async () => {
		const runGit = vi.fn(async (_cwd: string, _args: string[]) => '');
		await readTimeline(input({ sources: ['git'], grep: /x/, runGit }));
		expect(runGit.mock.calls[0][1]).toContain('-n5000');
	});

	describe('Computer History', () => {
		function writeSegment(events: unknown[]): void {
			write(
				path.join(computerHistoryDir(dir), segmentRelativePath(segmentStartMs(NOW - 10 * MIN))),
				jsonl(events)
			);
		}

		const app = (name: string) => ({ id: `com.example.${name}`, name, pid: 1 });

		beforeEach(() => {
			writeSegment([
				{
					v: 1,
					seq: 0,
					ts: new Date(NOW - 10 * MIN).toISOString(),
					kind: 'app.activated',
					app: app('Slack'),
				},
				{
					v: 1,
					seq: 1,
					ts: new Date(NOW - 9 * MIN).toISOString(),
					kind: 'app.activated',
					app: app('Slack'),
				},
				{
					v: 1,
					seq: 2,
					ts: new Date(NOW - 8 * MIN).toISOString(),
					kind: 'text.committed',
					app: app('Slack'),
					text: 'the deploy token is in the vault',
				},
				{
					v: 1,
					seq: 3,
					ts: new Date(NOW - 7 * MIN).toISOString(),
					kind: 'app.activated',
					app: app('Chrome'),
				},
			]);
		});

		it('is read only when the caller says the feature is on', async () => {
			const off = await readTimeline(input({ sources: ['computer'] }));
			expect(off.events).toEqual([]);
			const on = await readTimeline(input({ sources: ['computer'], computerHistory: true }));
			expect(on.events.map((e) => e.text)).toEqual([
				'user switched to Slack',
				'user switched to Chrome',
			]);
		});

		it('searches the full captured text when grepping, not just the quoted start', async () => {
			const { events } = await readTimeline(
				input({ sources: ['computer'], computerHistory: true, grep: /vault/ })
			);
			expect(events.map((e) => e.text)).toEqual([
				'user typed in Slack: "the deploy token is in the vault"',
			]);
		});
	});
});

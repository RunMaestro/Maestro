/**
 * @file dataview.test.ts
 * @description Tests for `maestro-cli dataview` (D8, DV-13): each verb sends the `dataview_command`
 * action the service method behind it expects, the note's agent is resolved on the CLI side, results
 * print as text or as the revived result under `--json`, and DataviewJS blocks, query errors, and bad
 * arguments exit with the documented codes. The trust verbs send the root resolved and normalized the way
 * the app compares roots.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as path from 'path';
import { DateTime } from 'luxon';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
	resolveTargetSessionId: vi.fn((agent: string) => `resolved-${agent}`),
}));

vi.mock('../../../cli/utils/owning-agent', () => ({
	resolveOwningAgent: vi.fn(),
}));

import {
	DATAVIEWJS_DESKTOP_ONLY,
	dataviewEval,
	dataviewIndexRebuild,
	dataviewIndexStatus,
	dataviewQuery,
	dataviewTrust,
	dataviewTrusted,
	dataviewUntrust,
	resolveTrustRoot,
} from '../../../cli/commands/dataview';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveOwningAgent } from '../../../cli/utils/owning-agent';
import { ExitCode } from '../../../cli/exit-codes';
import { Link, toWireValue } from '../../../shared/dataview';
import type { DataviewIndexStatus } from '../../../shared/dataview';
import { encoreDisabledMessage } from '../../../shared/encoreFeatureDefaults';

const NOTE = path.resolve('/vault/People/Pedram Amini.md');

function mockReply(reply: Record<string, unknown>) {
	const sent: Record<string, unknown>[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>, rt: string) => {
				sent.push({ ...payload, responseType: rt });
				return Promise.resolve(reply);
			}),
		} as never)
	);
	return sent;
}

function respond(result: unknown) {
	return mockReply({
		type: 'dataview_result',
		success: true,
		response: {
			root: '/vault',
			sshRemoteId: null,
			revision: 4,
			path: 'People/Pedram Amini.md',
			result,
		},
	});
}

const rami = toWireValue(Link.file('People/Rami Example.md'));
const created = toWireValue(DateTime.fromISO('2026-09-01T00:00:00'));

const TABLE = {
	kind: 'table',
	headers: ['File', 'Company', 'Created'],
	rows: [[rami, 'Example Co', created]],
	idMeaning: { type: 'path' },
	warnings: [],
};

const STATUS: DataviewIndexStatus = {
	root: '/vault',
	sshRemoteId: null,
	pageCount: 12,
	revision: 4,
	lastScanDurationMs: 35,
	lastScanAt: 1,
	cacheHit: true,
	watchMode: 'chokidar',
};

describe('dataview command', () => {
	let exitSpy: MockInstance;
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	const logged = () => logSpy.mock.calls.map((call) => call.join(' ')).join('\n');
	const errors = () => errorSpy.mock.calls.map((call) => call.join(' ')).join('\n');
	const json = () => JSON.parse(String(logSpy.mock.calls[0][0]));

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
		vi.mocked(resolveOwningAgent).mockReturnValue({
			agent: { id: 'agent-1', name: 'Vault' } as never,
			others: [],
		});
	});

	describe('query', () => {
		const blocks = (entries: unknown[], blockCount = entries.length) => ({
			kind: 'blocks',
			blockCount,
			blocks: entries,
		});
		const tableBlock = { language: 'dataview', block: 1, line: 3, source: 'TABLE', result: TABLE };

		it('sends queryFile for the absolute note with its owning agent and prints a table', async () => {
			const sent = respond(blocks([tableBlock]));
			await dataviewQuery(NOTE, {});

			expect(sent[0]).toEqual({
				type: 'dataview_command',
				action: 'queryFile',
				filePath: NOTE,
				agentId: 'agent-1',
				block: undefined,
				responseType: 'dataview_result',
			});
			expect(resolveOwningAgent).toHaveBeenCalledWith(NOTE);
			const out = logged();
			expect(out).toContain('File');
			expect(out).toContain('[[People/Rami Example.md|Rami Example]]');
			expect(out).toContain('Example Co');
			expect(out).toContain('September 01, 2026');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('passes --block and --agent through', async () => {
			const sent = respond(blocks([tableBlock], 2));
			await dataviewQuery('note.md', { block: '2', agent: 'abc' });
			expect(sent[0]).toMatchObject({
				filePath: path.resolve(process.cwd(), 'note.md'),
				agentId: 'resolved-abc',
				block: 2,
			});
			expect(resolveOwningAgent).not.toHaveBeenCalled();
		});

		it('prints the revived result under --json', async () => {
			respond(blocks([tableBlock]));
			await dataviewQuery(NOTE, { json: true });

			const payload = json();
			expect(payload).toMatchObject({
				success: true,
				root: '/vault',
				path: 'People/Pedram Amini.md',
				revision: 4,
				blockCount: 1,
			});
			const row = payload.blocks[0].result.rows[0];
			expect(row[0]).toMatchObject({ path: 'People/Rami Example.md', type: 'file' });
			expect(row[2]).toBe(DateTime.fromISO('2026-09-01T00:00:00').toJSON());
		});

		it('prints the DataviewJS notice and exits 2 for a dataviewjs block', async () => {
			respond(
				blocks(
					[tableBlock, { language: 'dataviewjs', block: null, line: 9, source: 'dv.span(1)' }],
					1
				)
			);
			await expect(dataviewQuery(NOTE, {})).rejects.toThrow('__exit__');

			expect(errors()).toContain(DATAVIEWJS_DESKTOP_ONLY);
			expect(logged()).toContain('DataviewJS block (line 9)');
			expect(logged()).toContain('Block 1 (line 3)');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});

		it('marks the dataviewjs block in --json and exits 2', async () => {
			respond(blocks([{ language: 'dataviewjs', block: null, line: 1, source: 'x' }], 0));
			await expect(dataviewQuery(NOTE, { json: true })).rejects.toThrow('__exit__');

			expect(json()).toMatchObject({
				success: false,
				error: DATAVIEWJS_DESKTOP_ONLY,
				blocks: [{ language: 'dataviewjs', error: DATAVIEWJS_DESKTOP_ONLY }],
			});
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});

		it('prints a query error with its line and exits 1', async () => {
			respond(
				blocks([
					{
						...tableBlock,
						result: { kind: 'error', message: 'Dataview: Error parsing query', line: 2 },
					},
				])
			);
			await expect(dataviewQuery(NOTE, {})).rejects.toThrow('__exit__');

			expect(errors()).toContain('Error: Dataview: Error parsing query (line 2)');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it('prints LIST items, TASK trees, and the CALENDAR notice', async () => {
			const task = (text: string, line: number, status: string, children: unknown[] = []) => ({
				task: true,
				text,
				line,
				status,
				completed: status === 'x',
				path: 'Tasks.md',
				children,
			});
			respond(
				blocks([
					{
						language: 'dataview',
						block: 1,
						line: 1,
						source: 'LIST',
						result: { kind: 'list', items: [rami], idMeaning: { type: 'path' }, warnings: [] },
					},
					{
						language: 'dataview',
						block: 2,
						line: 5,
						source: 'TASK',
						result: {
							kind: 'task',
							groups: [
								{
									key: toWireValue(Link.file('Tasks.md')),
									rows: [task('Ship it', 4, 'x', [task('Write tests', 5, ' ')])],
								},
							],
							idMeaning: { type: 'group', name: 'file.link', on: { type: 'path' } },
							warnings: ['1 row skipped'],
						},
					},
					{
						language: 'dataview',
						block: 3,
						line: 9,
						source: 'CALENDAR file.day',
						result: { kind: 'unsupported', feature: 'CALENDAR' },
					},
				])
			);
			await dataviewQuery(NOTE, {});

			const out = logged();
			expect(out).toContain('- [[People/Rami Example.md|Rami Example]]');
			expect(out).toContain(
				'[[Tasks.md|Tasks]]\n  - [x] Ship it  (Tasks.md:5)\n    - [ ] Write tests  (Tasks.md:6)'
			);
			expect(out).toContain('CALENDAR queries are not supported in Maestro.');
			expect(errors()).toContain('Warning: 1 row skipped');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('says so when the note has no dataview blocks', async () => {
			respond(blocks([]));
			await dataviewQuery(NOTE, {});
			expect(logged()).toBe(`No dataview blocks in ${NOTE}.`);
		});

		it('exits 2 for a block past the last one', async () => {
			respond(blocks([], 2));
			await expect(dataviewQuery(NOTE, { block: '3' })).rejects.toThrow('__exit__');
			expect(errors()).toContain(`${NOTE} has 2 dataview blocks; there is no block 3`);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});

		it('exits 2 for a bad --block without reaching the app', async () => {
			const sent = respond(blocks([]));
			await expect(dataviewQuery(NOTE, { block: '0' })).rejects.toThrow('__exit__');
			expect(errors()).toContain('--block expects a whole number from 1, got "0"');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(sent).toHaveLength(0);
		});

		it('exits 2 when no agent owns the note', async () => {
			vi.mocked(resolveOwningAgent).mockReturnValue(null);
			await expect(dataviewQuery(NOTE, {})).rejects.toThrow('__exit__');
			expect(errors()).toContain('Pick an agent with --agent <id>');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});

		it('exits 1 with the error of a note outside its root or a failed reply', async () => {
			respond({ kind: 'error', message: 'Dataview: /x.md is outside the vault root /vault' });
			await expect(dataviewQuery(NOTE, {})).rejects.toThrow('__exit__');
			expect(errors()).toContain('outside the vault root');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);

			mockReply({
				type: 'dataview_result',
				success: false,
				error: 'Dataview: no agent with id "x"',
			});
			await expect(dataviewQuery(NOTE, { json: true })).rejects.toThrow('__exit__');
			expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
				success: false,
				error: 'Dataview: no agent with id "x"',
			});
		});

		it('reports the app refusing while Dataview is off, with the DATAVIEW_DISABLED code under --json', async () => {
			const off = encoreDisabledMessage('dataview');
			mockReply({ type: 'dataview_result', success: false, error: off });
			await expect(dataviewQuery(NOTE, {})).rejects.toThrow('__exit__');
			expect(errors()).toContain(off);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);

			await expect(dataviewQuery(NOTE, { json: true })).rejects.toThrow('__exit__');
			expect(JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]))).toEqual({
				success: false,
				error: off,
				code: 'DATAVIEW_DISABLED',
			});
		});
	});

	describe('eval', () => {
		it('sends an expression that starts with = as queryInline and prints the value', async () => {
			const sent = respond({ kind: 'value', value: 'Pedram Amini' });
			await dataviewEval(NOTE, '= this.file.name', {});

			expect(sent[0]).toMatchObject({
				action: 'queryInline',
				filePath: NOTE,
				agentId: 'agent-1',
				expression: '= this.file.name',
			});
			expect(logged()).toBe('Pedram Amini');
		});

		it('sends anything else as a query and prints the revived result under --json', async () => {
			const sent = respond(TABLE);
			await dataviewEval(NOTE, 'TABLE Company FROM "People"', { json: true });

			expect(sent[0]).toMatchObject({ action: 'query', source: 'TABLE Company FROM "People"' });
			expect(json()).toMatchObject({
				success: true,
				revision: 4,
				result: { kind: 'table', headers: ['File', 'Company', 'Created'] },
			});
		});

		it('exits 1 on an error result and 2 on empty input', async () => {
			respond({ kind: 'error', message: 'Dataview: bad' });
			await expect(dataviewEval(NOTE, 'LIST FROM', {})).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenLastCalledWith(ExitCode.GeneralError);

			await expect(dataviewEval(NOTE, '   ', {})).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenLastCalledWith(ExitCode.InvalidUsage);
		});
	});

	describe('index', () => {
		function respondStatus(response: unknown) {
			return mockReply({ type: 'dataview_result', success: true, response });
		}

		it('status lists every open root', async () => {
			const sent = respondStatus([STATUS]);
			await dataviewIndexStatus(undefined, {});

			expect(sent[0]).toEqual({
				type: 'dataview_command',
				action: 'status',
				responseType: 'dataview_result',
			});
			const out = logged();
			expect(out).toContain('ROOT');
			expect(out).toMatch(/\/vault\s+12\s+4\s+chokidar\s+hit\s+35 ms/);
		});

		it('status of one root resolves the path and names the agent', async () => {
			const sent = respondStatus([]);
			await dataviewIndexStatus('vault', { agent: 'abc' });

			const root = path.resolve(process.cwd(), 'vault');
			expect(sent[0]).toMatchObject({ root, agentId: 'resolved-abc' });
			expect(logged()).toContain(`${root} is not indexed.`);
		});

		it('status --json prints the indexes', async () => {
			respondStatus([STATUS]);
			await dataviewIndexStatus(undefined, { json: true });
			expect(json()).toEqual({ success: true, indexes: [STATUS] });
		});

		it('rebuild sends the absolute root and reports the new scan', async () => {
			const sent = respondStatus(STATUS);
			await dataviewIndexRebuild('/vault', {});

			expect(sent[0]).toMatchObject({ action: 'rebuild', root: path.resolve('/vault') });
			expect(logged()).toBe('Rebuilt /vault: 12 pages in 35 ms.');

			logSpy.mockClear();
			respondStatus(STATUS);
			await dataviewIndexRebuild('/vault', { json: true });
			expect(json()).toEqual({ success: true, index: STATUS });
		});
	});
	describe('trust', () => {
		const VAULT = path.resolve('/vault');

		function respondTrust(response: unknown) {
			return mockReply({ type: 'dataview_result', success: true, response });
		}

		it('resolves a root against the cwd and normalizes it like the app', () => {
			expect(resolveTrustRoot('vault')).toBe(path.resolve(process.cwd(), 'vault'));
			expect(resolveTrustRoot('  /vault/  ')).toBe(VAULT);
			expect(resolveTrustRoot('/vault/sub/..')).toBe(VAULT);
		});

		it('trust sends the absolute root and reports the change', async () => {
			const sent = respondTrust({ root: VAULT, trusted: true, changed: true, roots: [VAULT] });
			await dataviewTrust('/vault/', {});

			expect(sent[0]).toEqual({
				type: 'dataview_command',
				action: 'trust',
				root: VAULT,
				responseType: 'dataview_result',
			});
			expect(logged()).toBe(`Trusted ${VAULT}. Its DataviewJS blocks run without asking.`);

			logSpy.mockClear();
			respondTrust({ root: VAULT, trusted: true, changed: false, roots: [VAULT] });
			await dataviewTrust('/vault', {});
			expect(logged()).toBe(`${VAULT} is already trusted.`);
		});

		it('trust --json prints the whole answer', async () => {
			const response = { root: VAULT, trusted: true, changed: true, roots: [VAULT] };
			respondTrust(response);
			await dataviewTrust('/vault', { json: true });
			expect(json()).toEqual({ success: true, ...response });
		});

		it('untrust sends the root and reports whether it was trusted', async () => {
			const sent = respondTrust({ root: VAULT, trusted: false, changed: true, roots: [] });
			await dataviewUntrust('/vault', {});

			expect(sent[0]).toMatchObject({ action: 'untrust', root: VAULT });
			expect(logged()).toBe(
				`Stopped trusting ${VAULT}. Its DataviewJS blocks ask before they run.`
			);

			logSpy.mockClear();
			respondTrust({ root: VAULT, trusted: false, changed: false, roots: [] });
			await dataviewUntrust('/vault', { json: true });
			expect(json()).toEqual({
				success: true,
				root: VAULT,
				trusted: false,
				changed: false,
				roots: [],
			});
		});

		it('trusted lists one root per line, or says none is trusted', async () => {
			const sent = respondTrust(['/vault', '/notes']);
			await dataviewTrusted({});
			expect(sent[0]).toEqual({
				type: 'dataview_command',
				action: 'trusted',
				responseType: 'dataview_result',
			});
			expect(logged()).toBe('/vault\n/notes');

			logSpy.mockClear();
			respondTrust([]);
			await dataviewTrusted({});
			expect(logged()).toBe('No vault is trusted. DataviewJS blocks ask before they run.');

			logSpy.mockClear();
			respondTrust(['/vault']);
			await dataviewTrusted({ json: true });
			expect(json()).toEqual({ success: true, roots: ['/vault'] });
		});

		it('exits 1 with the error the app answered', async () => {
			mockReply({
				type: 'dataview_result',
				success: false,
				error: 'Dataview: root must be an absolute path',
			});
			await expect(dataviewTrust('/vault', {})).rejects.toThrow('__exit__');
			expect(errors()).toContain('Dataview: root must be an absolute path');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it('carries the disabled code when the app reads the feature as off', async () => {
			mockReply({
				type: 'dataview_result',
				success: false,
				error: encoreDisabledMessage('dataview'),
			});
			await expect(dataviewTrusted({ json: true })).rejects.toThrow('__exit__');
			expect(json()).toMatchObject({ success: false, code: 'DATAVIEW_DISABLED' });
		});
	});
});

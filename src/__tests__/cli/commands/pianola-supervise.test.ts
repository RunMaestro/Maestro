/**
 * @file pianola-supervise.test.ts
 * @description Tests for the Pianola supervise CLI registration commands. Uses a
 * temp MAESTRO_USER_DATA dir (with the Encore flag enabled on disk) so the real
 * supervisor store is exercised end to end.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	pianolaSuperviseWatch,
	pianolaSuperviseProgram,
	pianolaSuperviseOrchestrate,
} from '../../../cli/commands/pianola-supervise';
import { pianolaProgramLoop } from '../../../cli/commands/pianola-program-loop';
import { pianolaProgramStatus } from '../../../cli/commands/pianola-portfolio';
import {
	readPianolaSupervisorTargets,
	upsertPianolaProgram,
	upsertPianolaPlan,
	writePianolaProgramLoopMemo,
	readPianolaDecisions,
} from '../../../cli/services/pianola-store';

const { sendCommand, dispatch } = vi.hoisted(() => ({ sendCommand: vi.fn(), dispatch: vi.fn() }));
vi.mock('../../../cli/services/maestro-client', () => ({
	MaestroClient: class {
		connect = vi.fn();
		disconnect = vi.fn();
		sendCommand = sendCommand;
	},
}));
vi.mock('../../../cli/commands/dispatch', () => ({ runDispatch: dispatch }));
vi.mock('../../../cli/services/prompt-loader', () => ({
	_getBundledPromptCandidatesForTests: (relative: string) => [
		path.resolve(__dirname, '../../../prompts', relative),
	],
}));

let tmpDir: string;
let prevEnv: string | undefined;
let logSpy: MockInstance;
let exitSpy: MockInstance;

function lastTargetId(): string {
	const calls = logSpy.mock.calls as unknown[][];
	const payload = JSON.parse(String(calls[calls.length - 1][0])) as { target: { id: string } };
	return payload.target.id;
}

beforeEach(() => {
	prevEnv = process.env.MAESTRO_USER_DATA;
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pianola-supervise-'));
	process.env.MAESTRO_USER_DATA = tmpDir;
	// Enable the Encore flag on disk so ensurePianolaEnabled passes.
	fs.writeFileSync(
		path.join(tmpDir, 'maestro-settings.json'),
		JSON.stringify({ encoreFeatures: { pianola: true } }),
		'utf-8'
	);
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => {
	if (prevEnv === undefined) delete process.env.MAESTRO_USER_DATA;
	else process.env.MAESTRO_USER_DATA = prevEnv;
	fs.rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('pianolaSuperviseWatch dedupe', () => {
	it('reuses orchestration registration for the same plan', () => {
		pianolaSuperviseOrchestrate('plan', { json: true });
		const firstId = lastTargetId();
		pianolaSuperviseOrchestrate('plan', { concurrency: '4', json: true });
		expect(readPianolaSupervisorTargets()).toEqual([
			expect.objectContaining({ id: firstId, planId: 'plan', concurrency: 4 }),
		]);
	});
	it('reuses the existing target id when re-registering the same tab + agent', () => {
		pianolaSuperviseWatch('tab-1', { agent: 'agent-1', json: true });
		const firstId = lastTargetId();

		pianolaSuperviseWatch('tab-1', { agent: 'agent-1', interval: '9', json: true });
		const secondId = lastTargetId();

		const targets = readPianolaSupervisorTargets();
		expect(targets).toHaveLength(1);
		expect(secondId).toBe(firstId);
		// The replace-in-place updated the refreshed config.
		expect(targets[0].intervalSeconds).toBe(9);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('keeps separate targets for a different tab or agent', () => {
		pianolaSuperviseWatch('tab-1', { agent: 'agent-1', json: true });
		pianolaSuperviseWatch('tab-2', { agent: 'agent-1', json: true });
		pianolaSuperviseWatch('tab-1', { agent: 'agent-2', json: true });

		const targets = readPianolaSupervisorTargets();
		expect(targets).toHaveLength(3);
	});
});
describe('pianolaSuperviseProgram', () => {
	it('reuses a program target while updating the interval', () => {
		pianolaSuperviseProgram('product', { json: true });
		const firstId = lastTargetId();
		pianolaSuperviseProgram('product', { interval: '180', json: true });
		expect(readPianolaSupervisorTargets()).toEqual([
			expect.objectContaining({
				id: firstId,
				kind: 'program',
				programId: 'product',
				intervalSeconds: 180,
			}),
		]);
		pianolaSuperviseProgram('other', { json: true });
		expect(readPianolaSupervisorTargets()).toHaveLength(2);
	});
});

describe('program-loop target registration', () => {
	const program = {
		id: 'product',
		title: 'Product',
		root: 'C:\\product',
		leadAgentId: 'lead',
		roles: { lead: { name: 'Lead', agentId: 'lead' } },
		charter: { maxConcurrent: 1, maxAttempts: 2, validationRequired: true },
		status: 'active' as const,
		createdAt: 1,
		updatedAt: 1,
	};
	it('does not mistake inherited Object properties for a saved program memo', async () => {
		upsertPianolaProgram({ ...program, id: 'constructor' });
		sendCommand.mockResolvedValue({ sessions: [] });
		dispatch.mockResolvedValueOnce({ success: true, tabId: 'fresh-tab' });
		await expect(
			pianolaProgramLoop('constructor', { once: true, json: true })
		).resolves.toBeUndefined();
	});
	it('writes no decisions or targets on an idle-backoff tick', async () => {
		upsertPianolaProgram(program);
		writePianolaProgramLoopMemo({
			product: { notifiedTaskIds: [], lastWakeAt: new Date().toISOString() },
		});
		sendCommand.mockResolvedValue({ sessions: [] });
		dispatch.mockClear();
		await pianolaProgramLoop('product', { once: true, json: true });
		expect(dispatch).not.toHaveBeenCalled();
		expect(readPianolaSupervisorTargets()).toEqual([]);
		expect(readPianolaDecisions()).toEqual([]);
		expect(fs.readdirSync(tmpDir).sort()).toEqual([
			'maestro-pianola-program-loop.json',
			'maestro-pianola-programs.json',
			'maestro-settings.json',
		]);
	});
	it('updates the same watch target to the second wake tab', async () => {
		upsertPianolaProgram(program);
		sendCommand.mockResolvedValue({
			sessions: [{ agentId: 'lead', tabId: 'old-tab', state: 'idle' }],
		});
		dispatch.mockResolvedValueOnce({ success: true, tabId: 'first-tab' });
		await pianolaProgramLoop('product', { once: true, json: true });
		const first = readPianolaSupervisorTargets()[0];
		expect(first).toMatchObject({
			kind: 'watch',
			agentId: 'lead',
			tabId: 'first-tab',
			enabled: true,
		});
		writePianolaProgramLoopMemo({
			product: { notifiedTaskIds: [], lastWakeAt: '2026-01-01T00:00:00.000Z' },
		});
		dispatch.mockResolvedValueOnce({ success: true, tabId: 'second-tab' });
		await pianolaProgramLoop('product', { once: true, json: true });
		expect(readPianolaSupervisorTargets()).toEqual([{ ...first, tabId: 'second-tab' }]);
	});
	it('does not register orchestration when the program is paused during session lookup', async () => {
		upsertPianolaProgram(program);
		upsertPianolaPlan({
			id: 'plan',
			programId: 'product',
			title: 'Plan',
			createdAt: 1,
			tasks: [{ id: 'task', title: 'Task', prompt: 'Work', dependsOn: [], status: 'pending' }],
		});
		sendCommand.mockImplementationOnce(async () => {
			pianolaProgramStatus('product', 'paused', { json: true });
			return { sessions: [{ agentId: 'lead', tabId: 'tab', state: 'idle' }] };
		});
		await pianolaProgramLoop('product', { once: true, json: true });
		expect(readPianolaSupervisorTargets()).toEqual([]);
	});
	it('does not re-enable a lead watch when paused during a wake', async () => {
		upsertPianolaProgram(program);
		pianolaSuperviseWatch('old-tab', { agent: 'lead', json: true });
		sendCommand.mockResolvedValue({
			sessions: [{ agentId: 'lead', tabId: 'old-tab', state: 'idle' }],
		});
		dispatch.mockImplementationOnce(async () => {
			pianolaProgramStatus('product', 'paused', { json: true });
			return { success: true, tabId: 'new-tab' };
		});
		await pianolaProgramLoop('product', { once: true, json: true });
		expect(readPianolaSupervisorTargets()).toEqual([
			expect.objectContaining({ tabId: 'old-tab', enabled: true }),
		]);
	});
});

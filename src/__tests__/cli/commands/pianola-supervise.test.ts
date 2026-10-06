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
import { pianolaSuperviseWatch } from '../../../cli/commands/pianola-supervise';
import { readPianolaSupervisorTargets } from '../../../cli/services/pianola-store';

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

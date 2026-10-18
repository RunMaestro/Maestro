/**
 * `isSessionBusyInDesktop` reads the desktop's agent store from Maestro's data
 * directory as `resolveUserDataDir()` resolves it.
 *
 * It used to hard-code the lowercase `maestro` folder and ignore
 * MAESTRO_USER_DATA, so in dev and on a case-sensitive packaged install it read
 * a file that did not exist and always answered "not busy".
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isSessionBusyInDesktop } from '../../../cli/services/agent-busy';

function writeSessions(dir: string, sessions: Array<Record<string, unknown>>): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, 'maestro-sessions.json'), JSON.stringify({ sessions }));
}

describe('isSessionBusyInDesktop', () => {
	let root: string;
	let savedUserData: string | undefined;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-agent-busy-'));
		savedUserData = process.env.MAESTRO_USER_DATA;
	});

	afterEach(() => {
		if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = savedUserData;
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('reads the agent store from MAESTRO_USER_DATA', () => {
		const dataDir = path.join(root, 'maestro-dev');
		writeSessions(dataDir, [{ id: 'agent-1', state: 'busy' }]);
		// A store in the old hard-coded spelling must not be the one consulted.
		writeSessions(path.join(root, 'maestro'), [{ id: 'agent-1', state: 'idle' }]);
		process.env.MAESTRO_USER_DATA = dataDir;

		expect(isSessionBusyInDesktop('agent-1')).toEqual({
			busy: true,
			reason: 'Desktop app shows agent is busy',
		});
	});

	it('answers not busy for an idle or unknown agent', () => {
		const dataDir = path.join(root, 'data');
		writeSessions(dataDir, [{ id: 'agent-1', state: 'idle' }]);
		process.env.MAESTRO_USER_DATA = dataDir;

		expect(isSessionBusyInDesktop('agent-1')).toEqual({ busy: false });
		expect(isSessionBusyInDesktop('agent-2')).toEqual({ busy: false });
	});

	it('answers not busy when the store is missing or unreadable', () => {
		process.env.MAESTRO_USER_DATA = path.join(root, 'absent');
		expect(isSessionBusyInDesktop('agent-1')).toEqual({ busy: false });

		const corrupt = path.join(root, 'corrupt');
		fs.mkdirSync(corrupt);
		fs.writeFileSync(path.join(corrupt, 'maestro-sessions.json'), '{ not json');
		process.env.MAESTRO_USER_DATA = corrupt;
		expect(isSessionBusyInDesktop('agent-1')).toEqual({ busy: false });
	});
});

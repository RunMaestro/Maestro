/**
 * @file steering-relay.test.ts
 * @description Parity F1: `maestro-p --steer-relay <socket>` delivers one steering
 * request, read from stdin, to a turn's socket on the same host, and prints the
 * started line and the verdict. Also the early-mode parse that keeps both the relay
 * and the capabilities probe away from claude, and the home-relative socket path.
 * Real sockets, under a temp "home".
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	formatVersionWithCapabilities,
	parseMaestroPEarlyMode,
	runSteeringRelay,
} from '../../maestro-p/steering-relay';
import {
	ensureSteeringSocketDir,
	startSteeringServer,
	sweepStaleSteeringSockets,
} from '../../maestro-p/steering-server';
import { expandTilde } from '../../shared/pathUtils';
import { isWindows as isWindowsPlatform } from '../../shared/platformDetection';
import {
	MAESTRO_P_CAPABILITIES_FLAG,
	parseMaestroPCapabilities,
	STEERING_RELAY_CAPABILITY,
	STEERING_RELAY_FLAG,
	STEERING_RELAY_STARTED_LINE,
} from '../../shared/chatSteering';

const isWindows = isWindowsPlatform();
const homes: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
	while (closers.length) closers.pop()!();
	while (homes.length) fs.rmSync(homes.pop()!, { recursive: true, force: true });
});

function tempHome(): string {
	// Short, so the socket path stays under the ~104 byte unix socket limit.
	const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mph-'));
	homes.push(home);
	return home;
}

describe('parseMaestroPEarlyMode', () => {
	it('recognizes the relay only as the leading flag, with its socket', () => {
		expect(parseMaestroPEarlyMode([STEERING_RELAY_FLAG, '~/.maestro/steer/x.sock'])).toEqual({
			kind: 'steer-relay',
			socketSpec: '~/.maestro/steer/x.sock',
		});
		expect(parseMaestroPEarlyMode([STEERING_RELAY_FLAG])).toMatchObject({ kind: 'usage-error' });
		// A flag of the same name further along a claude command line is claude's business.
		expect(parseMaestroPEarlyMode(['-p', 'hi', STEERING_RELAY_FLAG, 'x'])).toBeNull();
	});

	it('recognizes the capabilities probe, and leaves a plain turn alone', () => {
		expect(parseMaestroPEarlyMode(['--version', MAESTRO_P_CAPABILITIES_FLAG])).toEqual({
			kind: 'capabilities',
		});
		expect(parseMaestroPEarlyMode([MAESTRO_P_CAPABILITIES_FLAG])).toEqual({
			kind: 'capabilities',
		});
		expect(parseMaestroPEarlyMode(['--version'])).toBeNull();
		expect(parseMaestroPEarlyMode(['-p', '--output-format', 'stream-json'])).toBeNull();
	});
});

describe('capabilities line', () => {
	it('advertises the steering relay after the version, and parses back', () => {
		const output = formatVersionWithCapabilities('1.2.3');
		expect(output.split('\n')[0]).toBe('1.2.3');
		expect(parseMaestroPCapabilities(output)).toContain(STEERING_RELAY_CAPABILITY);
	});

	it('reads an older maestro-p (version only) as having no capabilities', () => {
		expect(parseMaestroPCapabilities('0.16.20-RC\n')).toEqual([]);
	});
});

describe.skipIf(isWindows)('ensureSteeringSocketDir', () => {
	const steerDir = (home: string) => path.join(home, '.maestro', 'steer');

	it('creates the remote steering folder owner-only', () => {
		const home = tempHome();
		expect(ensureSteeringSocketDir('~/.maestro/steer/a.sock', () => {}, home)).toBe(true);
		expect(fs.statSync(steerDir(home)).mode & 0o777).toBe(0o700);
	});

	it('tightens an existing folder others could write to', () => {
		const home = tempHome();
		fs.mkdirSync(steerDir(home), { recursive: true });
		fs.chmodSync(steerDir(home), 0o777);
		expect(ensureSteeringSocketDir('~/.maestro/steer/a.sock', () => {}, home)).toBe(true);
		expect(fs.statSync(steerDir(home)).mode & 0o777).toBe(0o700);
	});

	it('refuses a folder that is a symlink, so the turn runs un-steerable', () => {
		const home = tempHome();
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mpx-'));
		homes.push(elsewhere);
		fs.mkdirSync(path.join(home, '.maestro'), { recursive: true });
		fs.symlinkSync(elsewhere, steerDir(home));
		const warnings: string[] = [];
		expect(ensureSteeringSocketDir('~/.maestro/steer/a.sock', (m) => warnings.push(m), home)).toBe(
			false
		);
		expect(warnings[0]).toContain('cannot be steered');
	});

	it('leaves an absolute (local) socket path alone', () => {
		expect(ensureSteeringSocketDir('/nonexistent/dir/a.sock', () => {})).toBe(true);
		expect(expandTilde('/tmp/a.sock', '/home/u')).toBe('/tmp/a.sock');
	});
});

describe.skipIf(isWindows)('sweepStaleSteeringSockets', () => {
	it('removes sockets nothing answers on and keeps live ones and its own', async () => {
		const dir = path.join(tempHome(), 'steer');
		fs.mkdirSync(dir);
		const stale = path.join(dir, 'maestro-steer-aaaa-0001.sock');
		const own = path.join(dir, 'maestro-steer-bbbb-0002.sock');
		const live = path.join(dir, 'maestro-steer-cccc-0003.sock');
		const unrelated = path.join(dir, 'notes.txt');
		fs.writeFileSync(stale, '');
		fs.writeFileSync(own, '');
		fs.writeFileSync(unrelated, '');
		const server = net.createServer();
		await new Promise<void>((resolve) => server.listen(live, resolve));
		closers.push(() => server.close());

		const removed = await new Promise<string[]>((resolve) =>
			sweepStaleSteeringSockets(dir, own, resolve)
		);
		expect(removed).toEqual([stale]);
		expect(fs.existsSync(own)).toBe(true);
		expect(fs.existsSync(live)).toBe(true);
		expect(fs.existsSync(unrelated)).toBe(true);
	});
});

describe.skipIf(isWindows)('runSteeringRelay', () => {
	it('delivers the frame from stdin to the turn socket and prints started then the verdict', async () => {
		const home = tempHome();
		const spec = '~/.maestro/steer/t.sock';
		expect(ensureSteeringSocketDir(spec, () => {}, home)).toBe(true);
		const received: Array<{ id: string; text: string }> = [];
		const server = startSteeringServer({
			socketPath: expandTilde(spec, home),
			onSteer: async (id, text) => {
				received.push({ id, text });
				return { type: 'steering', id, verdict: 'delivered' };
			},
			warn: () => {},
		});
		expect(server).not.toBeNull();
		closers.push(() => server!.close());
		await new Promise((resolve) => setTimeout(resolve, 50));

		const lines: string[] = [];
		const code = await runSteeringRelay({
			socketSpec: spec,
			stdinText: `${JSON.stringify({ type: 'steer', id: 'r1', text: 'change course' })}\n`,
			writeLine: (line) => lines.push(line),
			home,
			timeoutMs: 2_000,
		});
		expect(code).toBe(0);
		expect(received).toEqual([{ id: 'r1', text: 'change course' }]);
		expect(lines[0]).toBe(STEERING_RELAY_STARTED_LINE);
		expect(JSON.parse(lines[1])).toEqual({ type: 'steering', id: 'r1', verdict: 'delivered' });
	});

	it('refuses with not-running when no turn listens on the socket', async () => {
		const home = tempHome();
		const lines: string[] = [];
		const code = await runSteeringRelay({
			socketSpec: '~/.maestro/steer/none.sock',
			stdinText: JSON.stringify({ type: 'steer', id: 'r2', text: 'hi' }),
			writeLine: (line) => lines.push(line),
			home,
			timeoutMs: 2_000,
		});
		expect(code).toBe(0);
		expect(lines[0]).toBe(STEERING_RELAY_STARTED_LINE);
		expect(JSON.parse(lines[1])).toMatchObject({
			id: 'r2',
			verdict: 'refused',
			refusal: 'not-running',
		});
	});

	it('delivers nothing, and prints no started line, into an untrusted folder', async () => {
		const home = tempHome();
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'mpx-'));
		homes.push(elsewhere);
		fs.mkdirSync(path.join(home, '.maestro'), { recursive: true });
		fs.symlinkSync(elsewhere, path.join(home, '.maestro', 'steer'));
		const lines: string[] = [];
		const code = await runSteeringRelay({
			socketSpec: '~/.maestro/steer/x.sock',
			stdinText: JSON.stringify({ type: 'steer', id: 'r3', text: 'hi' }),
			writeLine: (line) => lines.push(line),
			warn: () => {},
			home,
		});
		expect(code).toBe(3);
		expect(lines).toEqual([]);
	});

	it('prints nothing (so the desktop reads a refusal) when stdin holds no frame', async () => {
		const lines: string[] = [];
		const code = await runSteeringRelay({
			socketSpec: '~/.maestro/steer/x.sock',
			stdinText: 'not a frame',
			writeLine: (line) => lines.push(line),
			warn: () => {},
			home: tempHome(),
		});
		expect(code).toBe(2);
		expect(lines).toEqual([]);
	});
});

/**
 * @file steering-relay.test.ts
 * @description Parity F1: `maestro-p --steer-relay <socket>` delivers one steering
 * request, read from stdin, to a turn's socket on the same host, and prints the
 * started line and the verdict. Also the early-mode parse that keeps both the relay
 * and the capabilities probe away from claude, and the home-relative socket path.
 * Real sockets, under a temp "home".
 */

import * as fs from 'fs';
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
	resolveSteeringSocketPath,
	startSteeringServer,
} from '../../maestro-p/steering-server';
import {
	MAESTRO_P_CAPABILITIES_FLAG,
	parseMaestroPCapabilities,
	STEERING_RELAY_CAPABILITY,
	STEERING_RELAY_FLAG,
	STEERING_RELAY_STARTED_LINE,
} from '../../shared/chatSteering';

const isWindows = process.platform === 'win32';
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

describe('resolveSteeringSocketPath / ensureSteeringSocketDir', () => {
	it('expands a home-relative socket and leaves an absolute one alone', () => {
		expect(resolveSteeringSocketPath('~/.maestro/steer/a.sock', '/home/u')).toBe(
			path.join('/home/u', '.maestro/steer/a.sock')
		);
		expect(resolveSteeringSocketPath('/tmp/a.sock', '/home/u')).toBe('/tmp/a.sock');
	});

	it.skipIf(isWindows)('creates the remote steering folder owner-only', () => {
		const home = tempHome();
		expect(ensureSteeringSocketDir('~/.maestro/steer/a.sock', () => {}, home)).toBe(true);
		const mode = fs.statSync(path.join(home, '.maestro', 'steer')).mode & 0o777;
		expect(mode).toBe(0o700);
	});
});

describe.skipIf(isWindows)('runSteeringRelay', () => {
	it('delivers the frame from stdin to the turn socket and prints started then the verdict', async () => {
		const home = tempHome();
		const spec = '~/.maestro/steer/t.sock';
		expect(ensureSteeringSocketDir(spec, () => {}, home)).toBe(true);
		const received: Array<{ id: string; text: string }> = [];
		const server = startSteeringServer({
			socketPath: resolveSteeringSocketPath(spec, home),
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

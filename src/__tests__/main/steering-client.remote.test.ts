/**
 * @file steering-client.remote.test.ts
 * @description Parity F1: a steer for a Claude TUI turn on an SSH remote is one
 * ssh command running `maestro-p --steer-relay <socket>` there, with the request
 * frame (the user's text) on stdin and never in argv. The ssh layer is mocked; the
 * command it is handed and the stdin it is given are what is under test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	remoteSteeringSocketFor,
	sendRemoteSteeringRequest,
	type RemoteSteeringChannel,
} from '../../main/process-manager/steering-client';
import {
	REMOTE_STEERING_SOCKET_DIR,
	STEERING_MAX_TEXT_BYTES,
	STEERING_RELAY_FLAG,
	STEERING_RELAY_STARTED_LINE,
} from '../../shared/chatSteering';
import type { SshRemoteConfig } from '../../shared/types';

vi.mock('../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const ssh = vi.hoisted(() => ({
	built: [] as Array<{ command: string; args: string[]; useStdin?: boolean }>,
	execs: [] as Array<{ input?: string; timeout?: number }>,
	result: { stdout: '', stderr: '', exitCode: 0 as number | string },
	buildThrows: false,
}));

vi.mock('../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: vi.fn(
		async (_remote: unknown, options: { command: string; args: string[]; useStdin?: boolean }) => {
			if (ssh.buildThrows) throw new Error('no ssh binary');
			ssh.built.push(options);
			return {
				command: 'ssh',
				args: ['-T', 'box', `${options.command} ${options.args.join(' ')}`],
			};
		}
	),
	execSshCommand: vi.fn(
		async (_remote: unknown, _cmd: unknown, options: { input?: string; timeout?: number }) => {
			ssh.execs.push(options);
			return ssh.result;
		}
	),
}));

const remote: SshRemoteConfig = {
	id: 'r1',
	name: 'box',
	host: 'box.example',
	port: 22,
	username: 'me',
	privateKeyPath: '',
	enabled: true,
} as SshRemoteConfig;

const channel: RemoteSteeringChannel = {
	remote,
	command: 'maestro-p',
	socket: remoteSteeringSocketFor('s1-ai-tab-1'),
};

const TEXT = `also check $(rm -rf ~) and 'quotes' "here"`;

beforeEach(() => {
	ssh.built = [];
	ssh.execs = [];
	ssh.result = { stdout: '', stderr: '', exitCode: 0 };
	ssh.buildThrows = false;
});

function verdictLine(id: string, verdict: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({ type: 'steering', id, verdict, ...extra });
}

describe('remoteSteeringSocketFor', () => {
	it('names a home-relative socket in the remote steering folder, stable per key', () => {
		const a = remoteSteeringSocketFor('s1-ai-tab-1');
		expect(a.startsWith(`${REMOTE_STEERING_SOCKET_DIR}/maestro-steer-`)).toBe(true);
		expect(a.endsWith('.sock')).toBe(true);
		expect(remoteSteeringSocketFor('s1-ai-tab-1')).toBe(a);
		expect(remoteSteeringSocketFor('s1-ai-tab-2')).not.toBe(a);
	});
});

describe('sendRemoteSteeringRequest', () => {
	it('runs the relay with the payload on stdin and none of it in argv', async () => {
		ssh.result = {
			stdout: `${STEERING_RELAY_STARTED_LINE}\n${verdictLine('id-1', 'delivered')}\n`,
			stderr: '',
			exitCode: 0,
		};
		const result = await sendRemoteSteeringRequest({
			channel,
			processKey: 's1-ai-tab-1',
			text: TEXT,
			id: 'id-1',
		});
		expect(result).toEqual({ type: 'steering', id: 'id-1', verdict: 'delivered' });
		expect(ssh.built).toEqual([
			{ command: 'maestro-p', args: [STEERING_RELAY_FLAG, channel.socket], useStdin: true },
		]);
		// The text travels on stdin as one request frame.
		expect(ssh.execs).toHaveLength(1);
		const stdin = ssh.execs[0].input!;
		expect(stdin.endsWith('\n')).toBe(true);
		expect(JSON.parse(stdin)).toEqual({ type: 'steer', id: 'id-1', text: TEXT });
		// ...and nowhere on the command line.
		for (const arg of ssh.built[0].args) expect(arg).not.toContain('rm -rf');
	});

	it('passes a refusal from the remote through unchanged', async () => {
		ssh.result = {
			stdout: `${STEERING_RELAY_STARTED_LINE}\n${verdictLine('id-2', 'refused', {
				refusal: 'blocking-dialog',
				detail: 'a permission prompt is on screen',
			})}\n`,
			stderr: '',
			exitCode: 0,
		};
		const result = await sendRemoteSteeringRequest({
			channel,
			processKey: 'k',
			text: 'hi',
			id: 'id-2',
		});
		expect(result).toMatchObject({ verdict: 'refused', refusal: 'blocking-dialog' });
	});

	it('refuses (the message stays queued) when ssh never reached the host', async () => {
		ssh.result = {
			stdout: '',
			stderr: 'ssh: connect to host box: Connection refused',
			exitCode: 255,
		};
		const result = await sendRemoteSteeringRequest({
			channel,
			processKey: 'k',
			text: 'hi',
			id: 'id-3',
		});
		expect(result).toMatchObject({ id: 'id-3', verdict: 'refused', refusal: 'not-running' });
		expect(result.detail).toContain('box');
	});

	it('refuses when the relay never started (maestro-p missing on the remote)', async () => {
		ssh.result = { stdout: '', stderr: 'maestro-p: command not found', exitCode: 127 };
		const result = await sendRemoteSteeringRequest({
			channel,
			processKey: 'k',
			text: 'hi',
			id: 'id-4',
		});
		expect(result).toMatchObject({ verdict: 'refused', refusal: 'not-running' });
	});

	it('refuses when the ssh command could not even be built', async () => {
		ssh.buildThrows = true;
		const result = await sendRemoteSteeringRequest({
			channel,
			processKey: 'k',
			text: 'hi',
			id: 'id-5',
		});
		expect(result).toMatchObject({ verdict: 'refused', refusal: 'not-running' });
		expect(ssh.execs).toHaveLength(0);
	});

	it('answers `unknown`, never `refused`, once the relay started and no verdict came', async () => {
		ssh.result = { stdout: `${STEERING_RELAY_STARTED_LINE}\n`, stderr: '', exitCode: 255 };
		const result = await sendRemoteSteeringRequest({
			channel,
			processKey: 'k',
			text: 'hi',
			id: 'id-6',
		});
		expect(result).toMatchObject({ id: 'id-6', verdict: 'unknown' });
	});

	it('answers `unknown` when ssh ran out of time, even before a started line', async () => {
		ssh.result = { stdout: '', stderr: 'ETIMEDOUT', exitCode: 'ETIMEDOUT' };
		const result = await sendRemoteSteeringRequest({
			channel,
			processKey: 'k',
			text: 'hi',
			id: 'id-7',
		});
		expect(result.verdict).toBe('unknown');
	});

	it('ignores a verdict for another request id', async () => {
		ssh.result = {
			stdout: `${STEERING_RELAY_STARTED_LINE}\n${verdictLine('other', 'delivered')}\n`,
			stderr: '',
			exitCode: 0,
		};
		const result = await sendRemoteSteeringRequest({
			channel,
			processKey: 'k',
			text: 'hi',
			id: 'id-8',
		});
		expect(result.verdict).toBe('unknown');
	});

	it('refuses an over-cap steer without running ssh', async () => {
		const result = await sendRemoteSteeringRequest({
			channel,
			processKey: 'k',
			text: 'x'.repeat(STEERING_MAX_TEXT_BYTES + 1),
			id: 'id-9',
		});
		expect(result).toMatchObject({ verdict: 'refused', refusal: 'too-long' });
		expect(ssh.built).toHaveLength(0);
	});
});

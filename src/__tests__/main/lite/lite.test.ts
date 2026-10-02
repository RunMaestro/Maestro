import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { once } from 'events';
import {
	LiteProfiles,
	normalizeRemoteUrl,
	hostPartition,
	validateProfile,
} from '../../../main/lite/profiles';
import type { LiteProfile } from '../../../main/lite/profiles';
import { tunnelArgs, OwnedTunnel } from '../../../main/lite/tunnel';
import { validateHandshake } from '../../../main/lite/handshake';
import type { MaestroRemoteHandshake } from '../../../shared/maestroRemote';

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
	);
});
const profile: LiteProfile = {
	id: 'host-a',
	name: 'Host A',
	transport: 'ssh',
	url: 'http://127.0.0.1:8080/token-a/desktop',
	ssh: {
		id: 'host-a',
		name: 'Host A',
		host: 'my-alias',
		port: 22,
		username: '',
		privateKeyPath: '',
		useSshConfig: true,
		enabled: true,
	},
};
const host: MaestroRemoteHandshake = {
	protocolVersion: 1,
	instanceId: 'instance-a',
	hostName: 'Host A',
	appVersion: '0.18.6',
	platform: 'linux',
	ready: true,
	authentication: { loginEnabled: false, authenticated: false },
	capabilities: { sessions: true, terminal: true, files: true, browserRelay: true },
};

describe('Lite URL and host identity boundary', () => {
	it('normalizes host desktop URLs and preserves reverse proxy bases', () => {
		expect(
			normalizeRemoteUrl('https://host.example/proxy/token/desktop/', 'https').toString()
		).toBe('https://host.example/proxy/token');
		expect(normalizeRemoteUrl(profile.url, 'ssh').toString()).toBe('http://127.0.0.1:8080/token-a');
	});
	it.each([
		'http://host.example/token',
		'file:///token',
		'https://user:pass@host.example/token',
		'https://host.example/token?password=secret',
		'https://host.example/token#other',
		'https://host.example/',
		'https://host.example/token\\desktop',
	])('rejects unsafe direct URL %s', (url) => {
		expect(() => normalizeRemoteUrl(url, 'https')).toThrow();
	});
	it('never forwards to arbitrary remote network hosts', () => {
		expect(() => normalizeRemoteUrl('http://internal.example/token', 'ssh')).toThrow(/loopback/);
	});
	it('isolates host identity and profile identity independent of loopback address reuse', () => {
		expect(hostPartition('host-a', 'instance-a')).not.toBe(hostPartition('host-a', 'instance-b'));
		expect(hostPartition('host-a', 'instance-a')).not.toBe(hostPartition('host-b', 'instance-a'));
	});
	it('retains validated identity after reload and clears it when endpoint changes', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'maestro-lite-profile-'));
		directories.push(directory);
		const store = new LiteProfiles(directory);
		await store.load();
		await store.save({ ...profile, instanceId: 'instance-a' });
		const reloaded = new LiteProfiles(directory);
		await reloaded.load();
		expect(reloaded.get('host-a').instanceId).toBe('instance-a');
		await reloaded.save({ ...reloaded.get('host-a'), url: 'http://127.0.0.1:8080/token-b' });
		expect(reloaded.get('host-a').instanceId).toBeUndefined();
	});
	it('serializes simultaneous saves and delete without losing validated profiles', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'maestro-lite-profile-'));
		directories.push(directory);
		const store = new LiteProfiles(directory);
		await store.load();
		await Promise.all([
			store.save({ ...profile, instanceId: 'instance-a', localPort: 54321 }),
			store.save({ ...profile, id: 'host-b', name: 'Host B', instanceId: 'instance-b' }),
		]);
		await Promise.all([
			store.remove('host-b'),
			store.save({ ...store.get('host-a'), name: 'Renamed host' }),
		]);
		const reloaded = new LiteProfiles(directory);
		await reloaded.load();
		expect(reloaded.list()).toEqual([
			{
				...validateProfile(profile),
				name: 'Renamed host',
				instanceId: 'instance-a',
				localPort: 54321,
			},
		]);
	});
	it('refuses changed identity, not-ready hosts, incompatible protocol and unauthenticated direct access', () => {
		expect(() => validateHandshake(host, { ...profile, instanceId: 'other' })).toThrow(/identity/);
		expect(() =>
			validateHandshake({ ...host, ready: false, unavailableReason: 'owner unavailable' }, profile)
		).toThrow(/owner unavailable/);
		expect(() => validateHandshake({ ...host, protocolVersion: 2 }, profile)).toThrow(
			/Incompatible/
		);
		expect(() => validateHandshake(host, { ...profile, transport: 'https' })).toThrow(/host login/);
		expect(() =>
			validateHandshake(
				{ ...host, authentication: { loginEnabled: true, authenticated: false } },
				{ ...profile, transport: 'https' }
			)
		).toThrow(/login/);
		expect(
			validateHandshake(
				{ ...host, authentication: { loginEnabled: true, authenticated: true } },
				{ ...profile, transport: 'https' }
			).instanceId
		).toBe('instance-a');
	});
});

describe('Lite SSH ownership and argument safety', () => {
	it.each(['-oProxyCommand=bad', 'host;touch-bad', 'host\nother'])(
		'rejects option-shaped and shell-shaped SSH hosts %s',
		(hostname) => {
			expect(() =>
				validateProfile({ ...profile, ssh: { ...profile.ssh!, host: hostname } })
			).toThrow();
		}
	);
	it.each([
		'StrictHostKeyChecking',
		'UserKnownHostsFile',
		'LocalForward',
		'RemoteForward',
		'DynamicForward',
		'ControlPath',
	])('refuses transport policy override %s', (key) => {
		expect(() =>
			validateProfile({ ...profile, ssh: { ...profile.ssh!, sshOptions: { [key]: 'unsafe' } } })
		).toThrow(/manages/);
	});
	it('real ssh config resolves one strict loopback forward and preserves alias/config port', async () => {
		const args = tunnelArgs(
			{
				...profile.ssh!,
				sshOptions: { NoHostAuthenticationForLocalhost: 'yes', ForwardAgent: 'yes' },
			},
			normalizeRemoteUrl(profile.url, 'ssh'),
			54321
		);
		const { stdout } = await promisify(execFile)(
			'ssh',
			['-G', '-F', process.platform === 'win32' ? 'NUL' : '/dev/null', ...args],
			{ windowsHide: true }
		);
		expect(stdout).toMatch(/^stricthostkeychecking true$/m);
		expect(stdout).toMatch(/^exitonforwardfailure yes$/m);
		expect(stdout).toMatch(/^nohostauthenticationforlocalhost no$/m);
		expect(stdout).toMatch(/^forwardagent no$/m);
		expect(stdout).toMatch(/^localforward \[127\.0\.0\.1\]:54321 \[127\.0\.0\.1\]:8080$/m);
		expect(stdout).toMatch(/^hostname my-alias$/m);
		expect(stdout).not.toMatch(/^(remoteforward|dynamicforward) /m);
	});
	it('disconnect kills only its owned child and leaves an unrelated workload running', async () => {
		const owned = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
			stdio: ['pipe', 'ignore', 'ignore'],
		});
		const unrelated = spawn(process.execPath, ['-e', 'process.stdin.resume()'], {
			stdio: ['pipe', 'ignore', 'ignore'],
		});
		try {
			await Promise.all([once(owned, 'spawn'), once(unrelated, 'spawn')]);
			const tunnel = new OwnedTunnel(owned);
			const closed = once(owned, 'close');
			tunnel.stop();
			tunnel.stop();
			await closed;
			expect(owned.killed).toBe(true);
			expect(unrelated.killed).toBe(false);
			expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
		} finally {
			owned.kill();
			unrelated.kill();
		}
	});
});

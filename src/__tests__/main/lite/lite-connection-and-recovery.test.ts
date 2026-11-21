// Source: src/__tests__/main/lite/lite.test.ts
// Source: src/__tests__/main/lite/tunnel-recovery.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { afterEach } from 'vitest';
import { mkdtemp } from 'fs/promises';
import { rm } from 'fs/promises';
import { writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { spawn } from 'child_process';
import { execFile } from 'child_process';
import { once } from 'events';
import { LiteProfiles } from '../../../main/lite/profiles';
import { normalizeRemoteUrl } from '../../../main/lite/profiles';
import { hostPartition } from '../../../main/lite/profiles';
import { validateProfile } from '../../../main/lite/profiles';
import { LiteLastConnections } from '../../../main/lite/last-connection';
import type { LiteProfile } from '../../../shared/lite-control';
import { tunnelArgs } from '../../../main/lite/tunnel';
import { OwnedTunnel } from '../../../main/lite/tunnel';
import { validateHandshake } from '../../../main/lite/handshake';
import type { MaestroRemoteHandshake } from '../../../shared/maestroRemote';
import { beforeEach } from 'vitest';
import { vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import net from 'net';
import type { SshRemoteConfig } from '../../../shared/types';
import { openTunnel } from '../../../main/lite/tunnel';
const mocks = vi.hoisted(() => ({
	recovering: false,
	children: [] as Array<EventEmitter & { crash(): void }>,
}));
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	const output = (values: string[]) => {
		const forward = values[values.indexOf('-L') + 1];
		const match = /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(forward)!;
		return `localforward [127.0.0.1]:${match[1]} [127.0.0.1]:${match[2]}\n`;
	};
	const execFile = (...args: unknown[]) => {
		if (!mocks.recovering) return Reflect.apply(actual.execFile, undefined, args);
		const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
		queueMicrotask(() => callback(null, output(args[1] as string[]), ''));
		return new EventEmitter();
	};
	Object.assign(execFile, {
		[promisify.custom]: async (...args: unknown[]) =>
			mocks.recovering
				? { stdout: output(args[1] as string[]), stderr: '' }
				: Reflect.apply(promisify(actual.execFile), undefined, args),
	});
	return {
		...actual,
		execFile,
		spawn: (file: string, args: string[], options?: Parameters<typeof actual.spawn>[2]) => {
			if (!mocks.recovering) return actual.spawn(file, args, options);
			const forward = args[args.indexOf('-L') + 1];
			const port = Number(/^127\.0\.0\.1:(\d+):/.exec(forward)![1]);
			const child = new EventEmitter() as EventEmitter & {
				stderr: PassThrough;
				kill(): boolean;
				crash(): void;
			};
			child.stderr = new PassThrough();
			const listener = net.createServer();
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				listener.close(() => {
					child.emit('exit', 1);
					child.emit('close');
				});
			};
			child.kill = () => {
				finish();
				return true;
			};
			child.crash = finish;
			listener.listen(port, '127.0.0.1');
			mocks.children.push(child);
			return child;
		},
	};
});
describe('lite', () => {
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
		workflowQualificationVersion: 1,
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
			expect(normalizeRemoteUrl(profile.url, 'ssh').toString()).toBe(
				'http://127.0.0.1:8080/token-a'
			);
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
		it('restricts discovered LAN connections to paired application paths and authenticated device handshakes', () => {
			const lanProfile: LiteProfile = {
				...profile,
				transport: 'lan',
				url: 'http://192.168.1.10:56036/.well-known/maestro/connect',
				instanceId: host.instanceId,
			};
			expect(normalizeRemoteUrl(lanProfile.url, 'lan').toString()).toBe(lanProfile.url);
			expect(() => normalizeRemoteUrl('http://192.168.1.10:56036/token', 'lan')).toThrow(
				/paired connection/
			);
			expect(() => validateHandshake(host, lanProfile)).toThrow(/device pairing/);
			expect(() => validateHandshake(host, lanProfile, true)).toThrow(/authorization/);
			const authenticated = {
				...host,
				authentication: {
					loginEnabled: false,
					authenticated: true,
					method: 'device-pairing' as const,
				},
			};
			expect(validateHandshake(authenticated, lanProfile, true).instanceId).toBe(host.instanceId);
			expect(() =>
				validateHandshake(authenticated, { ...lanProfile, instanceId: 'different' }, true)
			).toThrow(/identity/);
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
			expect(() =>
				validateHandshake({ ...host, workflowQualificationVersion: undefined }, profile)
			).toThrow(/Incompatible/);
			expect(() => validateHandshake(host, { ...profile, instanceId: 'other' })).toThrow(
				/identity/
			);
			expect(() =>
				validateHandshake(
					{ ...host, ready: false, unavailableReason: 'owner unavailable' },
					profile
				)
			).toThrow(/owner unavailable/);
			expect(() => validateHandshake({ ...host, protocolVersion: 2 }, profile)).toThrow(
				/Incompatible/
			);
			expect(() => validateHandshake(host, { ...profile, transport: 'https' })).toThrow(
				/host login/
			);
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
			const directory = await mkdtemp(path.join(os.tmpdir(), 'maestro-lite-ssh-config-'));
			directories.push(directory);
			const config = path.join(directory, 'config');
			await writeFile(config, '');
			const args = tunnelArgs(
				{
					...profile.ssh!,
					sshOptions: { NoHostAuthenticationForLocalhost: 'yes', ForwardAgent: 'yes' },
				},
				normalizeRemoteUrl(profile.url, 'ssh'),
				54321
			);
			const { stdout } = await promisify(execFile)('ssh', ['-G', '-F', config, ...args], {
				windowsHide: true,
			});
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

	describe('Lite last-connection recovery intent', () => {
		it('restores validated manual and discovered targets and honors explicit disable', async () => {
			const directory = await mkdtemp(path.join(os.tmpdir(), 'maestro-lite-recovery-'));
			directories.push(directory);
			const store = new LiteLastConnections(directory);
			await store.load();
			await store.remember({ ...profile, instanceId: 'instance-a' });
			const manual = new LiteLastConnections(directory);
			await manual.load();
			expect(manual.get()).toEqual({
				profile: { ...validateProfile(profile), instanceId: 'instance-a' },
				enabled: true,
			});
			await manual.disable();
			const disabled = new LiteLastConnections(directory);
			await disabled.load();
			expect(disabled.get()?.enabled).toBe(false);
			await disabled.remember({
				id: 'discovered-1',
				name: 'Work computer',
				transport: 'lan',
				url: 'http://192.168.1.20:56036/.well-known/maestro/connect',
				instanceId: 'instance-a',
			});
			const direct = new LiteLastConnections(directory);
			await direct.load();
			expect(direct.get()).toEqual({
				profile: {
					id: 'discovered-1',
					name: 'Work computer',
					transport: 'lan',
					url: 'http://192.168.1.20:56036/.well-known/maestro/connect',
					instanceId: 'instance-a',
				},
				enabled: true,
			});
		});
	});
});
describe('tunnel-recovery', () => {
	const config: SshRemoteConfig = {
		id: 'host-a',
		name: 'Host A',
		host: 'test-alias',
		port: 22,
		username: '',
		privateKeyPath: '',
		useSshConfig: true,
		enabled: true,
	};
	const endpoint = new URL('http://127.0.0.1:8080/token');
	const controllers: AbortController[] = [];
	afterEach(() => {
		for (const controller of controllers.splice(0)) controller.abort();
		for (const child of mocks.children.splice(0)) child.crash();
	});

	describe('Lite SSH tunnel recovery contract', () => {
		beforeEach(() => {
			mocks.recovering = true;
		});
		afterEach(() => {
			mocks.recovering = false;
		});
		it('reports an established forwarding exit as retryable', async () => {
			const controller = new AbortController();
			controllers.push(controller);
			const onExit = vi.fn();
			const opened = await openTunnel(config, endpoint, controller.signal, onExit);
			mocks.children[0].crash();
			await vi.waitFor(() => expect(onExit).toHaveBeenCalledOnce());
			expect(onExit.mock.calls[0][0]).toMatchObject({ retryable: true });
			await opened.tunnel.stop();
		});

		it('refuses to move an established view to a fallback port', async () => {
			const controller = new AbortController();
			controllers.push(controller);
			const blocker = net.createServer();
			await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
			const port = (blocker.address() as net.AddressInfo).port;
			try {
				await expect(
					openTunnel(config, endpoint, controller.signal, vi.fn(), port, false)
				).rejects.toThrow(/EADDRINUSE/);
				expect(mocks.children).toHaveLength(0);
			} finally {
				await new Promise<void>((resolve) => blocker.close(() => resolve()));
			}
		});
	});
});

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import type { PermissionGrant } from '../../../shared/plugins/permissions';

// `~` expansion reads os.homedir(). Stub it to a throwaway temp directory so no
// assertion here can depend on (or touch) the machine's real home folder.
const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	return { ...actual, homedir: () => home.dir };
});

function grant(capability: string, scope?: string): PermissionGrant {
	return { capability, ...(scope ? { scope } : {}), grantedAt: 1 } as PermissionGrant;
}

describe('PermissionBroker', () => {
	it('denies by default when the plugin has no grants', () => {
		const broker = new PermissionBroker({ getGrants: () => [] });
		const d = broker.authorize('p', 'fs.read', { path: '/x' });
		expect(d.allowed).toBe(false);
		expect(d.capability).toBe('fs:read');
		expect(d.reason).toMatch(/permission denied/);
	});

	it('allows a scoped fs.read inside the granted path', () => {
		const broker = new PermissionBroker({ getGrants: () => [grant('fs:read', '/data')] });
		expect(broker.authorize('p', 'fs.read', { path: '/data/x' }).allowed).toBe(true);
		expect(broker.authorize('p', 'fs.read', { path: '/etc/x' }).allowed).toBe(false);
	});

	it('maps net.fetch to net:fetch and checks host scope', () => {
		const broker = new PermissionBroker({ getGrants: () => [grant('net:fetch', 'example.com')] });
		expect(broker.authorize('p', 'net.fetch', { url: 'https://api.example.com' }).allowed).toBe(
			true
		);
		expect(broker.authorize('p', 'net.fetch', { url: 'https://evil.com' }).allowed).toBe(false);
	});

	it('maps net.connect to net:connect and checks host scope', () => {
		const broker = new PermissionBroker({
			getGrants: () => [grant('net:connect', 'gateway.discord.gg')],
		});
		expect(
			broker.authorize('p', 'net.connect', { url: 'wss://gateway.discord.gg/?v=10' }).allowed
		).toBe(true);
		expect(broker.authorize('p', 'net.connect', { url: 'wss://evil.example' }).allowed).toBe(false);
	});

	it('allows net.send/net.close on a SCOPED net:connect grant (handler re-authorizes the socket URL)', () => {
		// These methods carry only a socketId, so extractTarget yields no host. The
		// broker must not reject a scoped grant for a missing target - it confirms
		// the capability is held and the handler re-checks the stored socket origin.
		const broker = new PermissionBroker({
			getGrants: () => [grant('net:connect', 'gateway.discord.gg')],
		});
		expect(broker.authorize('p', 'net.send', { socketId: 's', data: 'hi' }).allowed).toBe(true);
		expect(broker.authorize('p', 'net.close', { socketId: 's' }).allowed).toBe(true);
	});

	it('denies net.send/net.close when the plugin holds no net:connect grant at all', () => {
		const broker = new PermissionBroker({ getGrants: () => [grant('net:fetch', 'example.com')] });
		expect(broker.authorize('p', 'net.send', { socketId: 's', data: 'hi' }).allowed).toBe(false);
		expect(broker.authorize('p', 'net.close', { socketId: 's' }).allowed).toBe(false);
	});

	it('re-reads grants on each call (live revocation)', () => {
		let grants: PermissionGrant[] = [grant('notifications:toast')];
		const broker = new PermissionBroker({ getGrants: () => grants });
		expect(broker.authorize('p', 'notifications.toast', {}).allowed).toBe(true);
		grants = [];
		expect(broker.authorize('p', 'notifications.toast', {}).allowed).toBe(false);
	});

	it('audits every decision', () => {
		const onDecision = vi.fn();
		const broker = new PermissionBroker({ getGrants: () => [], onDecision });
		broker.authorize('p', 'process.spawn', { command: 'ls' });
		expect(onDecision).toHaveBeenCalledWith(
			'p',
			'process.spawn',
			expect.objectContaining({ allowed: false, capability: 'process:spawn' })
		);
	});

	it('checks live media grants without emitting synthetic RPC audit decisions', () => {
		let grants: PermissionGrant[] = [grant('media:tools', 'discord-voice')];
		const onDecision = vi.fn();
		const broker = new PermissionBroker({ getGrants: () => grants, onDecision });
		expect(broker.authorize('p', 'media.open', {}).allowed).toBe(true);
		expect(broker.authorize('p', 'media.open', {}, { audit: false }).allowed).toBe(true);
		grants = [grant('media:tools', '*')];
		expect(broker.authorize('p', 'media.open', {}, { audit: false }).allowed).toBe(false);
		grants = [];
		expect(broker.authorize('p', 'media.open', {}, { audit: false }).allowed).toBe(false);
		expect(onDecision).toHaveBeenCalledTimes(1);
		expect(broker.authorize('p', 'media.open', {}).allowed).toBe(false);
		expect(onDecision).toHaveBeenCalledTimes(2);
	});

	it('preserves protected-path refusal when a host check suppresses auditing', () => {
		const onDecision = vi.fn();
		const broker = new PermissionBroker({
			getGrants: () => [grant('fs:read')],
			protectedPaths: () => ['/private/config'],
			onDecision,
		});
		expect(
			broker.authorize('p', 'fs.read', { path: '/private/config/grants.json' }, { audit: false })
		).toMatchObject({
			allowed: false,
			reason: expect.stringContaining('protected location'),
		});
		expect(onDecision).not.toHaveBeenCalled();
	});

	it('per-plugin isolation: grants for one plugin do not leak to another', () => {
		const broker = new PermissionBroker({
			getGrants: (id) => (id === 'trusted' ? [grant('fs:read')] : []),
		});
		expect(broker.authorize('trusted', 'fs.read', { path: '/x' }).allowed).toBe(true);
		expect(broker.authorize('other', 'fs.read', { path: '/x' }).allowed).toBe(false);
	});
});

describe('PermissionBroker home-relative (~) path scopes', () => {
	// The maestro-kanban grant set: one entry per scope per capability, exactly
	// the four directories/files the plugin ever owns under ~/.maestro.
	const KANBAN_SCOPES = [
		'~/.maestro/kanban.yaml',
		'~/.maestro/kanban-boards',
		'~/.maestro/kanban-conductor',
		'~/.maestro/kanban-archive',
	];

	beforeAll(() => {
		home.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-broker-home-'));
	});
	afterAll(() => fs.rmSync(home.dir, { recursive: true, force: true }));

	function kanbanBroker(protectedPaths?: readonly string[]): PermissionBroker {
		return new PermissionBroker({
			getGrants: () => [
				...KANBAN_SCOPES.map((scope) => grant('fs:read', scope)),
				...KANBAN_SCOPES.map((scope) => grant('fs:write', scope)),
			],
			...(protectedPaths ? { protectedPaths: () => protectedPaths } : {}),
		});
	}

	it('covers a ~ target with a ~ scope, for read and write', () => {
		const b = kanbanBroker();
		for (const target of [
			'~/.maestro/kanban.yaml',
			'~/.maestro/kanban-boards/my-app-1a2b3c4d.yaml',
			'~/.maestro/kanban-conductor/notes.md',
			'~/.maestro/kanban-archive/2026/old.yaml',
		]) {
			expect(b.authorize('p', 'fs.read', { path: target }).allowed, target).toBe(true);
			expect(b.authorize('p', 'fs.write', { path: target }).allowed, target).toBe(true);
		}
	});

	it('covers the EXPANDED real path too (the fs handlers re-authorize with it)', () => {
		const b = kanbanBroker();
		const real = path.join(home.dir, '.maestro', 'kanban-boards', 'my-app-1a2b3c4d.yaml');
		expect(b.authorize('p', 'fs.read', { path: real }).allowed).toBe(true);
		expect(b.authorize('p', 'fs.write', { path: real }).allowed).toBe(true);
	});

	it('reports the expanded path as the decision target (what the host would touch)', () => {
		const onDecision = vi.fn();
		const broker = new PermissionBroker({
			getGrants: () => [grant('fs:read', '~/.maestro/kanban-boards')],
			onDecision,
		});
		const d = broker.authorize('p', 'fs.read', { path: '~/.maestro/kanban-boards/x.yaml' });
		expect(d.target).toBe(path.join(home.dir, '.maestro/kanban-boards/x.yaml'));
		expect(d.target).not.toContain('~');
		expect(onDecision).toHaveBeenCalledWith('p', 'fs.read', d);
	});

	it('denies a home path outside the granted ~/.maestro/kanban* scopes', () => {
		const b = kanbanBroker();
		for (const target of ['~/.maestro/other.yaml', '~/notes.txt', '~/.ssh/id_rsa', '~']) {
			expect(b.authorize('p', 'fs.read', { path: target }).allowed, target).toBe(false);
			expect(b.authorize('p', 'fs.write', { path: target }).allowed, target).toBe(false);
		}
	});

	it('denies a .. escape out of a ~ scope (segments collapse before matching)', () => {
		const b = kanbanBroker();
		const escape = '~/.maestro/kanban-boards/../../.ssh/id_rsa';
		expect(b.authorize('p', 'fs.read', { path: escape }).allowed).toBe(false);
		expect(b.authorize('p', 'fs.write', { path: escape }).allowed).toBe(false);
		// A `..` that stays inside the scope is still fine.
		expect(
			b.authorize('p', 'fs.read', { path: '~/.maestro/kanban-boards/sub/../ok.yaml' }).allowed
		).toBe(true);
	});

	it('does not expand ~user/... (it is matched as a literal, so it is denied)', () => {
		const b = kanbanBroker();
		const d = b.authorize('p', 'fs.read', { path: '~root/.maestro/kanban.yaml' });
		expect(d.allowed).toBe(false);
		expect(d.target).toBe('~root/.maestro/kanban.yaml');
		expect(d.target).not.toContain(home.dir);
	});

	it('still denies a ~ path that resolves inside the userData tree', () => {
		const userData = path.join(home.dir, '.maestro', 'kanban-boards', 'userData');
		const b = kanbanBroker([userData]);
		const d = b.authorize('p', 'fs.write', { path: '~/.maestro/kanban-boards/userData/x.json' });
		expect(d.allowed).toBe(false);
		expect(d.reason).toMatch(/protected location/);
		// A sibling sharing the textual prefix is NOT inside it.
		expect(
			b.authorize('p', 'fs.write', { path: '~/.maestro/kanban-boards/userData-sibling/x' }).allowed
		).toBe(true);
	});

	it('leaves absolute scopes and non-path capabilities untouched', () => {
		const broker = new PermissionBroker({
			getGrants: () => [grant('fs:read', '/data'), grant('net:fetch', 'example.com')],
		});
		expect(broker.authorize('p', 'fs.read', { path: '/data/x' }).allowed).toBe(true);
		expect(broker.authorize('p', 'fs.read', { path: '~/.maestro/kanban.yaml' }).allowed).toBe(
			false
		);
		const net = broker.authorize('p', 'net.fetch', { url: 'https://example.com/x' });
		expect(net.allowed).toBe(true);
		expect(net.target).toBe('example.com');
	});
});

// Source: src/__tests__/main/plugins/permission-broker-userdata-exclusion.test.ts
// Source: src/__tests__/main/plugins/permission-broker.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import type { PermissionGrant } from '../../../shared/plugins/permissions';
import { vi } from 'vitest';
describeSourceSuite('permission-broker-userdata-exclusion', () => {
	function grant(capability: string, scope?: string): PermissionGrant {
		return { capability, ...(scope ? { scope } : {}), grantedAt: 1 } as PermissionGrant;
	}

	const userData =
		process.platform === 'win32' ? 'C:/Users/me/AppData/Maestro' : '/home/me/.config/Maestro';

	function broker(grants: PermissionGrant[]): PermissionBroker {
		return new PermissionBroker({ getGrants: () => grants, protectedPaths: () => [userData] });
	}

	describe('PermissionBroker userData/config-tree exclusion', () => {
		it('denies fs.read/fs.write into the userData tree even with a broad grant', () => {
			const b = broker([grant('fs:read'), grant('fs:write')]);
			const targets = [
				`${userData}/plugin-grants.json`,
				`${userData}/cli-server.json`,
				`${userData}/plugins/evil/x`,
				`${userData}/maestro-pianola-supervisor.json`,
				userData,
			];
			for (const path of targets) {
				expect(b.authorize('p', 'fs.read', { path }).allowed).toBe(false);
				expect(b.authorize('p', 'fs.write', { path }).allowed).toBe(false);
			}
		});

		it('still allows fs access OUTSIDE the protected tree (separator boundary)', () => {
			const b = broker([grant('fs:read')]);
			// A sibling dir sharing the textual prefix must NOT be treated as inside.
			expect(b.authorize('p', 'fs.read', { path: `${userData}-sibling/x` }).allowed).toBe(true);
			const elsewhere = process.platform === 'win32' ? 'D:/work/x' : '/var/data/x';
			expect(b.authorize('p', 'fs.read', { path: elsewhere }).allowed).toBe(true);
		});

		it('gives a descriptive protected-location reason', () => {
			const d = broker([grant('fs:write')]).authorize('p', 'fs.write', { path: `${userData}/x` });
			expect(d.allowed).toBe(false);
			expect(d.reason).toMatch(/protected location/);
		});

		it('non-fs capabilities are unaffected by the path exclusion', () => {
			const b = broker([grant('notifications:toast')]);
			expect(b.authorize('p', 'notifications.toast', {}).allowed).toBe(true);
		});
	});
});
describeSourceSuite('permission-broker', () => {
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
			expect(broker.authorize('p', 'net.connect', { url: 'wss://evil.example' }).allowed).toBe(
				false
			);
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
});

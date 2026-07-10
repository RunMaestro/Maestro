import { describe, it, expect, vi } from 'vitest';
import { PermissionBroker } from '../../../main/plugins/permission-broker';
import type { PermissionGrant } from '../../../shared/plugins/permissions';

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

	it('per-plugin isolation: grants for one plugin do not leak to another', () => {
		const broker = new PermissionBroker({
			getGrants: (id) => (id === 'trusted' ? [grant('fs:read')] : []),
		});
		expect(broker.authorize('trusted', 'fs.read', { path: '/x' }).allowed).toBe(true);
		expect(broker.authorize('other', 'fs.read', { path: '/x' }).allowed).toBe(false);
	});
});

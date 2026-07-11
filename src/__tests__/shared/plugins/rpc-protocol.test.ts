import { describe, it, expect } from 'vitest';
import {
	HOST_METHOD_CAPABILITY,
	HOST_METHODS,
	extractTarget,
} from '../../../shared/plugins/rpc-protocol';

describe('P0 host RPC contract additions', () => {
	it('maps every new method to the expected capability', () => {
		expect(HOST_METHOD_CAPABILITY['history.list']).toBe('history:read');
		expect(HOST_METHOD_CAPABILITY['history.get']).toBe('history:read');
		expect(HOST_METHOD_CAPABILITY['sessions.create']).toBe('sessions:create');
		expect(HOST_METHOD_CAPABILITY['sessions.update']).toBe('sessions:write');
		expect(HOST_METHOD_CAPABILITY['sessions.delete']).toBe('sessions:write');
		expect(HOST_METHOD_CAPABILITY['tabs.list']).toBe('tabs:manage');
		expect(HOST_METHOD_CAPABILITY['tabs.create']).toBe('tabs:manage');
		expect(HOST_METHOD_CAPABILITY['tabs.focus']).toBe('tabs:manage');
		expect(HOST_METHOD_CAPABILITY['tabs.close']).toBe('tabs:manage');
		expect(HOST_METHOD_CAPABILITY['transcripts.append']).toBe('transcripts:write');
		expect(HOST_METHOD_CAPABILITY['decisions.record']).toBe('decisions:write');
		expect(HOST_METHOD_CAPABILITY['shell.openExternal']).toBe('shell:openExternal');
		expect(HOST_METHOD_CAPABILITY['storage.sql']).toBe('storage:sql');
		expect(HOST_METHOD_CAPABILITY['fs.watch']).toBe('fs:watch');
		expect(HOST_METHOD_CAPABILITY['power.preventSleep']).toBe('power:preventSleep');
		expect(HOST_METHOD_CAPABILITY['power.releaseSleep']).toBe('power:preventSleep');
		expect(HOST_METHOD_CAPABILITY['background.register']).toBe('background:service');
		expect(HOST_METHOD_CAPABILITY['background.unregister']).toBe('background:service');
		expect(HOST_METHOD_CAPABILITY['ui.hostViewUpdate']).toBe('ui:hostView');
		expect(HOST_METHOD_CAPABILITY['ui.hostViewRemove']).toBe('ui:hostView');
	});

	it('includes the P0 methods in the runtime method catalog', () => {
		for (const method of [
			'history.list',
			'sessions.create',
			'tabs.focus',
			'transcripts.append',
			'decisions.record',
			'shell.openExternal',
			'storage.sql',
			'fs.watch',
			'power.preventSleep',
			'background.register',
			'ui.hostViewUpdate',
			'ui.hostViewRemove',
		] as const) {
			expect(HOST_METHODS).toContain(method);
		}
	});

	it('maps the net:connect methods to the net:connect capability', () => {
		expect(HOST_METHOD_CAPABILITY['net.connect']).toBe('net:connect');
		expect(HOST_METHOD_CAPABILITY['net.send']).toBe('net:connect');
		expect(HOST_METHOD_CAPABILITY['net.close']).toBe('net:connect');
		for (const method of ['net.connect', 'net.send', 'net.close'] as const) {
			expect(HOST_METHODS).toContain(method);
		}
	});

	it('extracts the hostname target for net.connect and nothing for net.send/close', () => {
		expect(extractTarget('net.connect', { url: 'wss://gateway.discord.gg/?v=10' })).toBe(
			'gateway.discord.gg'
		);
		expect(extractTarget('net.connect', {})).toBeUndefined();
		// send/close carry only a socketId; the host handler re-authorizes.
		expect(extractTarget('net.send', { socketId: 'sock-1', data: 'hi' })).toBeUndefined();
		expect(extractTarget('net.close', { socketId: 'sock-1' })).toBeUndefined();
	});

	it('extracts only scope-relevant targets for scoped P0 methods', () => {
		expect(extractTarget('fs.watch', { path: '/repo/src' })).toBe('/repo/src');
		expect(extractTarget('shell.openExternal', { url: 'https://docs.example.com/a' })).toBe(
			'docs.example.com'
		);
		expect(extractTarget('transcripts.append', { projectPath: '/repo', sessionId: 's1' })).toBe(
			'/repo'
		);
		expect(extractTarget('storage.sql', { query: 'select 1' })).toBeUndefined();
		expect(extractTarget('background.register', { id: 'svc' })).toBeUndefined();
	});
});

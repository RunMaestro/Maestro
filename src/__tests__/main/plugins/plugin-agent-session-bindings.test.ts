import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginAgentSessionBindings } from '../../../main/plugins/plugin-agent-session-bindings';

const { failRename } = vi.hoisted(() => ({ failRename: { current: false } }));
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		renameSync: (...args: Parameters<typeof actual.renameSync>) => {
			if (failRename.current) throw new Error('simulated rename failure');
			return actual.renameSync(...args);
		},
	};
});

describe('plugin provider session bindings', () => {
	let baseDir: string;

	beforeEach(() => {
		failRename.current = false;
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-plugin-sessions-'));
	});
	afterEach(() => {
		failRename.current = false;
		fs.rmSync(baseDir, { recursive: true, force: true });
	});

	it('persists ownership across host restarts and confines it to plugin and agent', () => {
		const first = new PluginAgentSessionBindings(baseDir);
		first.remember('relay', 'agent-a', 'provider-1');
		const restarted = new PluginAgentSessionBindings(baseDir);
		expect(() => restarted.assertOwned('relay', 'agent-a', 'provider-1')).not.toThrow();
		expect(restarted.hasBindings('relay')).toBe(true);
		expect(restarted.isOwned('relay', 'agent-a', 'provider-1')).toBe(true);
		expect(restarted.isOwned('relay', 'agent-b', 'provider-1')).toBe(false);
		expect(restarted.isOwned('other', 'agent-a', 'provider-1')).toBe(false);
		expect(() => restarted.assertOwned('relay', 'agent-b', 'provider-1')).toThrow(/not owned/);
		expect(() => restarted.assertOwned('other', 'agent-a', 'provider-1')).toThrow(/not owned/);
		expect(() => restarted.assertOwned('relay', 'agent-a', 'unknown')).toThrow(/not owned/);
		expect(() => restarted.remember('relay', 'agent-b', 'provider-1')).toThrow(/another agent/);
	});

	it('removes bindings on plugin uninstall', () => {
		const bindings = new PluginAgentSessionBindings(baseDir);
		bindings.remember('relay', 'agent-a', 'provider-1');
		bindings.purge('relay');
		expect(bindings.hasBindings('relay')).toBe(false);
		expect(() => bindings.assertOwned('relay', 'agent-a', 'provider-1')).toThrow(/not owned/);
	});

	it('evicts the oldest binding when full and keeps the completed session resumable', () => {
		const bindings = new PluginAgentSessionBindings(baseDir, 2);
		bindings.remember('relay', 'agent-a', 'provider-1');
		bindings.remember('relay', 'agent-b', 'provider-2');
		bindings.remember('relay', 'agent-a', 'provider-3');
		expect(() => bindings.assertOwned('relay', 'agent-a', 'provider-1')).toThrow(/not owned/);
		expect(() => bindings.assertOwned('relay', 'agent-b', 'provider-2')).not.toThrow();
		expect(() => bindings.assertOwned('relay', 'agent-a', 'provider-3')).not.toThrow();
		expect(() => bindings.assertOwned('relay', 'agent-b', 'provider-3')).toThrow(/not owned/);
	});

	it('keeps a resumed binding among the newest across host restarts', () => {
		const bindings = new PluginAgentSessionBindings(baseDir, 2);
		bindings.remember('relay', 'agent-a', 'provider-1');
		bindings.remember('relay', 'agent-b', 'provider-2');
		bindings.remember('relay', 'agent-a', 'provider-1');
		bindings.remember('relay', 'agent-c', 'provider-3');
		const restarted = new PluginAgentSessionBindings(baseDir, 2);
		expect(() => restarted.assertOwned('relay', 'agent-a', 'provider-1')).not.toThrow();
		expect(() => restarted.assertOwned('relay', 'agent-b', 'provider-2')).toThrow(/not owned/);
		expect(() => restarted.assertOwned('relay', 'agent-c', 'provider-3')).not.toThrow();
	});

	it('returns a completed resumed answer when recency persistence fails', () => {
		const bindings = new PluginAgentSessionBindings(baseDir, 2);
		bindings.remember('relay', 'agent-a', 'provider-1');
		failRename.current = true;
		expect(() => bindings.remember('relay', 'agent-a', 'provider-1')).not.toThrow();
		expect(() => bindings.remember('relay', 'agent-a', 'provider-2')).toThrow(
			/simulated rename failure/
		);
		failRename.current = false;
		const restarted = new PluginAgentSessionBindings(baseDir, 2);
		expect(() => restarted.assertOwned('relay', 'agent-a', 'provider-1')).not.toThrow();
		expect(() => restarted.assertOwned('relay', 'agent-a', 'provider-2')).toThrow(/not owned/);
	});
});

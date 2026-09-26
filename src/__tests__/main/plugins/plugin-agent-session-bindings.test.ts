import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginAgentSessionBindings } from '../../../main/plugins/plugin-agent-session-bindings';

describe('plugin provider session bindings', () => {
	let baseDir: string;

	beforeEach(() => {
		baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-plugin-sessions-'));
	});
	afterEach(() => fs.rmSync(baseDir, { recursive: true, force: true }));

	it('persists ownership across host restarts and confines it to plugin and agent', () => {
		const first = new PluginAgentSessionBindings(baseDir);
		first.remember('relay', 'agent-a', 'provider-1');
		const restarted = new PluginAgentSessionBindings(baseDir);
		expect(() => restarted.assertOwned('relay', 'agent-a', 'provider-1')).not.toThrow();
		expect(() => restarted.assertOwned('relay', 'agent-b', 'provider-1')).toThrow(/not owned/);
		expect(() => restarted.assertOwned('other', 'agent-a', 'provider-1')).toThrow(/not owned/);
		expect(() => restarted.assertOwned('relay', 'agent-a', 'unknown')).toThrow(/not owned/);
		expect(() => restarted.remember('relay', 'agent-b', 'provider-1')).toThrow(/another agent/);
	});

	it('removes bindings on plugin uninstall', () => {
		const bindings = new PluginAgentSessionBindings(baseDir);
		bindings.remember('relay', 'agent-a', 'provider-1');
		bindings.purge('relay');
		expect(() => bindings.assertOwned('relay', 'agent-a', 'provider-1')).toThrow(/not owned/);
	});
});

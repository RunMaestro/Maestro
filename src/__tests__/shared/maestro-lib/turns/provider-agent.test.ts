/**
 * Where a provider's binary is on this machine, and the launch description built from it: the
 * order of the search is the desktop's, and a custom path that does not exist is ignored.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveProviderAgent } from '../../../../shared/maestro-lib/turns/provider-agent';
import {
	locateProviderBinary,
	type BinaryProbe,
} from '../../../../shared/maestro-lib/turns/provider-binary';

/** A probe over a fixed set of paths; a bare name resolves under /usr/bin when it is "on PATH". */
const probeOf = (existing: string[], onPath: string[] = []): BinaryProbe & { calls: string[] } => {
	const calls: string[] = [];
	const probe = (async (binaryName: string, customPath?: string) => {
		calls.push(customPath ?? binaryName);
		if (customPath)
			return existing.includes(customPath) ? { exists: true, path: customPath } : { exists: false };
		return onPath.includes(binaryName)
			? { exists: true, path: `/usr/bin/${binaryName}` }
			: { exists: false };
	}) as BinaryProbe & { calls: string[] };
	probe.calls = calls;
	return probe;
};

describe('locateProviderBinary', () => {
	const claude = { binaryName: 'claude' };

	it('prefers the agent’s own path, then the provider’s, then PATH', async () => {
		const probe = probeOf(['/agent/claude', '/provider/claude'], ['claude']);
		expect(
			await locateProviderBinary(claude, {
				agentCustomPath: '/agent/claude',
				providerCustomPath: '/provider/claude',
				sshEnabled: false,
				probe,
			})
		).toBe('/agent/claude');
		expect(probe.calls).toEqual(['/agent/claude']);

		expect(
			await locateProviderBinary(claude, {
				agentCustomPath: '/missing',
				providerCustomPath: '/provider/claude',
				sshEnabled: false,
				probe: probeOf(['/provider/claude'], ['claude']),
			})
		).toBe('/provider/claude');

		expect(
			await locateProviderBinary(claude, {
				providerCustomPath: '/missing',
				sshEnabled: false,
				probe: probeOf([], ['claude']),
			})
		).toBe('/usr/bin/claude');
	});

	it('answers nothing when the provider is not installed', async () => {
		expect(
			await locateProviderBinary(claude, { sshEnabled: false, probe: probeOf([]) })
		).toBeUndefined();
	});

	it('probes nothing for an SSH agent: the remote’s own binary runs there', async () => {
		const probe = probeOf([]);
		expect(await locateProviderBinary(claude, { sshEnabled: true, probe })).toBe('claude');
		expect(
			await locateProviderBinary(claude, { sshEnabled: true, agentCustomPath: '/r/claude', probe })
		).toBe('/r/claude');
		expect(probe.calls).toEqual([]);
	});
});

describe('resolveProviderAgent', () => {
	let dir: string;
	let configs: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-provider-agent-'));
		configs = path.join(dir, 'maestro-agent-configs.json');
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('builds the launch description of an installed provider', async () => {
		const agent = await resolveProviderAgent('claude-code', {
			paths: { agentConfigsFile: configs },
			probe: probeOf([], ['claude']),
		});
		expect(agent).toMatchObject({
			id: 'claude-code',
			binaryName: 'claude',
			available: true,
			path: '/usr/bin/claude',
		});
		expect(agent?.capabilities).toBeTruthy();
	});

	it('honors the provider’s custom path from Settings -> Agents', async () => {
		fs.writeFileSync(
			configs,
			JSON.stringify({ configs: { 'claude-code': { customPath: '/opt/claude' } } })
		);
		const agent = await resolveProviderAgent('claude-code', {
			paths: { agentConfigsFile: configs },
			probe: probeOf(['/opt/claude']),
		});
		expect(agent).toMatchObject({ available: true, path: '/opt/claude' });
	});

	it('says a missing binary is not available, rather than failing', async () => {
		const agent = await resolveProviderAgent('claude-code', {
			paths: { agentConfigsFile: configs },
			probe: probeOf([]),
		});
		expect(agent?.available).toBe(false);
		expect(agent?.path).toBeUndefined();
	});

	it('answers null for a provider this build does not know', async () => {
		expect(
			await resolveProviderAgent('no-such-provider', { paths: { agentConfigsFile: configs } })
		).toBeNull();
	});

	it('reads a corrupt configs file as nothing set', async () => {
		fs.writeFileSync(configs, '{not json');
		const agent = await resolveProviderAgent('claude-code', {
			paths: { agentConfigsFile: configs },
			probe: probeOf([], ['claude']),
		});
		expect(agent?.available).toBe(true);
	});
});

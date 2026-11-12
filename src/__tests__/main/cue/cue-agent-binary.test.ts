/**
 * @file cue-agent-binary.test.ts
 * @description Which binary a Cue prompt run executes: the agent's own custom
 * path, then the provider's, then the detector's.
 */

import { describe, it, expect, vi } from 'vitest';
import { resolveCueAgentBinary } from '../../../main/cue/cue-agent-binary';

const found = (p: string) => vi.fn(async () => ({ exists: true, path: p }));
const missing = () => vi.fn(async () => ({ exists: false }));
const detected = (p?: string) => vi.fn(async () => p);

describe('resolveCueAgentBinary', () => {
	it("prefers the agent's own custom path over the provider's and the detector's", async () => {
		const getDetectedPath = detected('/usr/local/bin/claude');

		const result = await resolveCueAgentBinary({
			sessionCustomPath: '/opt/pinned/claude',
			providerCustomPath: '/opt/provider/claude',
			sshEnabled: false,
			getDetectedPath,
			checkPath: found('/opt/pinned/claude'),
		});

		expect(result).toBe('/opt/pinned/claude');
		expect(getDetectedPath).not.toHaveBeenCalled();
	});

	it('uses the path the check resolved, not the one that was typed', async () => {
		const result = await resolveCueAgentBinary({
			sessionCustomPath: '~/bin/claude',
			sshEnabled: false,
			getDetectedPath: detected(),
			checkPath: found('/Users/me/bin/claude'),
		});

		expect(result).toBe('/Users/me/bin/claude');
	});

	it("falls back to the provider's path and warns when the agent's own path is invalid", async () => {
		const onWarn = vi.fn();

		const result = await resolveCueAgentBinary({
			sessionCustomPath: '/gone/claude',
			providerCustomPath: '/opt/provider/claude',
			sshEnabled: false,
			getDetectedPath: detected('/usr/local/bin/claude'),
			checkPath: missing(),
			onWarn,
		});

		expect(result).toBe('/opt/provider/claude');
		expect(onWarn).toHaveBeenCalledTimes(1);
		expect(onWarn.mock.calls[0][0]).toContain('/gone/claude');
	});

	it("uses the provider's path when the agent has none of its own", async () => {
		const checkPath = found('/unused');

		const result = await resolveCueAgentBinary({
			providerCustomPath: '/opt/provider/claude',
			sshEnabled: false,
			getDetectedPath: detected('/usr/local/bin/claude'),
			checkPath,
		});

		expect(result).toBe('/opt/provider/claude');
		expect(checkPath).not.toHaveBeenCalled();
	});

	it('uses the detected path when nothing is configured', async () => {
		const result = await resolveCueAgentBinary({
			sshEnabled: false,
			getDetectedPath: detected('/usr/local/bin/claude'),
		});

		expect(result).toBe('/usr/local/bin/claude');
	});

	it('returns undefined when the provider is not installed', async () => {
		const result = await resolveCueAgentBinary({
			sshEnabled: false,
			getDetectedPath: detected(undefined),
		});

		expect(result).toBeUndefined();
	});

	it("never checks or uses the agent's own path over SSH: it names a remote file", async () => {
		const checkPath = found('/remote/claude');

		const result = await resolveCueAgentBinary({
			sessionCustomPath: '/remote/claude',
			sshEnabled: true,
			getDetectedPath: detected('/usr/local/bin/claude'),
			checkPath,
		});

		expect(result).toBe('/usr/local/bin/claude');
		expect(checkPath).not.toHaveBeenCalled();
	});
});

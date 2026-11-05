/**
 * @file cue-agent-binary.test.ts
 * @description Which binary a Cue prompt run executes: the agent's own custom
 * path, then the provider's, then local detection or the remote's bare binary.
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

	it.each(['/usr/local/bin/claude', undefined])(
		'falls back to local detection (%s) after an invalid agent path without a provider override',
		async (detectedPath) => {
			const checkPath = missing();
			const getDetectedPath = detected(detectedPath);
			const onWarn = vi.fn();

			const result = await resolveCueAgentBinary({
				sessionCustomPath: '/gone/claude',
				sshEnabled: false,
				getDetectedPath,
				checkPath,
				onWarn,
			});

			expect(result).toBe(detectedPath);
			expect(checkPath).toHaveBeenCalledExactlyOnceWith('/gone/claude');
			expect(getDetectedPath).toHaveBeenCalledTimes(1);
			expect(onWarn).toHaveBeenCalledTimes(1);
			expect(onWarn.mock.calls[0][0]).toContain('/gone/claude');
		}
	);

	it.each([
		{
			name: 'session override wins over provider override',
			sessionCustomPath: '~/Session Tools/grok',
			providerCustomPath: '/opt/Provider Tools/grok',
			expected: '~/Session Tools/grok',
		},
		{
			name: 'provider override without a session override',
			sessionCustomPath: undefined,
			providerCustomPath: '/opt/Provider Tools/grok',
			expected: '/opt/Provider Tools/grok',
		},
		{
			name: 'empty session override falls back to provider',
			sessionCustomPath: '',
			providerCustomPath: '~/Provider Tools/grok',
			expected: '~/Provider Tools/grok',
		},
		{
			name: 'leading and trailing spaces are preserved',
			sessionCustomPath: ' /remote/Session Tools/grok ',
			providerCustomPath: '/opt/Provider Tools/grok',
			expected: ' /remote/Session Tools/grok ',
		},
		{
			name: 'no overrides leaves remote binary selection to the planner',
			sessionCustomPath: undefined,
			providerCustomPath: undefined,
			expected: undefined,
		},
		{
			name: 'empty overrides leave remote binary selection to the planner',
			sessionCustomPath: '',
			providerCustomPath: '',
			expected: undefined,
		},
	])('resolves SSH $name without consulting the local host', async (testCase) => {
		const checkPath = found('/local/checked/grok');
		const getDetectedPath = detected('/local/detected/grok');
		const onWarn = vi.fn();

		const result = await resolveCueAgentBinary({
			sessionCustomPath: testCase.sessionCustomPath,
			providerCustomPath: testCase.providerCustomPath,
			sshEnabled: true,
			getDetectedPath,
			checkPath,
			onWarn,
		});

		expect(result).toBe(testCase.expected);
		expect(checkPath).not.toHaveBeenCalled();
		expect(getDetectedPath).not.toHaveBeenCalled();
		expect(onWarn).not.toHaveBeenCalled();
	});
});

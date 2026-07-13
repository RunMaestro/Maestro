/**
 * @file plugin-sandbox-host-isolation.test.ts
 * @description Regression lock for the OS-agnostic part of the tier-1 sandbox
 *   threat model. The `vm` realm is documented as escapable (the real boundary
 *   is the separate utilityProcess + the default-deny broker + signature/consent
 *   gating; full closure is the per-OS Phase-3 sandbox). This test pins the one
 *   cross-platform isolation property we DO rely on: the child utilityProcess is
 *   forked with an EMPTY environment, so even an escaped plugin cannot read the
 *   parent's secrets/tokens out of process.env. If a future change drops the
 *   `env: {}` option, this fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { forkMock, proc } = vi.hoisted(() => {
	const proc = {
		postMessage: vi.fn(),
		on: vi.fn(),
		kill: vi.fn(),
	};
	const forkMock = vi.fn(() => proc);
	return { forkMock, proc };
});

vi.mock('electron', () => ({
	utilityProcess: { fork: forkMock },
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PluginSandboxHost } from '../../../main/plugins/plugin-sandbox-host';
import type { PermissionBroker } from '../../../main/plugins/permission-broker';

const allowAll = {
	authorize: () => ({ allowed: true }),
	authorizeInvocation: () => ({ allowed: true }),
} as unknown as PermissionBroker;

describe('PluginSandboxHost child isolation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('forks the child with an EMPTY env so it inherits no Maestro secrets', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-iso-'));
		fs.writeFileSync(path.join(dir, 'entry.js'), '// entry', 'utf-8');
		try {
			const host = new PluginSandboxHost({ broker: allowAll, handlers: {} });
			host.start('p', '// entry', {
				ownerPluginId: 'p',
				generation: 1,
				artifactDigest: 'a'.repeat(64),
				authorizationContentHash: 'c'.repeat(64),
				signerKeyId: 'test-signer',
			});
			expect(forkMock).toHaveBeenCalledTimes(1);
			const args = forkMock.mock.calls[0] as unknown[];
			const opts = args[2] as { env?: unknown; serviceName?: unknown };
			expect(opts).toBeDefined();
			// The load-bearing property: no inherited environment.
			expect(opts.env).toEqual({});
			expect(String(opts.serviceName)).toContain('maestro-plugin-p');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// Source: src/__tests__/main/plugins/plugin-sandbox-host-isolation.test.ts
// Source: src/__tests__/main/plugins/plugin-signature.test.ts
// Source: src/__tests__/main/plugins/plugin-tool-run-identity.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginSandboxHost } from '../../../main/plugins/plugin-sandbox-host';
import type { PermissionBroker } from '../../../main/plugins/permission-broker';
import { afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import { createHash } from 'crypto';
import { sign as cryptoSign } from 'crypto';
import { verifyPluginSignature } from '../../../main/plugins/plugin-signature';
import { buildSigningPayload } from '../../../shared/plugins/signing';
import { SIGNATURE_FILENAME } from '../../../shared/plugins/signing';
import { HEADLESS_RUN_COMPLETION_TIMEOUT_MS } from '../../../shared/plugins/headless-agent-timeouts';
import { PluginToolRunIdentity } from '../../../main/plugins/plugin-tool-run-identity';
import { createPluginRunProofFile } from '../../../main/plugins/plugin-tool-run-identity';
import { pluginToolEvidenceMessage } from '../../../main/plugins/plugin-tool-run-identity';
import { pluginToolEvidenceProblem } from '../../../main/plugins/plugin-tool-run-identity';
import type { PluginToolRunEvidence } from '../../../main/plugins/plugin-tool-run-identity';
import { removePluginRunProofFile } from '../../../main/plugins/plugin-tool-run-identity';
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
describeSourceSuite('plugin-sandbox-host-isolation', () => {
	const allowAll = { authorize: () => ({ allowed: true }) } as unknown as PermissionBroker;

	describe('PluginSandboxHost child isolation', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('forks the child with an EMPTY env so it inherits no Maestro secrets', () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-iso-'));
			fs.writeFileSync(path.join(dir, 'entry.js'), '// entry', 'utf-8');
			try {
				const host = new PluginSandboxHost({ broker: allowAll, handlers: {} });
				host.start('p', dir, 'entry.js');
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
});
describeSourceSuite('plugin-signature', () => {
	function sha256(buf: Buffer): string {
		return createHash('sha256').update(buf).digest('hex');
	}

	/** Write a signature.json over the current files in `dir` using `privateKey`. */
	function signDir(
		dir: string,
		publicKeyB64: string,
		privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']
	): void {
		const files: Record<string, string> = {};
		for (const name of fs.readdirSync(dir)) {
			if (name === SIGNATURE_FILENAME) continue;
			files[name] = sha256(fs.readFileSync(path.join(dir, name)));
		}
		const payload = buildSigningPayload(files);
		const signature = cryptoSign(null, Buffer.from(payload, 'utf-8'), privateKey).toString(
			'base64'
		);
		fs.writeFileSync(
			path.join(dir, SIGNATURE_FILENAME),
			JSON.stringify({ algorithm: 'ed25519', publicKey: publicKeyB64, signature, files })
		);
	}

	describe('verifyPluginSignature', () => {
		let dir: string;
		const { publicKey, privateKey } = generateKeyPairSync('ed25519');
		const publicKeyB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-sig-'));
			fs.writeFileSync(path.join(dir, 'plugin.json'), '{"id":"com.a","name":"A"}');
			fs.writeFileSync(path.join(dir, 'entry.js'), 'module.exports = {}');
		});
		afterEach(() => {
			fs.rmSync(dir, { recursive: true, force: true });
		});

		it('reports unsigned when no signature.json exists', () => {
			expect(verifyPluginSignature(dir, []).status).toBe('unsigned');
		});

		it('reports trusted for a valid signature from a trusted key', () => {
			signDir(dir, publicKeyB64, privateKey);
			const check = verifyPluginSignature(dir, [publicKeyB64]);
			expect(check.status).toBe('trusted');
			expect(check.signerKey).toBe(publicKeyB64);
		});

		it('reports untrusted for a valid signature from an unknown key', () => {
			signDir(dir, publicKeyB64, privateKey);
			expect(verifyPluginSignature(dir, []).status).toBe('untrusted');
		});

		it('reports invalid when a file is modified after signing', () => {
			signDir(dir, publicKeyB64, privateKey);
			fs.writeFileSync(path.join(dir, 'entry.js'), 'module.exports = { evil: true }');
			const check = verifyPluginSignature(dir, [publicKeyB64]);
			expect(check.status).toBe('invalid');
		});

		it('reports invalid when an unlisted file is ADDED after signing', () => {
			signDir(dir, publicKeyB64, privateKey);
			fs.writeFileSync(path.join(dir, 'sneaky.js'), 'module.exports = {}');
			expect(verifyPluginSignature(dir, [publicKeyB64]).status).toBe('invalid');
		});

		it('reports invalid when a file is removed after signing', () => {
			signDir(dir, publicKeyB64, privateKey);
			fs.rmSync(path.join(dir, 'entry.js'));
			expect(verifyPluginSignature(dir, [publicKeyB64]).status).toBe('invalid');
		});

		it('reports invalid when the tree contains a symlink (cannot be signed safely)', () => {
			signDir(dir, publicKeyB64, privateKey);
			// Add a symlink AFTER signing; it is not in the signed set and must fail.
			try {
				fs.symlinkSync(os.tmpdir(), path.join(dir, 'link'));
			} catch {
				// Some CI/Windows environments forbid symlink creation; skip if so.
				return;
			}
			expect(verifyPluginSignature(dir, [publicKeyB64]).status).toBe('invalid');
		});

		it('reports invalid for a forged signature from a different key', () => {
			const other = generateKeyPairSync('ed25519');
			// sign with `other` but claim the trusted publicKeyB64
			const files: Record<string, string> = {};
			for (const name of fs.readdirSync(dir))
				files[name] = sha256(fs.readFileSync(path.join(dir, name)));
			const payload = buildSigningPayload(files);
			const signature = cryptoSign(null, Buffer.from(payload), other.privateKey).toString('base64');
			fs.writeFileSync(
				path.join(dir, SIGNATURE_FILENAME),
				JSON.stringify({ algorithm: 'ed25519', publicKey: publicKeyB64, signature, files })
			);
			expect(verifyPluginSignature(dir, [publicKeyB64]).status).toBe('invalid');
		});
	});
});
describeSourceSuite('plugin-tool-run-identity', () => {
	describe('PluginToolRunIdentity', () => {
		it('retains host-stamped run provenance and treats unspecified provenance as unattended', () => {
			const runs = new PluginToolRunIdentity();
			try {
				const unknown = runs.issue('agent-a');
				const interactive = runs.issue('agent-a', undefined, undefined, false);
				const automatic = runs.issue('agent-a', undefined, undefined, true);
				expect(runs.resolveVerified(unknown).unattended).toBe(true);
				expect(runs.resolveVerified(interactive).unattended).toBe(false);
				expect(runs.resolveVerified(automatic).unattended).toBe(true);
				expect(Object.isFrozen(runs.resolveVerified(interactive))).toBe(true);
			} finally {
				runs.stop();
			}
		});

		it('binds distinct local runs to exact agents and revokes a completed run', () => {
			const runs = new PluginToolRunIdentity();
			const a = runs.issue('agent-a');
			const b = runs.issue('agent-b');
			expect(a).not.toBe(b);
			expect(runs.resolve(a)).toEqual({ callerAgentId: 'agent-a' });
			expect(runs.resolve(b)).toEqual({ callerAgentId: 'agent-b' });
			expect(runs.resolve('agent-b')).toEqual({ callerAgentId: null });
			runs.revoke(a);
			expect(runs.resolve(a)).toEqual({ callerAgentId: null });
			expect(runs.resolve(b)).toEqual({ callerAgentId: 'agent-b' });
		});

		it('expires a proof even when its bridge remains connected', () => {
			vi.useFakeTimers();
			try {
				const runs = new PluginToolRunIdentity();
				const token = runs.issue('agent-a', 1_000);
				vi.advanceTimersByTime(1_001);
				expect(runs.resolve(token)).toEqual({ callerAgentId: null });
			} finally {
				vi.useRealTimers();
			}
		});

		it('keeps headless identity and proof through six hours and expires both at six hours plus cleanup', () => {
			vi.useFakeTimers();
			const runs = new PluginToolRunIdentity();
			const token = runs.issue('relay-agent', HEADLESS_RUN_COMPLETION_TIMEOUT_MS);
			const file = createPluginRunProofFile(token, HEADLESS_RUN_COMPLETION_TIMEOUT_MS);
			try {
				vi.advanceTimersByTime(6 * 60 * 60_000);
				expect(runs.resolve(token)).toEqual({ callerAgentId: 'relay-agent' });
				expect(fs.existsSync(file)).toBe(true);
				vi.advanceTimersByTime(60_000);
				expect(runs.resolve(token)).toEqual({ callerAgentId: null });
				expect(fs.existsSync(file)).toBe(false);
			} finally {
				if (fs.existsSync(file)) removePluginRunProofFile(file);
				vi.useRealTimers();
			}
		});

		it('keeps Cue identity and its proof file through the 24-hour run budget', () => {
			vi.useFakeTimers();
			const runs = new PluginToolRunIdentity();
			const ttlMs = 24 * 60 * 60 * 1000 + 60_000;
			const token = runs.issue('cue-agent', ttlMs);
			const file = createPluginRunProofFile(token, ttlMs);
			try {
				vi.advanceTimersByTime(24 * 60 * 60 * 1000);
				expect(runs.resolve(token)).toEqual({ callerAgentId: 'cue-agent' });
				expect(fs.existsSync(file)).toBe(true);
				vi.advanceTimersByTime(60_001);
				expect(runs.resolve(token)).toEqual({ callerAgentId: null });
				expect(fs.existsSync(file)).toBe(false);
			} finally {
				if (fs.existsSync(file)) removePluginRunProofFile(file);
				vi.useRealTimers();
			}
		});

		it('does not arm arbitrary tool receipts when issuing a host authority proof', () => {
			const runs = new PluginToolRunIdentity();
			const controller = new AbortController();
			const proof = runs.issue('agent-a', { signal: controller.signal, assertActive() {} });
			try {
				runs.recordReceipt(proof, 'sh.maestro.relay/send', { messageIds: ['123'] });
				expect(runs.getReceipts(proof)).toEqual([]);
				expect(runs.hasReceiptOverflowed(proof)).toBe(false);
				expect(runs.resolveVerified(proof).callerAgentId).toBe('agent-a');
			} finally {
				runs.revoke(proof);
			}
		});
		it('records only validated IDs from the exact armed tool and run', () => {
			const runs = new PluginToolRunIdentity();
			const a = runs.issue('agent-a', 60_000, 'sh.maestro.relay/send');
			const b = runs.issue('agent-b', 60_000, 'sh.maestro.relay/send');
			const unarmed = runs.issue('agent-c');
			try {
				runs.recordReceipt(a, 'other/send', { messageIds: ['101'] });
				runs.recordReceipt(a, 'sh.maestro.relay/send', { messageIds: [] });
				runs.recordReceipt(a, 'sh.maestro.relay/send', { messageIds: ['invented'] });
				runs.recordReceipt(a, 'sh.maestro.relay/send', {
					success: false,
					messageIds: ['103'],
				});
				runs.recordReceipt(a, 'sh.maestro.relay/send', {
					error: 'Discord rejected the destination',
					messageIds: ['103'],
				});
				runs.recordReceipt(unarmed, 'sh.maestro.relay/send', { messageIds: ['102'] });
				expect(runs.getReceipts(a)).toEqual([]);
				runs.recordReceipt(a, 'sh.maestro.relay/send', {
					messageIds: ['103'],
					secret: 'must not be retained',
				});
				runs.recordReceipt(b, 'sh.maestro.relay/send', { messageIds: ['104'] });
				const [receipt] = runs.getReceipts(a);
				expect(receipt).toEqual({
					runId: expect.stringMatching(/^[0-9a-f]{32}$/),
					agentId: 'agent-a',
					toolId: 'sh.maestro.relay/send',
					messageIds: ['103'],
				});
				expect(runs.getReceipts(b)[0]).toMatchObject({ agentId: 'agent-b', messageIds: ['104'] });
				expect(runs.getReceipts(b)[0].runId).not.toBe(receipt.runId);
				receipt.messageIds[0] = '999';
				expect(runs.getReceipts(a)[0].messageIds).toEqual(['103']);
			} finally {
				runs.revoke(a);
				runs.revoke(b);
				runs.revoke(unarmed);
			}
			expect(runs.getReceipts(a)).toEqual([]);
		});

		it('retains the bounded verified receipts after collection overflows', () => {
			const runs = new PluginToolRunIdentity();
			const token = runs.issue('agent-a', 1_000, 'sh.maestro.relay/send');
			expect(runs.hasReceiptOverflowed(token)).toBe(false);
			for (let index = 0; index < 18; index++) {
				runs.recordReceipt(token, 'sh.maestro.relay/send', {
					messageIds: [String(100 + index)],
				});
			}
			const receipts = runs.getReceipts(token);
			expect(runs.hasReceiptOverflowed(token)).toBe(true);
			expect(receipts).toHaveLength(16);
			expect(receipts[0].messageIds).toEqual(['100']);
			expect(receipts[15].messageIds).toEqual(['115']);
			receipts[0].messageIds[0] = '999';
			expect(runs.getReceipts(token)[0].messageIds).toEqual(['100']);
			runs.revoke(token);
			expect(runs.getReceipts(token)).toEqual([]);
			expect(runs.hasReceiptOverflowed(token)).toBe(false);
		});

		it('does not accept receipts after the run proof expires', () => {
			vi.useFakeTimers();
			try {
				const runs = new PluginToolRunIdentity();
				const token = runs.issue('agent-a', 1_000, 'sh.maestro.relay/send');
				vi.advanceTimersByTime(1_001);
				runs.recordReceipt(token, 'sh.maestro.relay/send', { messageIds: ['105'] });
				expect(runs.getReceipts(token)).toEqual([]);
			} finally {
				vi.useRealTimers();
			}
		});

		it('preserves an unregistered lookalike proof directory during cleanup', () => {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-plugin-run-'));
			const file = path.join(dir, 'proof');
			try {
				fs.writeFileSync(file, 'foreign fixture');
				removePluginRunProofFile(file);
				expect(fs.readFileSync(file, 'utf8')).toBe('foreign fixture');
			} finally {
				fs.rmSync(dir, { recursive: true, force: true });
			}
		});

		it('writes the proof to an owner-only local file and removes it', () => {
			const file = createPluginRunProofFile('secret-proof', 1_000);
			try {
				expect(fs.readFileSync(file, 'utf8')).toBe('secret-proof');
				if (process.platform !== 'win32') {
					expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
					expect(fs.statSync(file).mode & 0o777).toBe(0o600);
				}
			} finally {
				removePluginRunProofFile(file);
			}
			expect(fs.existsSync(file)).toBe(false);
		});
	});

	// The host-observed evidence a Grok required run is judged by
	// (toolEvidence 'observed'). Advertisement is never execution, and nothing a
	// provider or a tool result says can stand in for the host's own record.
	describe('host-observed plugin tool evidence', () => {
		const TOOL = 'sh.maestro.relay/send';
		const evidence = (over: Partial<PluginToolRunEvidence> = {}): PluginToolRunEvidence => ({
			advertisements: 1,
			advertisedToolIds: [TOOL],
			receipts: [{ runId: 'r'.repeat(32), agentId: 'agent-a', toolId: TOOL, messageIds: ['101'] }],
			receiptsOverflowed: false,
			...over,
		});
		const judge = (ev: PluginToolRunEvidence, receiptToolId: string | null = TOOL) =>
			pluginToolEvidenceProblem({
				requirePluginTools: true,
				receiptToolId: receiptToolId ?? undefined,
				agentId: 'agent-a',
				evidence: ev,
			});

		it('accumulates listings across reconnects and keeps only bounded, well-formed tool names', () => {
			const runs = new PluginToolRunIdentity();
			const token = runs.issue('agent-a', 60_000, TOOL);
			try {
				runs.recordAdvertisement(token, [TOOL, '', 'x'.repeat(201), 42 as unknown as string]);
				runs.recordAdvertisement(token, ['other/tool', TOOL]);
				const ev = runs.getEvidence(token);
				expect(ev.advertisements).toBe(2);
				expect(ev.advertisedToolIds).toEqual([TOOL, 'other/tool']);
				runs.recordAdvertisement(
					token,
					Array.from({ length: 400 }, (_, i) => `bulk/${i}`)
				);
				expect(runs.getEvidence(token).advertisedToolIds).toHaveLength(256);
			} finally {
				runs.revoke(token);
			}
		});

		it('records no listing for an unknown, malformed, revoked or expired proof', () => {
			vi.useFakeTimers();
			try {
				const runs = new PluginToolRunIdentity();
				const expired = runs.issue('agent-a', 1_000, TOOL);
				const revoked = runs.issue('agent-a', 60_000, TOOL);
				runs.revoke(revoked);
				vi.advanceTimersByTime(1_001);
				for (const token of [expired, revoked, 'f'.repeat(64), 'not-a-token', undefined]) {
					runs.recordAdvertisement(token, [TOOL]);
					expect(runs.getEvidence(token)).toEqual({
						advertisements: 0,
						advertisedToolIds: [],
						receipts: [],
						receiptsOverflowed: false,
					});
				}
			} finally {
				vi.useRealTimers();
			}
		});

		it('never exposes the proof token or extra tool-result fields through the evidence record', () => {
			const runs = new PluginToolRunIdentity();
			const token = runs.issue('agent-a', 60_000, TOOL);
			try {
				runs.recordAdvertisement(token, [TOOL]);
				runs.recordReceipt(token, TOOL, {
					messageIds: ['101'],
					apiKey: 'xai-secret-credential',
					token,
				});
				const serialized = JSON.stringify(runs.getEvidence(token));
				expect(serialized).not.toContain(token);
				expect(serialized).not.toContain('xai-secret-credential');
				expect(runs.getEvidence(token).receipts).toEqual([
					expect.objectContaining({ agentId: 'agent-a', toolId: TOOL, messageIds: ['101'] }),
				]);
			} finally {
				runs.revoke(token);
			}
		});

		it('a denied or failed tool call leaves no receipt, so the run reads receipt-missing', () => {
			const runs = new PluginToolRunIdentity();
			const token = runs.issue('agent-a', 60_000, TOOL);
			try {
				runs.recordAdvertisement(token, [TOOL]);
				for (const denied of [
					{ success: false, messageIds: ['101'] },
					{ ok: false, messageIds: ['101'] },
					{ error: 'permission denied by policy', messageIds: ['101'] },
					{ messageIds: ['fabricated'] },
					'{"messageIds":["101"]}',
					null,
				]) {
					runs.recordReceipt(token, TOOL, denied);
				}
				expect(judge(runs.getEvidence(token))).toBe('receipt-missing');
			} finally {
				runs.revoke(token);
			}
		});

		it('judges absent listings, absent tools and absent receipts as failures, never success', () => {
			expect(judge(evidence({ advertisements: 0, advertisedToolIds: [] }))).toBe(
				'tools-not-advertised'
			);
			expect(judge(evidence({ advertisedToolIds: [] }))).toBe('tools-not-advertised');
			expect(judge(evidence({ advertisements: 0 }))).toBe('tools-not-advertised');
			expect(judge(evidence({ advertisedToolIds: ['other/tool'] }))).toBe(
				'required-tool-not-advertised'
			);
			expect(judge(evidence({ receipts: [] }))).toBe('receipt-missing');
			expect(
				judge(evidence({ receipts: [{ ...evidence().receipts[0], agentId: 'agent-b' }] }))
			).toBe('receipt-missing');
			expect(
				judge(evidence({ receipts: [{ ...evidence().receipts[0], toolId: 'other/tool' }] }))
			).toBe('receipt-missing');
			expect(judge(evidence({ receipts: [{ ...evidence().receipts[0], messageIds: [] }] }))).toBe(
				'receipt-missing'
			);
			expect(judge(evidence({ receiptsOverflowed: true }))).toBe('receipt-limit-exceeded');
			expect(judge(evidence())).toBeNull();
		});

		it('required tools without a receipt need a non-empty listing; an unrequired run is not judged', () => {
			expect(judge(evidence({ receipts: [] }), null)).toBeNull();
			expect(judge(evidence({ advertisedToolIds: [] }), null)).toBe('tools-not-advertised');
			expect(
				pluginToolEvidenceProblem({
					requirePluginTools: false,
					agentId: 'agent-a',
					evidence: evidence({ advertisements: 0, advertisedToolIds: [], receipts: [] }),
				})
			).toBeNull();
		});

		it('names each failure without echoing anything but the requested tool id', () => {
			expect(pluginToolEvidenceMessage('tools-not-advertised')).toMatch(/never listed/);
			expect(pluginToolEvidenceMessage('required-tool-not-advertised', TOOL)).toContain(
				`"${TOOL}"`
			);
			expect(pluginToolEvidenceMessage('receipt-missing', TOOL)).toBe(
				'Required plugin tool returned no delivery receipt'
			);
			expect(pluginToolEvidenceMessage('receipt-limit-exceeded')).toMatch(/limit exceeded/);
		});
	});
});

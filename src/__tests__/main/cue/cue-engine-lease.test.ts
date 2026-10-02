// @vitest-environment node
/**
 * Tests for src/main/cue/cue-engine-lease.ts
 *
 * Real files in a temp dir and real child processes as the "other Maestro":
 * whether a holder is alive, dead, or an unrelated process that inherited its
 * pid can only be shown with actual processes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	createCueEngineLease,
	type CueEngineLeaseRecord,
} from '../../../main/cue/cue-engine-lease';
import { readProcessStartToken } from '../../../shared/processIdentity';
import { bundleForChildProcess, runChildren } from '../../helpers/childProcessBundle';

const tokensSupported = process.platform === 'linux' || process.platform === 'darwin';

function readRecord(lockPath: string): CueEngineLeaseRecord {
	return JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
}

describe('cue-engine-lease', () => {
	let dir: string;
	let lockPath: string;
	const children: ChildProcess[] = [];

	/** A live process standing in for another Maestro holding the lease. */
	function otherProcess(): ChildProcess {
		const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
			stdio: 'ignore',
		});
		children.push(child);
		return child;
	}

	function writeHolder(overrides: Partial<CueEngineLeaseRecord>): CueEngineLeaseRecord {
		const record: CueEngineLeaseRecord = {
			pid: 1,
			instanceId: 'other-instance',
			acquiredAt: Date.now(),
			heartbeatAt: Date.now(),
			...overrides,
		};
		fs.writeFileSync(lockPath, JSON.stringify(record));
		return record;
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-cue-lease-'));
		lockPath = path.join(dir, 'cue-engine.lock');
	});

	afterEach(() => {
		for (const child of children.splice(0)) child.kill('SIGKILL');
		fs.rmSync(dir, { recursive: true, force: true });
	});

	describe('acquire', () => {
		it('creates the lease with this process identity', () => {
			const lease = createCueEngineLease({ lockPath, version: '1.2.3' });
			expect(lease.acquire()).toEqual({ ok: true });

			const record = readRecord(lockPath);
			expect(record.pid).toBe(process.pid);
			expect(record.version).toBe('1.2.3');
			expect(record.startToken).toBe(readProcessStartToken(process.pid) ?? undefined);
			expect(record.heartbeatAt).toBe(record.acquiredAt);
		});

		it('is idempotent while held', () => {
			const lease = createCueEngineLease({ lockPath });
			lease.acquire();
			const first = readRecord(lockPath).instanceId;
			expect(lease.acquire()).toEqual({ ok: true });
			expect(readRecord(lockPath).instanceId).toBe(first);
		});

		it('refuses while another live, verified process holds it', () => {
			const other = otherProcess();
			const holder = writeHolder({
				pid: other.pid!,
				startToken: readProcessStartToken(other.pid!) ?? undefined,
				version: '9.9.9',
			});

			const result = createCueEngineLease({ lockPath }).acquire();

			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.holder?.instanceId).toBe(holder.instanceId);
				expect(result.reason).toContain(`pid ${other.pid}`);
				expect(result.reason).toContain('v9.9.9');
			}
			expect(readRecord(lockPath).instanceId).toBe(holder.instanceId);
		});

		it.runIf(tokensSupported)(
			'never reclaims a verified live holder on heartbeat age alone (sleep-safe)',
			() => {
				const other = otherProcess();
				writeHolder({
					pid: other.pid!,
					startToken: readProcessStartToken(other.pid!)!,
					heartbeatAt: Date.now() - 24 * 60 * 60 * 1000,
				});
				expect(createCueEngineLease({ lockPath }).acquire().ok).toBe(false);
			}
		);

		it('reclaims from a holder that has exited', async () => {
			const exited = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
			await new Promise((resolve) => exited.once('exit', resolve));
			writeHolder({ pid: exited.pid! });

			const lease = createCueEngineLease({ lockPath });
			expect(lease.acquire()).toEqual({ ok: true });
			expect(readRecord(lockPath).pid).toBe(process.pid);
		});

		it.runIf(tokensSupported)('reclaims from a holder whose pid was recycled', () => {
			const other = otherProcess();
			writeHolder({ pid: other.pid!, startToken: '1' });
			expect(createCueEngineLease({ lockPath }).acquire()).toEqual({ ok: true });
		});

		it('reclaims a leftover lease from an earlier engine cycle in this process', () => {
			writeHolder({ pid: process.pid, instanceId: 'previous-cycle' });
			expect(createCueEngineLease({ lockPath }).acquire()).toEqual({ ok: true });
			expect(readRecord(lockPath).instanceId).not.toBe('previous-cycle');
		});

		it('reclaims an UNVERIFIABLE holder when this process owns the data directory', () => {
			const other = otherProcess();
			// No start token: all we know is that some process has that pid. Holding
			// the single-instance lock rules out another app instance, so it decides.
			writeHolder({ pid: other.pid! });
			const lease = createCueEngineLease({ lockPath, ownsDataDirectory: () => true });
			expect(lease.acquire()).toEqual({ ok: true });
		});

		// Dev skips `requestSingleInstanceLock()` entirely (`setupDeepLinkHandling`
		// in src/main/deep-links.ts), so under `dev:prod-data` production holds the
		// lock while dev holds the lease. Letting the lock win there judges a live
		// dev engine stale and both engines fire, which is what the lease exists to
		// prevent.
		it.skipIf(!tokensSupported)(
			'does NOT reclaim a verified live holder even while owning the data directory',
			() => {
				const other = otherProcess();
				const startToken = readProcessStartToken(other.pid!) ?? undefined;
				expect(startToken).toBeDefined();
				writeHolder({ pid: other.pid!, startToken });

				const lease = createCueEngineLease({ lockPath, ownsDataDirectory: () => true });
				const result = lease.acquire();

				expect(result.ok).toBe(false);
				expect(readRecord(lockPath).pid).toBe(other.pid);
			}
		);

		it('falls back to the lease clock for a holder it cannot verify (no start token)', () => {
			const other = otherProcess();
			writeHolder({ pid: other.pid!, heartbeatAt: Date.now() - 1_000 });
			expect(createCueEngineLease({ lockPath, leaseTtlMs: 60_000 }).acquire().ok).toBe(false);

			writeHolder({ pid: other.pid!, heartbeatAt: Date.now() - 120_000 });
			expect(createCueEngineLease({ lockPath, leaseTtlMs: 60_000 }).acquire()).toEqual({
				ok: true,
			});
		});

		it('backs off from a peer that is mid-create, then reclaims it once clearly abandoned', () => {
			fs.writeFileSync(lockPath, '');
			const waited = createCueEngineLease({ lockPath, acquireTimeoutMs: 100 }).acquire();
			expect(waited.ok).toBe(false);
			if (!waited.ok) expect(waited.reason).toContain('Timed out');

			const old = (Date.now() - 60_000) / 1000;
			fs.utimesSync(lockPath, old, old);
			expect(createCueEngineLease({ lockPath }).acquire()).toEqual({ ok: true });
		});
	});

	describe('renew', () => {
		it('refreshes heartbeatAt while held', async () => {
			const lease = createCueEngineLease({ lockPath });
			lease.acquire();
			const before = readRecord(lockPath);
			await new Promise((resolve) => setTimeout(resolve, 5));

			expect(lease.renew()).toBe(true);
			const after = readRecord(lockPath);
			expect(after.instanceId).toBe(before.instanceId);
			expect(after.heartbeatAt).toBeGreaterThan(before.heartbeatAt);
			expect(fs.readdirSync(dir)).toEqual(['cue-engine.lock']);
		});

		it('reports the loss when a peer has taken the lease', () => {
			const lease = createCueEngineLease({ lockPath });
			lease.acquire();
			const peer = writeHolder({ pid: 1, instanceId: 'peer' });

			expect(lease.renew()).toBe(false);
			expect(readRecord(lockPath).instanceId).toBe(peer.instanceId);
			// Once lost, it stays lost until acquired again.
			expect(lease.renew()).toBe(false);
		});

		it('re-takes a lease file that was deleted out from under it', () => {
			const lease = createCueEngineLease({ lockPath });
			lease.acquire();
			fs.unlinkSync(lockPath);

			expect(lease.renew()).toBe(true);
			expect(readRecord(lockPath).pid).toBe(process.pid);
		});

		it('returns false when never acquired', () => {
			expect(createCueEngineLease({ lockPath }).renew()).toBe(false);
		});

		// An unreadable file is the cheapest real stand-in for the EBUSY a Windows
		// scanner produces. `chmod` does nothing on Windows, and root ignores the
		// mode, so the branch is asserted where it can actually be provoked.
		const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0;

		it.skipIf(!canDenyRead)('keeps the lease when the file cannot be read', () => {
			const lease = createCueEngineLease({ lockPath });
			lease.acquire();
			const before = readRecord(lockPath);
			fs.chmodSync(lockPath, 0o000);

			try {
				// A read failure says nothing about who holds the lease, so it must
				// not come back as "a peer took over", which stops Cue for good.
				expect(() => lease.renew()).toThrow(/EACCES/);
			} finally {
				fs.chmodSync(lockPath, 0o600);
			}

			// The lease was never given up: the next tick carries on.
			expect(lease.renew()).toBe(true);
			expect(readRecord(lockPath).instanceId).toBe(before.instanceId);
		});

		it('keeps the lease when the file is present but unparseable', () => {
			const lease = createCueEngineLease({ lockPath });
			lease.acquire();
			const before = readRecord(lockPath);
			// A peer between its O_EXCL create and its write looks exactly like this.
			fs.writeFileSync(lockPath, '{"pid":');

			expect(() => lease.renew()).toThrow(/unreadable/);
			// Nothing was written over the half-written file.
			expect(fs.readFileSync(lockPath, 'utf-8')).toBe('{"pid":');

			// Still ours once the bytes settle.
			fs.writeFileSync(lockPath, JSON.stringify(before));
			expect(lease.renew()).toBe(true);
		});
	});

	describe('release', () => {
		it('removes the lease it holds', () => {
			const lease = createCueEngineLease({ lockPath });
			lease.acquire();
			lease.release();
			expect(fs.existsSync(lockPath)).toBe(false);
		});

		it("leaves a peer's lease alone", () => {
			const lease = createCueEngineLease({ lockPath });
			lease.acquire();
			writeHolder({ pid: 1, instanceId: 'peer' });

			lease.release();
			expect(readRecord(lockPath).instanceId).toBe('peer');
		});

		it('is a no-op when not held', () => {
			expect(() => createCueEngineLease({ lockPath }).release()).not.toThrow();
		});
	});

	describe('across processes', () => {
		it('lets exactly one of several simultaneous starts win', async () => {
			const bundle = bundleForChildProcess('main/cue/cue-engine-lease.ts', dir, 'lease');
			const results = await runChildren(
				`
const { createCueEngineLease } = require(${JSON.stringify(bundle)});
const result = createCueEngineLease({ lockPath: ${JSON.stringify(lockPath)}, acquireTimeoutMs: 5000 }).acquire();
process.stdout.write(result.ok ? 'won' : 'lost');
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(dir)} + '/reported-' + process.env.CHILD_INDEX, '');
// The winner stays alive until every child has reported, so a slow starter
// sees a live holder rather than a dead one it could reclaim.
if (result.ok) {
	const timer = setInterval(() => {
		const reported = fs.readdirSync(${JSON.stringify(dir)}).filter((f) => f.startsWith('reported-'));
		if (reported.length >= 8) clearInterval(timer);
	}, 20);
}
`,
				8,
				{ dir }
			);

			for (const result of results) {
				expect(result.stderr).toBe('');
				expect(result.code).toBe(0);
			}
			expect(results.filter((r) => r.stdout === 'won')).toHaveLength(1);
			expect(results.filter((r) => r.stdout === 'lost')).toHaveLength(7);
		}, 30_000);
	});
});

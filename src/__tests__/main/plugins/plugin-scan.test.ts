import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildSync } from 'esbuild';
import { PluginFileScanner } from '../../../main/plugins/plugin-scan';
import { pluginIdentity } from '../../../main/plugins/plugin-identity';
import { buildSigningPayload } from '../../../shared/plugins/signing';
let dir: string, script: string, pluginDir: string, key: string;
beforeAll(() => {
	const scratch = path.resolve('.maestro/scratch');
	fs.mkdirSync(scratch, { recursive: true });
	dir = fs.mkdtempSync(path.join(scratch, 'fresh-plugin-worker-'));
	script = path.join(dir, 'worker.cjs');
	buildSync({
		entryPoints: [path.resolve('src/main/plugins/plugin-scan-worker.ts')],
		bundle: true,
		platform: 'node',
		format: 'cjs',
		outfile: script,
	});
	pluginDir = path.join(dir, 'plugin');
	fs.mkdirSync(pluginDir);
	const files: Record<string, string> = {},
		bytes = Buffer.alloc(4096, 65);
	for (let i = 0; i < 5000; i++) {
		const name = 'file-' + i;
		fs.writeFileSync(path.join(pluginDir, name), bytes);
		files[name] = createHash('sha256').update(bytes).digest('hex');
	}
	const pair = generateKeyPairSync('ed25519');
	key = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
	fs.writeFileSync(
		path.join(pluginDir, 'signature.json'),
		JSON.stringify({
			algorithm: 'ed25519',
			publicKey: key,
			signature: sign(null, Buffer.from(buildSigningPayload(files)), pair.privateKey).toString(
				'base64'
			),
			files,
		})
	);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
describe('fresh off-main plugin verification', () => {
	it('allows the event loop to run during a real signed5000-file/20480000-byte scan and rejects next-call tampering', async () => {
		const scanner = new PluginFileScanner(script);
		const baselineStart = performance.now();
		const baselineTimer = new Promise<number>((resolve) =>
			setTimeout(() => resolve(performance.now() - baselineStart), 0)
		);
		const baseline = pluginIdentity(pluginDir, [key]);
		const baselineElapsedMs = performance.now() - baselineStart;
		const baselineTimerDelayMs = await baselineTimer;
		expect(baseline?.signatureStatus).toBe('trusted');
		let ticks = 0,
			maxDelay = 0,
			last = performance.now();
		const timer = setInterval(() => {
			const now = performance.now();
			maxDelay = Math.max(maxDelay, now - last);
			last = now;
			ticks++;
		}, 1);
		const start = performance.now();
		try {
			const pending = scanner.scan(pluginDir, [key]);
			expect(
				await Promise.race([
					pending.then(() => 'scan'),
					new Promise((resolve) => setTimeout(() => resolve('timer'), 0)),
				])
			).toBe('timer');
			const first = await pending;
			expect(first.identity).toEqual(baseline);
			expect(ticks).toBeGreaterThan(1);
			const metrics = {
				fixtureFiles: 5000,
				fixtureBytes: 20480000,
				baselineElapsedMs,
				baselineTimerDelayMs,
				elapsedMs: performance.now() - start,
				eventLoopTicks: ticks,
				maxTimerGapMs: maxDelay,
			};
			if (process.env.MAESTRO_PLUGIN_SCAN_BENCHMARK)
				fs.writeFileSync(
					process.env.MAESTRO_PLUGIN_SCAN_BENCHMARK,
					JSON.stringify(metrics, null, 2)
				);

			fs.writeFileSync(path.join(pluginDir, 'file-1'), 'tampered');
			expect((await scanner.scan(pluginDir, [key])).identity?.signatureStatus).toBe('invalid');
		} finally {
			clearInterval(timer);
		}
	});
	it('fails closed when worker construction/loading fails, with no inline fallback', async () => {
		const scanner = new PluginFileScanner(path.join(dir, 'missing-worker.cjs'));
		await expect(scanner.scan(pluginDir, [key])).rejects.toThrow(/unavailable/);
	});
});

// Live-omp end-to-end smoke harness (W6).
//
// Ties the real pieces together: it starts the reference ingest host (writing a
// temp discovery file), then runs `mae` (which launches the real `omp` binary
// with the bridge extension), drives one print-mode turn, and asserts the host
// received session.register + at least one session.event.
//
// This REQUIRES a real omp install + provider auth (ANTHROPIC_API_KEY or
// equivalent) and performs a real model turn, so it is NOT part of the unit
// suite or CI. Run it manually in a live environment:
//
//   bun run src/mae/harness/live-omp-smoke.ts
//
// Exit code 0 = the bridge tracked the run end-to-end; non-zero = failure.

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runMae } from '../launcher';
import { startReferenceServer } from '../reference-server';
import { writeBridgeDiscovery } from '../paths';

const AUTH_ENV_KEYS = [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_OAUTH_TOKEN',
	'OPENAI_API_KEY',
	'GEMINI_API_KEY',
	'OPENROUTER_API_KEY',
];

function hasAuth(env: NodeJS.ProcessEnv): boolean {
	return AUTH_ENV_KEYS.some((key) => typeof env[key] === 'string' && env[key] !== '');
}

async function main(): Promise<number> {
	if (!hasAuth(process.env)) {
		process.stderr.write(
			`live-omp-smoke: no provider auth found (${AUTH_ENV_KEYS.join(', ')}); skipping.\n`
		);
		return 0; // skip, not fail
	}

	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mae-smoke-'));
	const discovery = path.join(dir, 'mae-bridge.json');
	const mapPath = path.join(dir, 'session-map.json');
	const host = await startReferenceServer({ secret: 'smoke-secret' });
	try {
		// Reuse the 0600 discovery writer (this file carries the bootstrap secret).
		await writeBridgeDiscovery(discovery, { url: host.url, secret: host.secret });

		const code = await runMae({
			argv: ['-p', 'Reply with exactly: ready'],
			env: {
				...process.env,
				MAE_BRIDGE_DISCOVERY: discovery,
				MAE_MAP_PATH: mapPath,
			},
		});

		let ok = true;
		if (code !== 0) {
			process.stderr.write(`live-omp-smoke: omp exited ${code}\n`);
			ok = false;
		}
		if (host.store.sessions.size === 0) {
			process.stderr.write('live-omp-smoke: no session.register reached the bridge\n');
			ok = false;
		}
		if (host.store.events.length === 0) {
			process.stderr.write('live-omp-smoke: no session.event reached the bridge\n');
			ok = false;
		}

		if (ok) {
			process.stdout.write(
				`live-omp-smoke: OK - tracked ${host.store.sessions.size} session(s), ${host.store.events.length} event(s)\n`
			);
			return 0;
		}
		return 1;
	} finally {
		await host.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => {
		process.stderr.write(
			`live-omp-smoke: ${error instanceof Error ? error.message : String(error)}\n`
		);
		process.exit(1);
	}
);

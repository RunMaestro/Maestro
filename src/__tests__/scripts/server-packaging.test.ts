/**
 * The container image and the systemd unit start the same engine with the
 * same service-mode flags. These checks keep the two, the health probe, and
 * the stop timeouts from drifting apart (see docs/maestro-cue-server.md).
 * They also pin server mode in both, what it lets an agent inherit from the
 * service's environment, core dumps being off, Compose's names and build
 * argument, and the installer's --enable gate, exit statuses and npm registry
 * check.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { execFile, execFileSync, spawnSync } from 'child_process';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SERVER_ENV_ALLOW_ENV_VAR, SERVER_MODE_ENV_VAR } from '../../shared/maestro-lib/launch/env';
import { buildAgentLaunchPlan } from '../../shared/maestro-lib/launch/launch-plan';
import { getAgentDefinition } from '../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../shared/maestro-lib/providers/capabilities';

const packagingDir = path.resolve(__dirname, '../../../packaging/server');
const read = (name: string) => fs.readFileSync(path.join(packagingDir, name), 'utf8');

const dockerfile = read('Dockerfile');
const unit = read('maestro-cue.service');
const compose = read('compose.yaml');
const wrapper = read('maestro-cli');
const installer = read('install.sh');

/** The JSON array of a Dockerfile exec-form instruction. */
function execForm(instruction: string): string[] {
	const match = dockerfile.match(new RegExp(`^${instruction} (\\[.*\\])$`, 'm'));
	if (!match) throw new Error(`no exec-form ${instruction} in the Dockerfile`);
	return JSON.parse(match[1]);
}

/** Every value of a systemd `Key=` line. */
function unitValues(key: string): string[] {
	return [...unit.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].map((m) => m[1].trim());
}

function unitValue(key: string): string {
	const values = unitValues(key);
	expect(values, `${key}= in maestro-cue.service`).toHaveLength(1);
	return values[0];
}

/** Value of `--flag <value>` in an argument list. */
function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
}

const containerArgs = execForm('CMD');
const unitArgs = unitValue('ExecStart').split(/\s+/);

describe('server packaging', () => {
	it('starts the engine with the same arguments in the image and the unit', () => {
		expect(unitArgs[0]).toBe('/usr/local/bin/maestro-cli');
		expect(unitArgs.slice(1)).toEqual(containerArgs);
	});

	it('passes every flag of the service-mode contract', () => {
		expect(containerArgs.slice(0, 3)).toEqual(['cue', 'engine', 'start']);
		expect(flag(containerArgs, '--data-dir')).toBe('/var/lib/maestro/data');
		expect(flag(containerArgs, '--status-port')).toBe('7433');
		expect(flag(containerArgs, '--log-format')).toBe('json');
		expect(flag(containerArgs, '--drain-timeout')).toBe('90');
		expect(containerArgs).toContain('--require-ready');
	});

	it('probes health on the status port the engine is given', () => {
		const healthcheck = dockerfile.match(/^\s*CMD \[.*\/healthz.*\]$/m)?.[0] ?? '';
		expect(healthcheck).toContain(`127.0.0.1:${flag(containerArgs, '--status-port')}/healthz`);
	});

	it('gives the drain time to finish before anything is killed', () => {
		const drain = Number(flag(containerArgs, '--drain-timeout'));
		// The contract: at least the drain plus 15 s of stop-ladder grace and margin.
		expect(Number(unitValue('TimeoutStopSec'))).toBeGreaterThanOrEqual(drain + 15);
		const grace = compose.match(/stop_grace_period: (\d+)s/)?.[1];
		expect(Number(grace)).toBeGreaterThan(drain);
	});

	it('signals only the engine on stop, so the drain can let agents finish', () => {
		// Agents share the engine's process group: tini -g would SIGTERM them all.
		const entrypoint = execForm('ENTRYPOINT');
		expect(entrypoint.slice(0, 2)).toEqual(['/usr/bin/tini', '--']);
		expect(entrypoint).not.toContain('-g');
		expect(unitValue('KillMode')).toBe('mixed');
	});

	it('uses notify readiness and the watchdog, with restarts', () => {
		expect(unitValue('Type')).toBe('notify');
		expect(unitValue('NotifyAccess')).toBe('all');
		expect(unitValue('WatchdogSec')).toBe('30');
		expect(unitValue('TimeoutStartSec')).toBe('60');
		expect(unitValue('Restart')).toBe('on-failure');
	});

	it('runs as the maestro user with the data directory writable', () => {
		expect(unitValue('User')).toBe('maestro');
		expect(dockerfile).toMatch(/^USER maestro$/m);
		const writable = unitValue('ReadWritePaths').split(/\s+/);
		expect(writable).toContain('/var/lib/maestro');
		expect(flag(containerArgs, '--data-dir')?.startsWith('/var/lib/maestro/')).toBe(true);
	});

	it('points the wrapper and both environments at one data directory', () => {
		const dataDir = flag(containerArgs, '--data-dir');
		expect(wrapper).toContain(`MAESTRO_USER_DATA:-${dataDir}`);
		expect(unitValues('Environment')).toContain(`MAESTRO_USER_DATA=${dataDir}`);
		expect(dockerfile).toContain(`MAESTRO_USER_DATA=${dataDir}`);
	});
});

interface ComposeFile {
	services: Record<
		string,
		{
			build?: { args?: Record<string, string> };
			container_name?: string;
			ulimits?: Record<string, unknown>;
			volumes?: string[];
		}
	>;
	volumes: Record<string, { name?: string } | null>;
}
const composeFile = yaml.load(compose) as ComposeFile;
const composeService = composeFile.services['maestro-cue'];
// docs/ is not pinned to LF, so a Windows checkout with core.autocrlf reads
// CRLF here and the `\` continuation lines below would never match.
const serverDocs = fs
	.readFileSync(path.resolve(__dirname, '../../../docs/maestro-cue-server.md'), 'utf8')
	.replace(/\r\n/g, '\n');

describe('no core dumps', () => {
	// The engine holds webhook secrets, tokens and provider keys in memory.
	it('sets a zero core limit in the unit', () => {
		expect(unitValue('LimitCORE')).toBe('0');
	});

	it('sets a zero core ulimit in compose and in the documented docker run', () => {
		expect(composeService.ulimits?.core).toBe(0);
		const run = serverDocs.match(/^docker run -d --name maestro-cue(?:.*\\\n)*.*$/m)?.[0];
		expect(run, 'the docker run -d command in docs/maestro-cue-server.md').toBeDefined();
		expect(run).toContain('--ulimit core=0');
	});
});

describe('compose.yaml', () => {
	it('passes AGENT_CLIS to the build, defaulting to the Dockerfile default', () => {
		const dockerDefault = dockerfile.match(/^ARG AGENT_CLIS="(.*)"$/m)?.[1];
		expect(dockerDefault).toBe('@anthropic-ai/claude-code');
		expect(composeService.build?.args?.AGENT_CLIS).toBe(`\${AGENT_CLIS:-${dockerDefault}}`);
	});

	it('uses the fixed names the docs use for the container and both volumes', () => {
		expect(composeService.container_name).toBe('maestro-cue');
		expect(composeService.volumes).toEqual([
			'maestro-home:/var/lib/maestro',
			'maestro-work:/srv/maestro',
		]);
		expect(composeFile.volumes['maestro-home']?.name).toBe('maestro-home');
		expect(composeFile.volumes['maestro-work']?.name).toBe('maestro-work');
	});
});

describe('server mode in the packaging', () => {
	it('is on in the unit and the image, and compose does not turn it off', () => {
		expect(unitValues('Environment')).toContain(`${SERVER_MODE_ENV_VAR}=1`);
		// The runtime stage: everything after the last FROM.
		const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
		const envNames = [...runtime.matchAll(/^ENV ((?:.*\\\n)*.*)$/gm)].flatMap((m) =>
			m[1].split(/\s*\\?\n\s*|\s+/).filter(Boolean)
		);
		expect(envNames).toContain(`${SERVER_MODE_ENV_VAR}=1`);
		expect(compose).not.toMatch(/MAESTRO_SERVER_MODE\s*[:=]\s*['"]?0/);
	});

	describe('what an agent inherits from the service', () => {
		const saved = { ...process.env };
		afterEach(() => {
			process.env = { ...saved };
		});

		/** The variables the installer's maestro.env template suggests. */
		const templateKeys = [
			...(installer.match(/cat > "\$CONF_DIR\/maestro.env" <<'EOF'\n([\s\S]*?)\nEOF/)?.[1] ?? '')
				.split('\n')
				.flatMap((line) => /^#([A-Z_][A-Z0-9_]*)=$/.exec(line)?.[1] ?? []),
		];

		/**
		 * The engine's environment as the unit builds it: its Environment= lines,
		 * then maestro.env with every template key set plus variables meant for
		 * the engine alone. Returns the env a Cue launch of `toolType` gets.
		 */
		function launchUnderUnit(
			toolType: string,
			options: { serverMode: boolean; maestroEnv?: Record<string, string> }
		) {
			const unitEnv = Object.fromEntries(
				unitValues('Environment').map((pair) => pair.split(/=(.*)/s).slice(0, 2))
			);
			if (!options.serverMode) delete unitEnv[SERVER_MODE_ENV_VAR];
			process.env = {
				PATH: '/usr/bin:/bin',
				...unitEnv,
				...Object.fromEntries(templateKeys.map((key) => [key, `value-of-${key}`])),
				DEPLOY_PASSWORD: 'engine-only',
				GEMINI_API_KEY: 'gemini',
				...options.maestroEnv,
			};
			const result = buildAgentLaunchPlan({
				surface: 'cue',
				agent: { ...getAgentDefinition(toolType)!, capabilities: getAgentCapabilities(toolType) },
				command: `/usr/local/bin/${toolType}`,
				args: [],
				cwd: '/srv/maestro/proj',
				prompt: 'go',
				isWindowsHost: false,
				secretLookup: { env: {}, runSecretsDir: null },
			});
			if (!result.ok) throw new Error(result.error);
			return result.plan.env ?? {};
		}

		it('suggests provider keys in maestro.env', () => {
			expect(templateKeys).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN']);
		});

		it('passes the provider keys from maestro.env and nothing unrelated', () => {
			for (const toolType of ['claude-code', 'codex', 'opencode']) {
				const env = launchUnderUnit(toolType, { serverMode: true });
				for (const key of templateKeys)
					expect(env[key], `${toolType} ${key}`).toBe(`value-of-${key}`);
				expect(env.DEPLOY_PASSWORD).toBeUndefined();
				// A provider key outside the env catalog needs MAESTRO_SERVER_ENV_ALLOW
				// (or a bundle-declared secret).
				expect(env.GEMINI_API_KEY).toBeUndefined();
				expect(env.MAESTRO_USER_DATA).toBe('/var/lib/maestro/data');
			}
		});

		it('lets an operator add a name with MAESTRO_SERVER_ENV_ALLOW in maestro.env, and only that name', () => {
			const env = launchUnderUnit('opencode', {
				serverMode: true,
				maestroEnv: { [SERVER_ENV_ALLOW_ENV_VAR]: 'GEMINI_API_KEY' },
			});
			expect(env.GEMINI_API_KEY).toBe('gemini');
			expect(env.DEPLOY_PASSWORD).toBeUndefined();
		});

		it('keeps the whole environment without server mode (a standalone engine run by hand)', () => {
			const env = launchUnderUnit('claude-code', { serverMode: false });
			expect(env.DEPLOY_PASSWORD).toBe('engine-only');
			expect(env.GEMINI_API_KEY).toBe('gemini');
		});
	});
});

describe('install.sh --enable', () => {
	/** The installer's gate function, run in sh with `runuser` stubbed to print `checkOutput`. */
	function nothingToRunReason(checkOutput: string): string {
		const fn = installer.match(/^nothing_to_run_reason\(\) \{\n[\s\S]*?\n\}$/m)?.[0];
		if (!fn) throw new Error('nothing_to_run_reason() not found in install.sh');
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-gate-'));
		try {
			const out = path.join(dir, 'check.out');
			fs.writeFileSync(out, checkOutput);
			const script = [
				`STATE_DIR=${JSON.stringify(dir)}`,
				'DATA_DIR=/var/lib/maestro/data',
				'PREFIX=/opt/maestro',
				`NODE_BIN=${JSON.stringify(process.execPath)}`,
				// The stub records how it was called and prints the canned report.
				`runuser() { printf '%s\\n' "$*" > ${JSON.stringify(path.join(dir, 'args'))}; cat ${JSON.stringify(out)}; return 1; }`,
				fn,
				'nothing_to_run_reason',
			].join('\n');
			const reason = execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim();
			const args = fs.readFileSync(path.join(dir, 'args'), 'utf8');
			expect(args).toContain('-u maestro --');
			expect(args).toContain(
				'/opt/maestro/bin/maestro-cli cue engine check --data-dir /var/lib/maestro/data --json'
			);
			return reason;
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	const report = (gaps: Array<{ kind: string; message: string }>) =>
		JSON.stringify({ ready: gaps.length === 0, agents: 0, workspaces: 0, subscriptions: 0, gaps });

	it.skipIf(process.platform === 'win32')(
		"refuses on the check's nothing-to-run gap, with its message",
		() => {
			expect(
				nothingToRunReason(
					report([{ kind: 'nothing-to-run', message: 'This data directory has no agents.' }])
				)
			).toBe('This data directory has no agents.');
		}
	);

	it.skipIf(process.platform === 'win32')(
		'leaves every other gap to --require-ready in the service environment',
		() => {
			// A secret set only in maestro.env is missing for the installer's shell.
			expect(
				nothingToRunReason(report([{ kind: 'secret-missing', message: 'API_KEY is not set.' }]))
			).toBe('');
			expect(nothingToRunReason(report([]))).toBe('');
		}
	);

	it.skipIf(process.platform === 'win32')('refuses when the check produced no report', () => {
		expect(nothingToRunReason('Error: something broke')).toMatch(/did not report/);
	});

	it('restarts a running engine on upgrade before, and regardless of, the gate', () => {
		const restart = installer.indexOf('systemctl restart maestro-cue');
		const gate = installer.indexOf('ENABLE_REFUSED=$(nothing_to_run_reason)');
		expect(restart).toBeGreaterThan(-1);
		expect(gate).toBeGreaterThan(restart);
		// The restart is not inside the --enable branch.
		expect(installer.slice(restart, gate)).toContain('if [ "$ENABLE" = 1 ]; then');
		// An already enabled service is started, not gated.
		expect(installer).toMatch(
			/if systemctl is-enabled --quiet maestro-cue; then\n\t\tsystemctl start maestro-cue/
		);
	});

	it('enables only when the gate passes, and exits 3 after a full install when it does not', () => {
		expect(installer).toMatch(
			/if \[ -n "\$ENABLE_REFUSED" \]; then[\s\S]*?else\n\t\t\tsystemctl enable --now maestro-cue/
		);
		expect(installer.trimEnd().endsWith('[ -z "$ENABLE_REFUSED" ] || exit 3')).toBe(true);
		// The readiness check decides, not the installer counting files.
		expect(installer).not.toContain('maestro-sessions.json');
	});

	describe('exit status', () => {
		/** The installer's exit trap, then `body`, run in sh under `set -eu`. */
		function exitStatus(body: string): { status: number | null; stderr: string } {
			const trap = installer.match(
				/^ENABLE_REFUSED=""\non_exit\(\) \{[\s\S]*?^trap 'exit 130' HUP INT TERM$/m
			)?.[0];
			if (!trap) throw new Error('the exit trap was not found in install.sh');
			const result = spawnSync(
				'sh',
				['-c', ['set -eu', "C_RED=''; C_RESET=''", trap, body].join('\n')],
				{ encoding: 'utf8' }
			);
			return { status: result.status, stderr: result.stderr };
		}

		it.skipIf(process.platform === 'win32')('keeps 0, 1 and a refused --enable 3', () => {
			expect(exitStatus('true')).toEqual({ status: 0, stderr: '' });
			expect(exitStatus('exit 1').status).toBe(1);
			expect(exitStatus('ENABLE_REFUSED="nothing to run"; exit 3')).toEqual({
				status: 3,
				stderr: '',
			});
		});

		it.skipIf(process.platform === 'win32')(
			'turns any other failure into 1 and names the original status',
			() => {
				// apt-get exits 100 when a package cannot be installed.
				const apt = exitStatus('sh -c "exit 100"\necho not reached');
				expect(apt.status).toBe(1);
				expect(apt.stderr).toContain('status 100');
				// A 3 nobody meant is not "installed, --enable refused".
				expect(exitStatus('sh -c "exit 3"').status).toBe(1);
				expect(exitStatus('kill -INT $$; sleep 1').status).toBe(1);
			}
		);

		it.skipIf(process.platform === 'win32')(
			'is armed before the options are read, and the refusal is not reset after it',
			() => {
				const script = path.join(packagingDir, 'install.sh');
				expect(spawnSync('sh', [script, '--help']).status).toBe(0);
				expect(spawnSync('sh', [script, '--no-such-option']).status).toBe(1);
				expect(installer.match(/^\s*ENABLE_REFUSED=""$/gm)).toHaveLength(1);
				const armed = installer.indexOf('\ntrap on_exit EXIT\n');
				expect(armed).toBeGreaterThan(-1);
				expect(armed).toBeLessThan(installer.indexOf('while [ $# -gt 0 ]; do'));
			}
		);
	});

	// Needs a POSIX sh, which a Windows runner does not promise (like the gate tests above).
	it.skipIf(process.platform === 'win32')('parses as a POSIX shell script', () => {
		expect(() => execFileSync('sh', ['-n', path.join(packagingDir, 'install.sh')])).not.toThrow();
	});
});

describe('install.sh npm registry check', () => {
	// The check shells out to npm under coreutils `timeout`, which a Debian or
	// Ubuntu host always has; a Windows runner or a stock macOS does not.
	const canRun =
		process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v timeout']).status === 0;

	/** CONNECT_TIMEOUT and the two registry functions, as install.sh defines them. */
	function probeFunctions(): string {
		const pick = (re: RegExp, what: string) => {
			const found = installer.match(re)?.[0];
			if (!found) throw new Error(`${what} not found in install.sh`);
			return found;
		};
		return [
			pick(/^CONNECT_TIMEOUT=\d+$/m, 'CONNECT_TIMEOUT'),
			pick(/^npm_registry\(\) \{\n[\s\S]*?\n\}$/m, 'npm_registry()'),
			pick(/^npm_registry_problem\(\) \{\n[\s\S]*?\n\}$/m, 'npm_registry_problem()'),
		].join('\n');
	}

	/**
	 * Runs npm_registry_problem() in sh with the real npm, pointed at `registry`
	 * and isolated from this machine's npm config, and returns what it printed.
	 */
	async function registryProblem(
		registry: string,
		opts: { connectTimeout?: number; env?: Record<string, string> } = {}
	): Promise<{ status: number; stdout: string }> {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'install-registry-'));
		// Empty user and global config files (npm refuses one file as both).
		const userrc = path.join(dir, 'user-npmrc');
		const globalrc = path.join(dir, 'global-npmrc');
		fs.writeFileSync(userrc, '');
		fs.writeFileSync(globalrc, '');
		const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: dir };
		Object.assign(env, {
			npm_config_userconfig: userrc,
			npm_config_globalconfig: globalrc,
			npm_config_cache: path.join(dir, 'cache'),
			npm_config_registry: registry,
			...opts.env,
		});
		const script = [
			'set -eu',
			probeFunctions(),
			opts.connectTimeout ? `CONNECT_TIMEOUT=${opts.connectTimeout}` : '',
			'NPM_BIN=$(command -v npm)',
			'npm_registry_problem',
		].join('\n');
		try {
			return await new Promise((resolve) => {
				execFile('sh', ['-c', script], { env, encoding: 'utf8' }, (error, stdout) => {
					resolve({ status: error ? Number(error.code) : 0, stdout: stdout.trim() });
				});
			});
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	/** A local registry answering every request with `handler`. */
	async function withRegistry<T>(
		handler: http.RequestListener,
		body: (url: string) => Promise<T>
	): Promise<T> {
		const server = http.createServer(handler);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		try {
			return await body(`http://127.0.0.1:${port}/`);
		} finally {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		}
	}

	/** A port on this host nothing listens on. */
	async function closedPort(): Promise<number> {
		const server = http.createServer();
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		await new Promise((resolve) => server.close(resolve));
		return port;
	}

	it.skipIf(!canRun)('prints nothing when the registry serves better-sqlite3', async () => {
		const requested: string[] = [];
		const result = await withRegistry(
			(req, res) => {
				requested.push(req.url ?? '');
				res.setHeader('content-type', 'application/json');
				res.end(
					JSON.stringify({
						name: 'better-sqlite3',
						'dist-tags': { latest: '1.0.0' },
						versions: { '1.0.0': { name: 'better-sqlite3', version: '1.0.0' } },
					})
				);
			},
			(url) => registryProblem(url)
		);
		expect(result).toEqual({ status: 0, stdout: '' });
		expect(requested).toContain('/better-sqlite3');
	});

	it.skipIf(!canRun)(
		'names the registry and the cause when nothing listens there',
		async () => {
			const registry = `http://127.0.0.1:${await closedPort()}/`;
			const started = Date.now();
			const { status, stdout } = await registryProblem(registry);
			expect(status).toBe(0);
			expect(stdout).toContain(`npm cannot fetch from the registry ${registry} (ECONNREFUSED)`);
			expect(stdout).toContain('npm config get registry');
			// One try, not npm's default retries.
			expect(Date.now() - started).toBeLessThan(15_000);
		},
		20_000
	);

	it.skipIf(!canRun)(
		'gives up on a registry that accepts but never answers',
		async () => {
			const { stdout } = await withRegistry(
				() => {
					// Hold the request open.
				},
				(url) => registryProblem(url, { connectTimeout: 1 })
			);
			expect(stdout).toMatch(/^npm cannot fetch from the registry http:\/\/127\.0\.0\.1:\d+\/ /);
			expect(stdout).toContain('(no answer in 1s)');
		},
		20_000
	);

	it.skipIf(!canRun)('reports what the registry said when it refuses', async () => {
		const { stdout } = await withRegistry(
			(_req, res) => {
				res.statusCode = 404;
				res.end('{}');
			},
			(url) => registryProblem(url)
		);
		expect(stdout).toContain('(E404)');
	});

	it.skipIf(!canRun)(
		'names the proxy without its credentials',
		async () => {
			const port = await closedPort();
			// npm 11 refuses to print a proxy setting with a password, so the
			// environment variable is what can be named.
			const fromEnv = await registryProblem('https://registry.invalid/', {
				env: { HTTPS_PROXY: `http://user:secret@127.0.0.1:${port}` },
			});
			expect(fromEnv.stdout).toContain(`through the proxy http://127.0.0.1:${port} (`);
			expect(fromEnv.stdout).not.toContain('secret');
			const fromConfig = await registryProblem('https://registry.invalid/', {
				env: { npm_config_https_proxy: `http://127.0.0.1:${port}` },
			});
			expect(fromConfig.stdout).toContain(`through the proxy http://127.0.0.1:${port} (`);
			const withPassword = await registryProblem('https://registry.invalid/', {
				env: { npm_config_https_proxy: `http://user:secret@127.0.0.1:${port}` },
			});
			expect(withPassword.stdout).toMatch(
				/through the proxy (http:\/\/127\.0\.0\.1:\d+|set in npm config \(https-proxy\)) \(/
			);
			expect(withPassword.stdout).not.toContain('secret');
		},
		30_000
	);

	it('checks once before the first npm install, and again before blaming a missing compiler', () => {
		const check = installer.indexOf(
			'problem=$(npm_registry_problem)\n[ -z "$problem" ] || die "$problem"'
		);
		expect(check).toBeGreaterThan(-1);
		expect(check).toBeLessThan(installer.indexOf('"$NPM_BIN" install -g'));
		expect(check).toBeLessThan(installer.indexOf('"$NPM_BIN" install --omit=dev'));
		expect(installer).toMatch(
			/if ! sqlite_install; then\n(?:\t#.*\n)*\tproblem=\$\(npm_registry_problem\)\n\t\[ -z "\$problem" \] \|\| die "\$problem"\n\twarn "no prebuilt/
		);
	});
});

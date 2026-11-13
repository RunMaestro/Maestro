import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
	readBoardIsolationRegistries,
	requireBoardIsolation,
	type BoardIsolation,
} from '../../../main/board/board-isolation';
import { canonicalJson } from '../../../shared/canonicalJson';
import { CLI_SECRET_HEADER } from '../../../shared/webLogin';
import {
	BridgeConnection,
	CommandTimeoutError,
	MaestroNotRunningError,
	UnsupportedCommandError,
	type FixtureBridgeAdmission,
} from './fixtures/board-fixture-bridge';
import type { FixtureBridgeManifest } from './fixtures/board-fixture-bridge-admission';
import { createBoardIsolationFixture } from '../../helpers/boardIsolationFixture';

const io = vi.hoisted(() => ({ socket: vi.fn(), discovery: vi.fn() }));
vi.mock('ws', async (original) => {
	const actual = await original<typeof import('ws') & { default: typeof import('ws') }>();
	return {
		...actual,
		default: class extends actual.default {
			constructor(address: string, options?: import('ws').ClientOptions) {
				io.socket(address);
				super(address, options);
			}
		},
	};
});
vi.mock('../../../shared/maestro-lib/client/discovery', () => ({
	readCliServerInfo: io.discovery,
	readCliServerInfoFrom: io.discovery,
	isCliServerRunning: io.discovery,
	isPidAlive: io.discovery,
}));

let contract: BoardIsolation;
let scratch: string;
let server: WebSocketServer;
let endpoint: string;
let proof: FixtureBridgeAdmission;
let manifest: FixtureBridgeManifest;
let clients: BridgeConnection[];
let received: Record<string, unknown>[];
let responder: (socket: WebSocket, frame: Record<string, unknown>) => void;
const isolationFixture = createBoardIsolationFixture();

beforeAll(async () => {
	isolationFixture.install();
	contract = requireBoardIsolation();
	readBoardIsolationRegistries(contract);
	if (process.env.BOARD_ISOLATION_CONTRACT !== canonicalJson(contract))
		throw new Error('Fixture suite requires a canonical parent contract');
	scratch = fs.mkdtempSync(path.join(contract.root, 'fixture-bridge-'));
	server = new WebSocketServer({
		host: '127.0.0.1',
		port: 0,
		verifyClient: ({ req }: { req: import('node:http').IncomingMessage }) =>
			req.url === '/fixture-token/ws' &&
			req.headers[CLI_SECRET_HEADER] === 'parent-owned-fixture-secret',
	});
	await new Promise<void>((resolve, reject) => {
		server.once('listening', resolve);
		server.once('error', reject);
	});
	const address = server.address();
	if (!address || typeof address === 'string') throw new Error('Expected owned loopback listener');
	endpoint = `ws://127.0.0.1:${address.port}/fixture-token/ws`;
	server.on('connection', (socket) =>
		socket.on('message', (data) => {
			const frame = JSON.parse(String(data));
			received.push(frame);
			responder(socket, frame);
		})
	);
});

beforeEach(() => {
	io.socket.mockClear();
	clients = [];
	received = [];
	responder = (socket, frame) =>
		socket.send(
			JSON.stringify({
				type: 'board_command_result',
				requestId: frame.requestId,
				ok: true,
				value: frame.value,
			})
		);
	manifest = {
		version: 1,
		identity: contract.identity,
		ownerPid: process.pid,
		url: endpoint,
		cliSecret: 'parent-owned-fixture-secret',
	};
	proof = {
		contract,
		manifestPath: path.join(scratch, 'endpoint.json'),
		manifestSha256: '',
		ownerPid: process.pid,
	};
	writeManifest();
});

afterEach(() => {
	for (const client of clients) client.disconnect();
	for (const socket of server?.clients ?? []) socket.terminate();
	vi.unstubAllEnvs();
	expect(io.discovery).not.toHaveBeenCalled();
});
afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
	await isolationFixture.cleanup();
});

function writeManifest(value: unknown = manifest) {
	const bytes = canonicalJson(value);
	fs.writeFileSync(proof.manifestPath, bytes, { mode: 0o600 });
	fs.chmodSync(proof.manifestPath, 0o600);
	proof.manifestSha256 = createHash('sha256').update(bytes).digest('hex');
}
function client(admission: FixtureBridgeAdmission | undefined = proof) {
	const connection = new BridgeConnection({ fixture: admission, strictReplies: true });
	clients.push(connection);
	return connection;
}
async function refused(admission: FixtureBridgeAdmission | undefined = proof) {
	await expect(client(admission).connect()).rejects.toThrow();
	expect(io.socket).not.toHaveBeenCalled();
}

describe('parent-bound fixture bridge admission', () => {
	it('refuses a missing parent proof despite valid environment and a discovery file', async () => {
		fs.writeFileSync(path.join(scratch, 'cli-server.json'), '{"port":12345}');
		const connection = new BridgeConnection();
		await expect(connection.connect()).rejects.toThrow('parent admission');
		expect(io.socket).not.toHaveBeenCalled();
	});

	it.each(['BOARD_ISOLATION_ID', 'BOARD_DB_PATH', 'BOARD_ISOLATION_CONTRACT'])(
		'refuses removed %s before socket use',
		async (marker) => {
			const connection = client();
			vi.stubEnv(marker, undefined);
			await expect(connection.connect()).rejects.toThrow();
			expect(io.socket).not.toHaveBeenCalled();
		}
	);

	it('refuses a changed contract and an unrelated owner', async () => {
		await refused({ ...proof, contract: { ...contract, identity: 'replaced' } });
		await refused({ ...proof, ownerPid: -1 });
	});

	it('refuses outside, traversing, missing, symlink and hardlinked manifests', async () => {
		const alias = path.join(scratch, 'alias.json');
		const hardlink = path.join(scratch, 'hardlink.json');
		await refused({ ...proof, manifestPath: path.join(contract.worktree, 'package.json') });
		await refused({ ...proof, manifestPath: scratch + '/../endpoint.json' });
		await refused({ ...proof, manifestPath: path.join(scratch, 'missing.json') });
		fs.symlinkSync(proof.manifestPath, alias);
		await refused({ ...proof, manifestPath: alias });
		fs.linkSync(proof.manifestPath, hardlink);
		try {
			await refused();
		} finally {
			fs.unlinkSync(alias);
			fs.unlinkSync(hardlink);
		}
	});

	it.skipIf(!process.getuid)('refuses a publicly readable secret file', async () => {
		fs.chmodSync(proof.manifestPath, 0o644);
		await refused();
	});

	it('refuses an oversized manifest before parsing or connecting', async () => {
		fs.writeFileSync(proof.manifestPath, ' '.repeat(16385));
		await refused();
	});

	it('refuses userData redirection instead of discovering another host', async () => {
		const connection = new BridgeConnection({ fixture: proof, userDataDir: scratch });
		await expect(connection.connect()).rejects.toThrow('userData differs');
		expect(io.socket).not.toHaveBeenCalled();
	});

	it.each([
		'ws://localhost:12345/fixture-token/ws',
		'ws://192.0.2.1:12345/fixture-token/ws',
		'ws://127.0.0.1:65536/fixture-token/ws',
		'ws://127.0.0.1:0/fixture-token/ws',
		'ws://127.0.0.1:12345/../ws',
		'ws://127.0.0.1:12345/fixture-token/ws?redirect=1',
		'ws://user@127.0.0.1:12345/fixture-token/ws',
	])('refuses unadmitted endpoint %s', async (url) => {
		writeManifest({ ...manifest, url });
		await refused();
	});

	it.each([{ cliSecret: '' }, { identity: 'foreign' }, { ownerPid: -1 }, { version: 2 }, null])(
		'refuses invalid manifest fields %j',
		async (change) => {
			writeManifest(change === null ? null : { ...manifest, ...change });
			await refused();
		}
	);

	it('refuses bytes changed after the parent proof, including on an existing connection', async () => {
		const connection = client();
		await connection.connect();
		fs.writeFileSync(
			proof.manifestPath,
			canonicalJson({ ...manifest, cliSecret: 'replaced-fixture-secret' })
		);
		await expect(
			connection.sendCommand({ type: 'board_command' }, 'board_command_result')
		).rejects.toThrow('parent admission');
		expect(connection.isOpen).toBe(false);
		expect(received).toEqual([]);
		io.socket.mockClear();
		await refused();
	});

	it('retains a copy of the proof and refuses removed markers before sending', async () => {
		const connection = client();
		proof.manifestPath = path.join(scratch, 'nonexistent.json');
		await connection.connect();
		vi.stubEnv('BOARD_ISOLATION_CONTRACT', undefined);
		expect(() => connection.send({ type: 'ping' })).toThrow('parent admission');
		expect(connection.isOpen).toBe(false);
		expect(received).toEqual([]);
	});
});

describe('owned WebSocket request/reply protocol', () => {
	it('classifies an unavailable owned endpoint with the production not-running error', async () => {
		const stopped = new WebSocketServer({ host: '127.0.0.1', port: 0 });
		try {
			await new Promise<void>((resolve) => stopped.once('listening', resolve));
			const address = stopped.address();
			if (!address || typeof address === 'string') throw new Error('Expected owned listener');
			manifest.url = `ws://127.0.0.1:${address.port}/fixture-token/ws`;
			writeManifest();
		} finally {
			await new Promise<void>((resolve) => stopped.close(() => resolve()));
		}
		await expect(client().connect()).rejects.toBeInstanceOf(MaestroNotRunningError);
	});

	it('keeps an HTTP upgrade refusal distinct from an unavailable host', async () => {
		manifest.cliSecret = 'wrong-owned-fixture-secret';
		writeManifest();
		await expect(client().connect()).rejects.toThrow(
			'Failed to connect to Maestro: Unexpected server response: 401'
		);
		expect(received).toEqual([]);
	});

	it('refuses replies after the admitted registration paths are replaced', async () => {
		responder = (socket, frame) => {
			fs.renameSync(contract.agentRegistry, contract.agentRegistry + '.saved');
			socket.send(JSON.stringify({ type: 'reply', requestId: frame.requestId }));
		};
		const connection = client();
		await connection.connect();
		try {
			await expect(connection.sendCommand({ type: 'waiting' }, 'reply')).rejects.toMatchObject({
				name: 'ConnectionClosedError',
			});
			expect(connection.isOpen).toBe(false);
		} finally {
			fs.renameSync(contract.agentRegistry + '.saved', contract.agentRegistry);
		}
	});

	it('authenticates with the owned secret and correlates out-of-order replies by requestId', async () => {
		const frames = vi.fn();
		const connection = new BridgeConnection({
			fixture: proof,
			strictReplies: true,
			onFrame: frames,
		});
		clients.push(connection);
		responder = (socket) => {
			if (received.length !== 2) return;
			socket.send('not JSON');
			socket.send('null');
			socket.send(JSON.stringify({ type: 'board_command_result', requestId: 'foreign' }));
			for (const frame of [...received].reverse())
				socket.send(JSON.stringify({ ...frame, type: 'board_command_result' }));
		};
		await connection.connect();
		const replies = await Promise.all(
			[1, 2].map((value) =>
				connection.sendCommand({ type: 'board_command', value }, 'board_command_result')
			)
		);
		expect(replies).toMatchObject([{ value: 1 }, { value: 2 }]);
		expect(new Set(received.map((frame) => frame.requestId)).size).toBe(2);
		expect(frames).toHaveBeenCalledWith({ type: 'board_command_result', requestId: 'foreign' });
	});

	it('uses the production error class for unsupported echoes', async () => {
		responder = (socket, frame) => socket.send(JSON.stringify({ type: 'echo', data: frame }));
		const connection = client();
		await connection.connect();
		await expect(
			connection.sendCommand({ type: 'future_command' }, 'reply')
		).rejects.toBeInstanceOf(UnsupportedCommandError);
	});

	it('times out unmatched replies and permits explicit type-only replies', async () => {
		responder = (socket) => socket.send(JSON.stringify({ type: 'reply', requestId: 'late' }));
		const connection = client();
		await connection.connect();
		await expect(connection.sendCommand({ type: 'strict' }, 'reply', 30)).rejects.toBeInstanceOf(
			CommandTimeoutError
		);
		await expect(
			connection.sendCommand({ type: 'legacy' }, 'reply', 1000, { matchByType: true })
		).resolves.toMatchObject({ type: 'reply' });
	});

	it.each(['caller', 'host'])(
		'rejects pending calls and cleans timers when %s disconnects',
		async (source) => {
			responder = (socket) => source === 'host' && socket.close(1008, 'fixture closed');
			const connection = client();
			await connection.connect();
			const pending = connection.sendCommand({ type: 'pending' }, 'reply');
			const assertion = expect(pending).rejects.toMatchObject({
				name: 'ConnectionClosedError',
				closedByCaller: source === 'caller',
			});
			if (source === 'caller') connection.disconnect();
			await assertion;
			expect(connection.isOpen).toBe(false);
		}
	);

	it('exports the same production errors and supports a parent-admitted one-shot CLI wrapper', async () => {
		vi.resetModules();
		const fixture = await import('./fixtures/board-fixture-bridge');
		const errors = await import('../../../shared/maestro-lib/client/bridge-connection');
		const notRunning = await import('../../../shared/maestro-lib/client/not-running');
		expect(fixture.ConnectionClosedError).toBe(errors.ConnectionClosedError);
		expect(fixture.CommandTimeoutError).toBe(errors.CommandTimeoutError);
		expect(fixture.UnsupportedCommandError).toBe(errors.UnsupportedCommandError);
		expect(fixture.MaestroNotRunningError).toBe(notRunning.MaestroNotRunningError);
		fixture.admitFixtureBridge(proof);
		expect(() => fixture.admitFixtureBridge({ ...proof, ownerPid: -1 })).toThrow();
		let used: InstanceType<typeof fixture.BridgeConnection> | undefined;
		await expect(
			fixture.withBridgeConnection(async (connection) => {
				used = connection;
				await connection.sendCommand(
					{ type: 'board_command', value: 'cli' },
					'board_command_result'
				);
				throw new Error('action failed');
			})
		).rejects.toThrow('action failed');
		expect(used!.isOpen).toBe(false);
		vi.stubEnv('MAESTRO_E2E_TEST', 'changed-after-admission');
		await expect(fixture.withBridgeConnection(async () => 'unreachable')).rejects.toThrow(
			'parent admission'
		);
	});
});

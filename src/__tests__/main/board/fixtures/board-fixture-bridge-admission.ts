/** TEST ONLY. The parent passes this proof separately (IPC or a bundle literal), never discovery. */
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import {
	assertBoardIsolationPath,
	readBoardIsolationRegistries,
	requireBoardIsolation,
	type BoardIsolation,
} from '../../../../main/board/board-isolation';
import { canonicalJson } from '../../../../shared/canonicalJson';

export interface FixtureBridgeAdmission {
	contract: BoardIsolation;
	manifestPath: string;
	manifestSha256: string;
	ownerPid: number;
}

export interface FixtureBridgeManifest {
	version: 1;
	identity: string;
	ownerPid: number;
	url: string;
	cliSecret: string;
}

const MARKERS = [
	'BOARD_ISOLATION_ID',
	'BOARD_ISOLATION_CONTRACT',
	'BOARD_ISOLATED_ROOT',
	'BOARD_DB_PATH',
	'BOARD_SYNC_PATH',
	'BOARD_AGENT_REGISTRY',
	'BOARD_SOURCE_REGISTRY',
	'BOARD_SOURCE_ROOT',
	'MAESTRO_USER_DATA',
	'MAESTRO_DEMO_DIR',
	'MAESTRO_E2E_TEST',
] as const;

export function fixtureBridgeMarkers(): string {
	return canonicalJson(Object.fromEntries(MARKERS.map((key) => [key, process.env[key] ?? null])));
}

export function readFixtureBridgeManifest(
	proof: FixtureBridgeAdmission | undefined,
	markers: string
): FixtureBridgeManifest {
	const refuse = (): never => {
		throw new Error('Board fixture bridge refused: missing or changed parent admission');
	};
	if (
		!proof?.contract ||
		markers !== fixtureBridgeMarkers() ||
		process.env.BOARD_ISOLATION_CONTRACT !== canonicalJson(proof.contract) ||
		!/^[a-f0-9]{64}$/.test(proof.manifestSha256) ||
		![process.pid, process.ppid].includes(proof.ownerPid)
	)
		return refuse();
	const contract = requireBoardIsolation({ expected: proof.contract });
	// Admit every path before reading a registry or the endpoint/secret file.
	const file = assertBoardIsolationPath(contract, proof.manifestPath);
	const rootStat = fs.statSync(contract.root);
	const stat = fs.lstatSync(file);
	if (
		!stat.isFile() ||
		stat.nlink !== 1 ||
		stat.size > 16384 ||
		(process.getuid &&
			(stat.uid !== process.getuid() ||
				rootStat.uid !== process.getuid() ||
				(stat.mode & 0o077) !== 0 ||
				(rootStat.mode & 0o022) !== 0))
	)
		refuse();
	readBoardIsolationRegistries(contract);
	const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
	let bytes: Buffer;
	try {
		const opened = fs.fstatSync(fd);
		if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) refuse();
		const buffer = Buffer.alloc(16385);
		bytes = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0));
	} finally {
		fs.closeSync(fd);
	}
	if (createHash('sha256').update(bytes).digest('hex') !== proof.manifestSha256) refuse();
	const manifest = JSON.parse(bytes.toString('utf8')) as FixtureBridgeManifest;
	const endpoint =
		typeof manifest?.url === 'string' &&
		/^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/[A-Za-z0-9_-]{8,256}\/ws$/.exec(manifest.url);
	if (
		!endpoint ||
		Number(endpoint[1]) > 65535 ||
		manifest.version !== 1 ||
		manifest.identity !== contract.identity ||
		manifest.ownerPid !== proof.ownerPid ||
		typeof manifest.cliSecret !== 'string' ||
		!/^[A-Za-z0-9_-]{16,256}$/.test(manifest.cliSecret)
	)
		refuse();
	return manifest;
}

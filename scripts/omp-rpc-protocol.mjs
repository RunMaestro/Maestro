import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

export const OMP_RPC_DEFAULT_MAX_FRAME_BYTES = 1_048_576;
export const OMP_RPC_DEFAULT_SERVER_MAX_REASSEMBLED_BYTES = 67_108_864;
export const MAESTRO_RPC_MAX_REASSEMBLED_BYTES = 8_388_608;
const MAX_CHUNK_COUNT = 65_536;
const MAX_CHUNK_ID_LENGTH = 128;
const MAX_STDERR_BYTES = 65_536;

function isRecord(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(text, label) {
	let value;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new Error(
			`${label} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`
		);
	}
	if (!isRecord(value)) {
		throw new Error(`${label} must contain a JSON object`);
	}
	return value;
}

export class JsonLineDecoder {
	#buffer = Buffer.alloc(0);
	#maxFrameBytes;

	constructor({ maxFrameBytes = OMP_RPC_DEFAULT_MAX_FRAME_BYTES } = {}) {
		if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
			throw new TypeError('maxFrameBytes must be a positive safe integer');
		}
		this.#maxFrameBytes = maxFrameBytes;
	}

	get bufferedBytes() {
		return this.#buffer.byteLength;
	}

	push(chunk) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (bytes.byteLength === 0) return [];
		this.#buffer = this.#buffer.byteLength === 0 ? bytes : Buffer.concat([this.#buffer, bytes]);
		const frames = [];
		let start = 0;
		for (;;) {
			const newline = this.#buffer.indexOf(0x0a, start);
			if (newline === -1) break;
			let end = newline;
			if (end > start && this.#buffer[end - 1] === 0x0d) end -= 1;
			const frameLength = end - start;
			if (frameLength > this.#maxFrameBytes) {
				this.#buffer = Buffer.alloc(0);
				throw new Error(
					`RPC physical frame limit exceeded: ${frameLength} > ${this.#maxFrameBytes}`
				);
			}
			if (frameLength > 0) {
				const text = new TextDecoder('utf-8', { fatal: true }).decode(
					this.#buffer.subarray(start, end)
				);
				frames.push(parseJsonObject(text, 'RPC JSONL frame'));
			}
			start = newline + 1;
		}
		this.#buffer = start === 0 ? this.#buffer : this.#buffer.subarray(start);
		if (this.#buffer.byteLength > this.#maxFrameBytes) {
			const length = this.#buffer.byteLength;
			this.#buffer = Buffer.alloc(0);
			throw new Error(`RPC physical frame limit exceeded: ${length} > ${this.#maxFrameBytes}`);
		}
		return frames;
	}

	flush() {
		if (this.#buffer.byteLength === 0) return;
		const remaining = this.#buffer;
		this.#buffer = Buffer.alloc(0);
		if (remaining.toString('utf8').trim().length === 0) return;
		throw new Error(
			`RPC stdout ended with a truncated JSONL frame (${remaining.byteLength} bytes)`
		);
	}
}

export function validateReadyFrame(frame) {
	if (!isRecord(frame) || frame.type !== 'ready') {
		throw new Error('first RPC frame must be a ready object');
	}
	const { protocolVersion, supportedProtocolVersions, maxFrameBytes, maxReassembledFrameBytes } =
		frame;
	if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) {
		throw new Error('ready.protocolVersion must be a positive integer');
	}
	if (
		!Array.isArray(supportedProtocolVersions) ||
		supportedProtocolVersions.length === 0 ||
		!supportedProtocolVersions.every((version) => Number.isSafeInteger(version) && version > 0)
	) {
		throw new Error('ready.supportedProtocolVersions must contain positive integers');
	}
	if (!supportedProtocolVersions.includes(protocolVersion)) {
		throw new Error('ready protocolVersion is absent from supportedProtocolVersions');
	}
	if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
		throw new Error('ready.maxFrameBytes must be a positive safe integer');
	}
	if (!Number.isSafeInteger(maxReassembledFrameBytes) || maxReassembledFrameBytes < maxFrameBytes) {
		throw new Error(
			'ready reassembled limit must be a safe integer at least as large as maxFrameBytes'
		);
	}
	return {
		protocolVersion,
		supportedProtocolVersions: [...supportedProtocolVersions],
		maxFrameBytes,
		maxReassembledFrameBytes,
	};
}

export function clampTransportLimits(
	limits,
	{
		maxFrameBytes = OMP_RPC_DEFAULT_MAX_FRAME_BYTES,
		maxReassembledFrameBytes = MAESTRO_RPC_MAX_REASSEMBLED_BYTES,
	} = {}
) {
	if (!isRecord(limits)) throw new TypeError('transport limits must be an object');
	return {
		maxFrameBytes: Math.min(limits.maxFrameBytes, maxFrameBytes),
		maxReassembledFrameBytes: Math.min(limits.maxReassembledFrameBytes, maxReassembledFrameBytes),
	};
}

function decodeCanonicalBase64(data) {
	if (
		typeof data !== 'string' ||
		data.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
	) {
		throw new Error('rpc_chunk.data must be canonical base64');
	}
	const bytes = Buffer.from(data, 'base64');
	if (bytes.toString('base64') !== data) {
		throw new Error('rpc_chunk.data must be canonical base64');
	}
	return bytes;
}

function validateChunk(frame, maxReassembledFrameBytes) {
	if (!isRecord(frame) || frame.type !== 'rpc_chunk') {
		throw new Error('expected an rpc_chunk object');
	}
	if (
		typeof frame.chunkId !== 'string' ||
		frame.chunkId.length === 0 ||
		frame.chunkId.length > MAX_CHUNK_ID_LENGTH
	) {
		throw new Error('rpc_chunk.chunkId must be a bounded non-empty string');
	}
	if (!Number.isSafeInteger(frame.index) || frame.index < 0) {
		throw new Error('rpc_chunk.index must be a non-negative safe integer');
	}
	if (!Number.isSafeInteger(frame.count) || frame.count < 1 || frame.count > MAX_CHUNK_COUNT) {
		throw new Error(`rpc_chunk.count must be between 1 and ${MAX_CHUNK_COUNT}`);
	}
	if (frame.index >= frame.count) {
		throw new Error('rpc_chunk.index must be smaller than count');
	}
	if (
		!Number.isSafeInteger(frame.byteLength) ||
		frame.byteLength < 0 ||
		frame.byteLength > maxReassembledFrameBytes
	) {
		throw new Error(
			`RPC logical frame limit exceeded: ${String(frame.byteLength)} > ${maxReassembledFrameBytes}`
		);
	}
	return { ...frame, bytes: decodeCanonicalBase64(frame.data) };
}

export class RpcV2FrameDecoder {
	#active = null;
	#maxReassembledFrameBytes;

	constructor({ maxReassembledFrameBytes = MAESTRO_RPC_MAX_REASSEMBLED_BYTES } = {}) {
		if (!Number.isSafeInteger(maxReassembledFrameBytes) || maxReassembledFrameBytes < 1) {
			throw new TypeError('maxReassembledFrameBytes must be a positive safe integer');
		}
		this.#maxReassembledFrameBytes = maxReassembledFrameBytes;
	}

	get hasActiveSequence() {
		return this.#active !== null;
	}

	reset() {
		this.#active = null;
	}

	push(frame) {
		if (!isRecord(frame)) throw new Error('RPC frame must be a JSON object');
		if (frame.type !== 'rpc_chunk') {
			if (this.#active) {
				this.reset();
				throw new Error('RPC chunk sequence was interrupted by an ordinary frame');
			}
			return frame;
		}

		try {
			const chunk = validateChunk(frame, this.#maxReassembledFrameBytes);
			if (!this.#active) {
				if (chunk.index !== 0) throw new Error('RPC chunk sequence must start at index 0');
				this.#active = {
					chunkId: chunk.chunkId,
					count: chunk.count,
					byteLength: chunk.byteLength,
					nextIndex: 0,
					receivedBytes: 0,
					chunks: [],
				};
			}
			const active = this.#active;
			if (chunk.chunkId !== active.chunkId)
				throw new Error('RPC chunk sequences cannot be interleaved');
			if (chunk.count !== active.count)
				throw new Error('RPC chunk count changed during reassembly');
			if (chunk.byteLength !== active.byteLength) {
				throw new Error('RPC chunk byteLength changed during reassembly');
			}
			if (chunk.index !== active.nextIndex) {
				throw new Error(
					`RPC chunk index out of order: expected ${active.nextIndex}, got ${chunk.index}`
				);
			}
			active.receivedBytes += chunk.bytes.byteLength;
			if (
				active.receivedBytes > active.byteLength ||
				active.receivedBytes > this.#maxReassembledFrameBytes
			) {
				throw new Error('RPC chunk payload exceeds its declared or configured logical frame limit');
			}
			active.chunks.push(chunk.bytes);
			active.nextIndex += 1;
			if (active.nextIndex < active.count) return null;
			if (active.receivedBytes !== active.byteLength) {
				throw new Error(
					`RPC chunk byteLength mismatch: expected ${active.byteLength}, received ${active.receivedBytes}`
				);
			}
			const bytes = Buffer.concat(active.chunks, active.receivedBytes);
			this.reset();
			let text;
			try {
				text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
			} catch (error) {
				throw new Error(
					`RPC logical frame contains invalid UTF-8: ${error instanceof Error ? error.message : String(error)}`
				);
			}
			return parseJsonObject(text, 'RPC logical frame');
		} catch (error) {
			this.reset();
			throw error;
		}
	}
}

export function summarizeProtocolFrame(frame) {
	if (!isRecord(frame)) {
		return { type: null, idPresent: false, command: null, success: null, keys: [] };
	}
	return {
		type: typeof frame.type === 'string' ? frame.type : null,
		idPresent: typeof frame.id === 'string',
		command: typeof frame.command === 'string' ? frame.command : null,
		success: typeof frame.success === 'boolean' ? frame.success : null,
		keys: Object.keys(frame).sort(),
	};
}

function replaceCaseInsensitive(value, search, replacement) {
	if (!search) return value;
	const lowerValue = value.toLowerCase();
	const lowerSearch = search.toLowerCase();
	let cursor = 0;
	let result = '';
	for (;;) {
		const found = lowerValue.indexOf(lowerSearch, cursor);
		if (found === -1) return result + value.slice(cursor);
		result += value.slice(cursor, found) + replacement;
		cursor = found + search.length;
	}
}

export function redactConformanceReport(report) {
	if (!isRecord(report)) throw new TypeError('conformance report must be an object');
	const executable = typeof report.executable === 'string' ? report.executable : '';
	const workspace = typeof report.workspace === 'string' ? report.workspace : '';
	const visit = (value) => {
		if (typeof value === 'string') {
			return replaceCaseInsensitive(
				replaceCaseInsensitive(value, workspace, '<isolated-workspace>'),
				executable,
				'<explicit-omp-executable>'
			);
		}
		if (Array.isArray(value)) return value.map(visit);
		if (!isRecord(value)) return value;
		return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, visit(child)]));
	};
	return visit(report);
}

export class RpcProcessPeer {
	#child;
	#lineDecoder;
	#chunkDecoder;
	#pending = new Map();
	#waiters = new Set();
	#closed = false;
	#readySeen = false;
	#stderr = '';
	#onFrame;
	#readyResolve;
	#readyReject;
	ready;

	constructor({
		executable,
		args,
		cwd,
		env,
		onFrame,
		maxFrameBytes = OMP_RPC_DEFAULT_MAX_FRAME_BYTES,
	}) {
		if (typeof executable !== 'string' || executable.length === 0) {
			throw new TypeError('executable is required');
		}
		this.#lineDecoder = new JsonLineDecoder({ maxFrameBytes });
		this.#chunkDecoder = new RpcV2FrameDecoder();
		this.#onFrame = onFrame;
		this.ready = new Promise((resolve, reject) => {
			this.#readyResolve = resolve;
			this.#readyReject = reject;
		});
		this.#child = spawn(executable, args, {
			cwd,
			env,
			shell: false,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.#child.stdout.on('data', (chunk) => this.#receive(chunk));
		this.#child.stderr.on('data', (chunk) => {
			if (Buffer.byteLength(this.#stderr) >= MAX_STDERR_BYTES) return;
			this.#stderr += chunk.toString('utf8').slice(0, MAX_STDERR_BYTES - this.#stderr.length);
		});
		this.#child.on('error', (error) => this.#terminate(error));
		this.#child.on('close', (code, signal) => {
			try {
				this.#lineDecoder.flush();
			} catch (error) {
				this.#terminate(error);
				return;
			}
			this.#terminate(
				new Error(`OMP RPC process exited (code=${String(code)}, signal=${String(signal)})`)
			);
		});
	}

	get stderr() {
		return this.#stderr;
	}

	get closed() {
		return this.#closed;
	}

	send(frame) {
		if (this.#closed || !this.#child.stdin.writable) throw new Error('OMP RPC process is closed');
		this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
	}

	sendRaw(line) {
		if (this.#closed || !this.#child.stdin.writable) throw new Error('OMP RPC process is closed');
		this.#child.stdin.write(line.endsWith('\n') ? line : `${line}\n`);
	}

	request(type, params = {}, timeoutMs = 10_000) {
		const id = `maestro-${randomUUID()}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`timed out waiting for RPC ${type} response`));
			}, timeoutMs);
			this.#pending.set(id, { type, resolve, reject, timer });
			try {
				this.send({ id, type, ...params });
			} catch (error) {
				clearTimeout(timer);
				this.#pending.delete(id);
				reject(error);
			}
		});
	}

	waitForFrame(predicate, timeoutMs = 10_000, description = 'RPC frame') {
		return new Promise((resolve, reject) => {
			const waiter = {
				predicate,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.#waiters.delete(waiter);
					reject(new Error(`timed out waiting for ${description}`));
				}, timeoutMs),
			};
			this.#waiters.add(waiter);
		});
	}

	async close({ timeoutMs = 2_000 } = {}) {
		if (this.#closed) return;
		const child = this.#child;
		const closed = new Promise((resolve) => child.once('close', resolve));
		let killTimer;
		const forced = new Promise((resolve) => {
			killTimer = setTimeout(() => {
				if (!this.#closed) child.kill();
				resolve();
			}, timeoutMs);
		});
		child.stdin.end();
		try {
			await Promise.race([closed, forced]);
		} finally {
			clearTimeout(killTimer);
		}
	}

	#receive(chunk) {
		try {
			for (const physicalFrame of this.#lineDecoder.push(chunk)) {
				const logicalFrame = this.#chunkDecoder.push(physicalFrame);
				if (logicalFrame) this.#dispatch(logicalFrame);
			}
		} catch (error) {
			this.#terminate(error);
			this.#child.kill();
		}
	}

	#dispatch(frame) {
		if (frame.type !== 'ready' && !this.#readySeen) {
			throw new Error('first RPC frame must be ready');
		}
		if (frame.type === 'ready' && this.#readySeen) {
			throw new Error('RPC stream emitted more than one ready frame');
		}
		if (frame.type === 'ready') {
			const ready = validateReadyFrame(frame);
			const limits = clampTransportLimits(ready);
			this.#chunkDecoder = new RpcV2FrameDecoder({
				maxReassembledFrameBytes: limits.maxReassembledFrameBytes,
			});
			this.#lineDecoder = new JsonLineDecoder({ maxFrameBytes: limits.maxFrameBytes });
			this.#readySeen = true;
			this.#readyResolve(frame);
		}
		if (frame.type === 'response' && typeof frame.id === 'string') {
			const pending = this.#pending.get(frame.id);
			if (pending) {
				clearTimeout(pending.timer);
				this.#pending.delete(frame.id);
				pending.resolve(frame);
			}
		}
		for (const waiter of [...this.#waiters]) {
			let matches = false;
			try {
				matches = waiter.predicate(frame);
			} catch (error) {
				clearTimeout(waiter.timer);
				this.#waiters.delete(waiter);
				waiter.reject(error);
				continue;
			}
			if (!matches) continue;
			clearTimeout(waiter.timer);
			this.#waiters.delete(waiter);
			waiter.resolve(frame);
		}
		this.#onFrame?.(frame, this);
	}

	#terminate(error) {
		if (this.#closed) return;
		this.#closed = true;
		this.#readyReject(error);
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
		for (const waiter of this.#waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.#waiters.clear();
	}
}

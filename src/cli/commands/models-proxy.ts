// `maestro-cli models proxy status` and `maestro-cli models proxy block <hash>`
// - the Maestro token proxy, read from the command line.
//
// Both run in the desktop over the WS bridge and answer with the same records
// the `localModels:proxy:*` IPC channels do, which is what Settings -> Local
// Models -> Gateway draws: `status` is the whole report (the listener, the
// agents on it with their mode, tokens saved and added latency for the last 30
// days, and the blocks it last shortened), and `block` is both sides of one
// compressed block from the content-addressed cache. `--original --lines
// start:end` recovers exact inclusive lines, with completeness on stderr or
// in the existing JSON block envelope. Token totals still describe the full block.
//
// Neither changes anything. An agent's mode is set with
// `maestro-cli update-agent <agent> --proxy-mode <off|passthrough|compress>`.
//
// Exit codes, for scripts: `status` exits 0 unless the proxy failed to start
// (its port is held by another program). A proxy that is not set up, or is
// stopped because no agent uses it, is not a failure. `block` exits non-zero
// for a hash the cache holds no compressed block for, an invalid range, or a
// range the desktop cannot recover or confirm.

import { createPatch } from 'diff';
import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitWith } from '../exit-codes';
import { formatTokenProxyBlockHeader, formatTokenProxyReport } from '../output/formatter';
import {
	validateTokenProxyOriginalLineRange,
	type TokenProxyOriginalLineRange,
	type TokenProxyBlockDetail,
	type TokenProxyReport,
} from '../../shared/local-models/token-proxy';
import { failCommand, failFromError } from '../services/session-command';

/** A stats read and a few small files in the app. */
const PROXY_TIMEOUT_MS = 10_000;

interface StatusOptions {
	json?: boolean;
}

export async function modelsProxyStatus(options: StatusOptions): Promise<void> {
	let reply: { success: boolean; report?: TokenProxyReport; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'local_models_proxy_status' },
				'local_models_proxy_status_result',
				PROXY_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}

	if (!reply.success || !reply.report) {
		failCommand(reply.error || 'Proxy status check failed', options.json);
	}
	const report = reply.report;
	// A start that failed is the one state a script must not read as healthy:
	// agents that point at the proxy cannot start a turn.
	const ok = report.status.running || report.status.lastError === null;

	if (options.json) console.log(JSON.stringify({ success: ok, ...report }));
	else console.log(formatTokenProxyReport(report));
	if (!ok) exitWith(ExitCode.GeneralError);
}

interface BlockOptions {
	original?: boolean;
	compressed?: boolean;
	lines?: string;
	json?: boolean;
}

export async function modelsProxyBlock(hash: string, options: BlockOptions): Promise<void> {
	if (options.original && options.compressed) {
		failCommand('Use --original or --compressed, not both.', options.json, ExitCode.InvalidUsage);
	}

	let range: TokenProxyOriginalLineRange | undefined;
	if (options.lines !== undefined) {
		if (!options.original || options.compressed) {
			failCommand(
				'--lines requires --original without --compressed.',
				options.json,
				ExitCode.InvalidUsage
			);
		}
		const bounds = /^(\d+):(\d+)$/.exec(options.lines);
		if (!bounds || bounds[0] !== options.lines) {
			failCommand(
				'--lines expects start:end (inclusive, 1-based lines).',
				options.json,
				ExitCode.InvalidUsage
			);
		}
		try {
			range = validateTokenProxyOriginalLineRange({
				startLine: Number(bounds[1]),
				endLine: Number(bounds[2]),
			});
		} catch (error) {
			if (!(error instanceof RangeError)) throw error;
			failCommand(error.message, options.json, ExitCode.InvalidUsage);
		}
	}

	let reply: { success: boolean; block?: TokenProxyBlockDetail | null; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{
					type: 'local_models_proxy_block',
					hash: hash.trim().toLowerCase(),
					...(range && { range }),
				},
				'local_models_proxy_block_result',
				PROXY_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}

	if (!reply.success) failCommand(reply.error || 'Could not read the block', options.json);
	const block = reply.block;
	if (!block) failCommand(`The proxy cache holds no compressed block for ${hash}.`, options.json);

	if (range) {
		if (block.original === null) {
			failCommand('The original text is no longer in the cache.', options.json);
		}
		const info = block.originalRange;
		if (
			!info ||
			info.hash !== block.hash ||
			info.source !== 'original' ||
			info.requested?.startLine !== range.startLine ||
			info.requested?.endLine !== range.endLine
		) {
			failCommand(
				'The desktop did not confirm the requested original line range. Update Maestro and try again.',
				options.json,
				ExitCode.Unsupported
			);
		}
		if (options.json) console.log(JSON.stringify({ success: true, block }));
		else {
			const returned = info.returned
				? `${info.returned.startLine}:${info.returned.endLine}`
				: 'none';
			console.error(
				`Original ${info.hash}: requested ${range.startLine}:${range.endLine}; returned ${returned}; complete=${info.complete}; hasMore=${info.hasMore}`
			);
			process.stdout.write(block.original);
		}
		return;
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, block }));
		return;
	}
	if (options.compressed) {
		console.log(block.compressed);
		return;
	}
	if (block.original === null) {
		failCommand(
			'The original text is no longer in the cache. Use --compressed to print what was sent.',
			options.json
		);
	}
	if (options.original) {
		console.log(block.original);
		return;
	}
	console.log(formatTokenProxyBlockHeader(block));
	console.log(
		createPatch(
			'tool-result',
			block.original,
			block.compressed,
			'sent by the agent',
			'sent to the provider'
		)
	);
}

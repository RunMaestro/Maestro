// `maestro-cli models proxy status` and `maestro-cli models proxy block <hash>`
// - the Maestro token proxy, read from the command line.
//
// Both run in the desktop over the WS bridge and answer with the same records
// the `localModels:proxy:*` IPC channels do, which is what Settings -> Local
// Models -> Gateway draws: `status` is the whole report (the listener, the
// agents on it with their mode, tokens saved and added latency for the last 30
// days, and the blocks it last shortened), and `block` is both sides of one
// compressed block from the content-addressed cache.
//
// Neither changes anything. An agent's mode is set with
// `maestro-cli update-agent <agent> --proxy-mode <off|passthrough|compress>`.
//
// Exit codes, for scripts: `status` exits 0 unless the proxy failed to start
// (its port is held by another program). A proxy that is not set up, or is
// stopped because no agent uses it, is not a failure. `block` exits non-zero
// for a hash the cache holds no compressed block for.

import { createPatch } from 'diff';
import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitWith } from '../exit-codes';
import { formatTokenProxyBlockHeader, formatTokenProxyReport } from '../output/formatter';
import type {
	TokenProxyBlockDetail,
	TokenProxyReport,
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
	json?: boolean;
}

export async function modelsProxyBlock(hash: string, options: BlockOptions): Promise<void> {
	if (options.original && options.compressed) {
		failCommand('Use --original or --compressed, not both.', options.json, ExitCode.InvalidUsage);
	}

	let reply: { success: boolean; block?: TokenProxyBlockDetail | null; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'local_models_proxy_block', hash: hash.trim().toLowerCase() },
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

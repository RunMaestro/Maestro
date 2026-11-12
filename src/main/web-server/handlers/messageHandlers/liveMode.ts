/**
 * Live Mode WebSocket message handlers: `maestro-cli live`.
 *
 * Handles: live_status, live_start, live_stop, live_tunnel_start,
 * live_tunnel_stop. Every one calls the Live Mode service the LIVE panel's IPC
 * handlers call, so the CLI and the panel cannot drift. CLI sockets only.
 *
 * Turning Live on or off REPLACES the server this socket is connected to (the
 * loopback CLI server and the LAN server share one slot). So those two answer
 * FIRST with `restarting: true`, and only swap the server once the answer has
 * been written to the socket. The CLI then reconnects through the refreshed
 * discovery file and reads `live_status` to learn the outcome.
 */

import { logger } from '../../../utils/logger';
import { isCloudflaredInstalled } from '../../../utils/cliDetection';
import {
	getLiveModeDependencies,
	getLiveModeState,
	isLiveModeOn,
	startLiveServer,
	startTunnel,
	stopTunnel,
	turnLiveModeOff,
	type LiveModeDependencies,
} from '../../live-mode';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Admit the CLI only, then resolve the registered deps; answer with an error
 * otherwise. The same server answers LAN and tunnel browsers, and none of them
 * may start or stop the host's web interface or open it to the internet.
 */
function requireDeps(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage,
	responseType: string
): LiveModeDependencies | null {
	if (!client.cli) {
		logger.warn(`Refused ${message.type} from non-CLI client ${client.id}`, 'Live');
		ctx.send(client, {
			type: responseType,
			success: false,
			error: 'Live mode cannot be switched over the web interface',
			requestId: message.requestId,
		});
		return null;
	}
	const deps = getLiveModeDependencies();
	if (!deps) {
		ctx.send(client, {
			type: responseType,
			success: false,
			error: 'Live mode control is not ready yet. Retry once the app has finished starting.',
			requestId: message.requestId,
		});
	}
	return deps;
}

/**
 * Write the answer, then run `swap` once it is on the wire. The swap closes
 * this socket, so sending after it (or racing it) would lose the answer.
 */
function answerThenSwap(
	client: WebClient,
	data: Record<string, unknown>,
	swap: () => Promise<{ success: boolean; error?: string }>,
	label: string
): void {
	const run = () => {
		void swap()
			.then((result) => {
				if (!result.success) {
					logger.error(`${label} failed: ${result.error ?? 'unknown error'}`, 'Live');
				}
			})
			.catch((error: unknown) => {
				logger.error(`${label} threw: ${String(error)}`, 'Live');
			});
	};
	try {
		client.socket.send(JSON.stringify({ ...data, timestamp: Date.now() }), () => run());
	} catch {
		// The socket died before the answer could go out. The caller still asked
		// for the change, and it will see the outcome through `live status`.
		run();
	}
}

/** live_status - Live Mode state, plus whether cloudflared is installed. */
export async function handleLiveStatus(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const deps = requireDeps(ctx, client, message, 'live_status_result');
	if (!deps) return;
	const state = getLiveModeState(deps.getWebServer());
	const cloudflaredInstalled = await isCloudflaredInstalled();
	ctx.send(client, {
		type: 'live_status_result',
		success: true,
		...state,
		cloudflaredInstalled,
		requestId: message.requestId,
	});
}

/** live_start - turn the web interface on. */
export function handleLiveStart(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const deps = requireDeps(ctx, client, message, 'live_start_result');
	if (!deps) return;
	const webServer = deps.getWebServer();
	if (isLiveModeOn(webServer)) {
		ctx.send(client, {
			type: 'live_start_result',
			success: true,
			restarting: false,
			...getLiveModeState(webServer),
			requestId: message.requestId,
		});
		return;
	}
	answerThenSwap(
		client,
		{ type: 'live_start_result', success: true, restarting: true, requestId: message.requestId },
		() => startLiveServer(deps),
		'Live mode start'
	);
}

/** live_stop - stop the tunnel and the web interface, as the panel's toggle does. */
export function handleLiveStop(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const deps = requireDeps(ctx, client, message, 'live_stop_result');
	if (!deps) return;
	const webServer = deps.getWebServer();
	if (!isLiveModeOn(webServer)) {
		// Nothing to replace, so no reconnect. A tunnel cannot outlive Live in
		// normal use, but stop it anyway so `live off` always leaves it off.
		void stopTunnel(webServer).then(
			() => {
				ctx.send(client, {
					type: 'live_stop_result',
					success: true,
					restarting: false,
					...getLiveModeState(deps.getWebServer()),
					requestId: message.requestId,
				});
			},
			(error: unknown) => {
				ctx.send(client, {
					type: 'live_stop_result',
					success: false,
					error: `Failed to stop the tunnel: ${String(error)}`,
					requestId: message.requestId,
				});
			}
		);
		return;
	}
	answerThenSwap(
		client,
		{ type: 'live_stop_result', success: true, restarting: true, requestId: message.requestId },
		() => turnLiveModeOff(deps),
		'Live mode stop'
	);
}

/** live_tunnel_start - start the Cloudflare tunnel (Live must be on). */
export async function handleLiveTunnelStart(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const deps = requireDeps(ctx, client, message, 'live_tunnel_start_result');
	if (!deps) return;
	try {
		const result = await startTunnel(deps.getWebServer());
		ctx.send(client, {
			type: 'live_tunnel_start_result',
			...result,
			requestId: message.requestId,
		});
	} catch (error) {
		ctx.send(client, {
			type: 'live_tunnel_start_result',
			success: false,
			error: error instanceof Error ? error.message : String(error),
			requestId: message.requestId,
		});
	}
}

/** live_tunnel_stop - stop the Cloudflare tunnel. */
export async function handleLiveTunnelStop(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const deps = requireDeps(ctx, client, message, 'live_tunnel_stop_result');
	if (!deps) return;
	try {
		await stopTunnel(deps.getWebServer());
		ctx.send(client, {
			type: 'live_tunnel_stop_result',
			success: true,
			...getLiveModeState(deps.getWebServer()),
			requestId: message.requestId,
		});
	} catch (error) {
		ctx.send(client, {
			type: 'live_tunnel_stop_result',
			success: false,
			error: error instanceof Error ? error.message : String(error),
			requestId: message.requestId,
		});
	}
}

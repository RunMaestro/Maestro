/**
 * Resolve the `src` a media element loads a local file from.
 *
 * `fs:readFile` hands back a `maestro-media://` stream URL for audio and video.
 * The Electron desktop app plays it as-is through the protocol handler in
 * `src/main/index.ts`. The web-desktop browser bundle cannot: a browser has no
 * handler for the scheme, the element fires `error`, and the player shows
 * "Cannot Play This File" for a file that is perfectly playable. There the same
 * handler is reachable over HTTP on the embedded web server, so this is the one
 * place that picks between the two addresses (the Concerto iframe does the same
 * in `concertoHtmlSrc.ts`).
 */

import { buildMediaStreamHttpPath } from '../../shared/mediaTypes';
import { isWebDesktop } from './runtimeContext';

export function resolveMediaStreamSrc(streamUrl: string): string {
	if (!isWebDesktop()) return streamUrl;
	const securityToken = (window as { __MAESTRO_CONFIG__?: { securityToken?: unknown } })
		.__MAESTRO_CONFIG__?.securityToken;
	if (typeof securityToken !== 'string') return streamUrl;
	// An older server has no media route; the scheme URL fails to load either
	// way, and the player's error card is the right answer for it.
	return buildMediaStreamHttpPath(securityToken, streamUrl) ?? streamUrl;
}

/**
 * Web Server Collector
 *
 * Collects web server and tunnel state.
 * - No actual URLs or tokens included
 */

import { WebServer } from '../../web-server';
import { tunnelManager } from '../../tunnel-manager';
import { isCloudflaredInstalled } from '../../utils/cliDetection';

export interface WebServerInfo {
	isRunning: boolean;
	port?: number;
	connectedClients: number;
	liveSessions: Array<{
		sessionId: string;
		enabledAt: number;
	}>;
	tunnel: {
		cloudflaredInstalled: boolean;
		isRunning: boolean;
		hasUrl: boolean;
		error?: string;
	};
}

/**
 * Collect web server state information.
 */
export async function collectWebServer(webServer: WebServer | null): Promise<WebServerInfo> {
	const result: WebServerInfo = {
		isRunning: false,
		connectedClients: 0,
		liveSessions: [],
		tunnel: {
			cloudflaredInstalled: false,
			isRunning: false,
			hasUrl: false,
		},
	};

	// Get web server state
	if (webServer) {
		result.isRunning = webServer.isActive();
		result.port = webServer.getPort();
		result.connectedClients = webServer.getWebClientCount();

		// Get live sessions (just IDs, not content)
		const liveSessions = webServer.getLiveSessions() || [];
		result.liveSessions = liveSessions.map((session: any) => ({
			sessionId: session.id || session.sessionId || 'unknown',
			enabledAt: session.enabledAt || Date.now(),
		}));
	}

	// Check cloudflared installation
	try {
		result.tunnel.cloudflaredInstalled = await isCloudflaredInstalled();
	} catch {
		result.tunnel.cloudflaredInstalled = false;
	}

	// Get tunnel status
	try {
		const tunnelStatus = tunnelManager.getStatus();
		result.tunnel.isRunning = tunnelStatus.isRunning || false;
		result.tunnel.hasUrl = !!tunnelStatus.url;
		result.tunnel.error = tunnelStatus.error || undefined;
	} catch {
		// Tunnel status unavailable
	}

	return result;
}

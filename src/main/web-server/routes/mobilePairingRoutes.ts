/**
 * Mobile Pairing Routes for Web Server
 *
 * Public (non-token-protected) routes for mobile device pairing.
 * The security model relies on the short-lived pairing code instead of the security token.
 *
 * API Endpoints:
 * - POST /api/mobile-pairing/redeem - Exchange pairing code for long-lived token
 */

import { FastifyInstance } from 'fastify';
import { logger } from '../../utils/logger';

// Logger context for all mobile pairing route logs
const LOG_CONTEXT = 'WebServer:MobilePairing';

/**
 * Result of redeeming a pairing code
 */
export interface RedeemCodeResult {
	token: string;
	deviceId: string;
}

/**
 * Callbacks required by mobile pairing routes
 */
export interface MobilePairingRouteCallbacks {
	redeemPairingCode: (code: string, deviceName: string) => Promise<RedeemCodeResult | null>;
}

/**
 * Mobile Pairing Routes Class
 *
 * Handles device pairing without requiring the security token.
 * Security is provided by the short-lived pairing code.
 */
export class MobilePairingRoutes {
	private callbacks: Partial<MobilePairingRouteCallbacks> = {};

	/**
	 * Set the callbacks for mobile pairing operations
	 */
	setCallbacks(callbacks: MobilePairingRouteCallbacks): void {
		this.callbacks = callbacks;
	}

	/**
	 * Register mobile pairing routes on the Fastify server
	 */
	registerRoutes(server: FastifyInstance): void {
		// POST /api/mobile-pairing/redeem - Exchange pairing code for token
		// This endpoint is public (no security token required) because:
		// 1. The pairing code itself is the authentication mechanism
		// 2. Codes are short-lived (5 minutes) and single-use
		// 3. The code must be obtained from the desktop via QR code
		server.post(
			'/api/mobile-pairing/redeem',
			{
				config: {
					rateLimit: {
						max: 10, // Very restrictive: 10 attempts per minute
						timeWindow: 60000,
					},
				},
			},
			async (request, reply) => {
				const body = request.body as { code?: string; deviceName?: string } | undefined;
				const code = body?.code;
				const deviceName = body?.deviceName;

				if (!code || typeof code !== 'string') {
					return reply.code(400).send({
						error: 'Bad Request',
						message: 'Pairing code is required',
						timestamp: Date.now(),
					});
				}

				if (!this.callbacks.redeemPairingCode) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Pairing service not configured',
						timestamp: Date.now(),
					});
				}

				try {
					const result = await this.callbacks.redeemPairingCode(
						code,
						deviceName || 'Unknown Device'
					);

					if (!result) {
						// Code not found, expired, or already used
						return reply.code(401).send({
							error: 'Unauthorized',
							message: 'Invalid or expired pairing code',
							timestamp: Date.now(),
						});
					}

					logger.info(`Mobile device paired: ${deviceName}`, LOG_CONTEXT);

					return {
						success: true,
						token: result.token,
						deviceId: result.deviceId,
						timestamp: Date.now(),
					};
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : 'Unknown error';
					logger.error(`Failed to redeem pairing code: ${message}`, LOG_CONTEXT, error);

					return reply.code(500).send({
						error: 'Internal Server Error',
						message: 'Failed to redeem pairing code',
						timestamp: Date.now(),
					});
				}
			}
		);

		logger.debug('Mobile pairing routes registered', LOG_CONTEXT);
	}
}

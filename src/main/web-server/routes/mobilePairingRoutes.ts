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

// Surface-level validation. The module enforces the same bounds, but rejecting
// junk at the HTTP boundary keeps log noise down and short-circuits map lookups
// on oversized strings.
const CODE_PATTERN = /^[A-Z2-7]{6}$/;
const MAX_DEVICE_NAME_LENGTH = 200;

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
				const rawCode = body?.code;
				const rawDeviceName = body?.deviceName;

				if (typeof rawCode !== 'string') {
					return reply.code(400).send({
						error: 'Bad Request',
						message: 'Pairing code is required',
						timestamp: Date.now(),
					});
				}
				const normalizedCode = rawCode.toUpperCase().trim();
				if (!CODE_PATTERN.test(normalizedCode)) {
					return reply.code(400).send({
						error: 'Bad Request',
						message: 'Pairing code must be 6 base32 characters',
						timestamp: Date.now(),
					});
				}

				if (rawDeviceName !== undefined && typeof rawDeviceName !== 'string') {
					return reply.code(400).send({
						error: 'Bad Request',
						message: 'deviceName must be a string',
						timestamp: Date.now(),
					});
				}
				if (typeof rawDeviceName === 'string' && rawDeviceName.length > MAX_DEVICE_NAME_LENGTH) {
					return reply.code(400).send({
						error: 'Bad Request',
						message: `deviceName must be at most ${MAX_DEVICE_NAME_LENGTH} characters`,
						timestamp: Date.now(),
					});
				}
				const deviceName =
					typeof rawDeviceName === 'string' && rawDeviceName.trim().length > 0
						? rawDeviceName.trim()
						: 'Unknown Device';

				if (!this.callbacks.redeemPairingCode) {
					return reply.code(503).send({
						error: 'Service Unavailable',
						message: 'Pairing service not configured',
						timestamp: Date.now(),
					});
				}

				try {
					const result = await this.callbacks.redeemPairingCode(normalizedCode, deviceName);

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

import type { WebServer } from '../WebServer';
import type { WebServerFactoryDependencies } from '../web-server-factory';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { requestFromRenderer } from './remoteRequest';
import {
	normalizeThroughputGaugeCommandResult,
	type ThroughputGaugeCommandRequest,
	type ThroughputGaugeCommandResult,
} from '../../../shared/throughputGaugeCommands';

/**
 * `maestro-cli throughput-gauge` is a ROUND TRIP to the PRIMARY window: it owns
 * the rate engine and the gauge store, so it is the one window whose answer is
 * the live reading. A renderer that never answers resolves to a failure after
 * the shared timeout rather than leaving the CLI hanging.
 */
export function registerThroughputGaugeCallbacks(
	server: WebServer,
	deps: Pick<WebServerFactoryDependencies, 'getMainWindow'>
): void {
	const { getMainWindow } = deps;

	server.setThroughputGaugeCommandCallback(async (request: ThroughputGaugeCommandRequest) => {
		const mainWindow = getMainWindow();
		if (!mainWindow || !isWebContentsAvailable(mainWindow)) {
			logger.warn('No main window is available for throughputGaugeCommand', 'WebServer');
			return { success: false, error: 'Maestro window is not available' };
		}
		return requestFromRenderer<ThroughputGaugeCommandResult>(
			mainWindow,
			'remote:throughputGaugeCommand',
			{
				// `set` waits for the settings write to land on disk before it
				// answers, so allow more than the 3s default for a slow disk.
				timeoutMs: 10_000,
				fallback: { success: false, error: 'Maestro did not answer the Throughput Gauge request' },
				parse: normalizeThroughputGaugeCommandResult,
				args: [request],
			}
		);
	});
}

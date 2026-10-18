import type { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import type { ParsedEvent } from '../../parsers/agent-output-parser';

/**
 * Hand a parsed output line to whoever subscribed to `parsed-event`, exactly as
 * the parser built it and before anything interprets it.
 *
 * Both places a line is parsed go through here: StdoutHandler for a line that
 * arrived whole, and ExitHandler for the last line of a stream that ended
 * without a newline. A subscriber therefore sees every line once, in order.
 *
 * Two rules keep this off the cost of a turn:
 * - Nothing is emitted while nobody is subscribed. A stream with no reader
 *   pays for one listener count and no call.
 * - A subscriber that throws is caught here. The emit sits in the middle of
 *   output handling, so a throw would otherwise stop the line it rode in on
 *   from ever reaching the screen.
 */
export function emitParsedEvent(
	emitter: EventEmitter,
	sessionId: string,
	event: ParsedEvent
): void {
	if (emitter.listenerCount('parsed-event') === 0) return;
	try {
		emitter.emit('parsed-event', sessionId, event);
	} catch (error) {
		logger.warn('[ProcessManager] A parsed-event listener threw', 'ProcessManager', {
			sessionId,
			error: String(error),
		});
	}
}

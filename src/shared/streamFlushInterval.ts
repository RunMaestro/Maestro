/**
 * How often a streaming reply is drawn: a local or SSH tab flushes its output batch at this cadence
 * (`useBatchedSessionUpdates`), and the desktop's peer mirror pushes a hosted tab's live turn at the
 * same one (`MIRROR_TURN_COALESCE_MS`), so a hosted reply renders as often as a local one (R34).
 *
 * 200ms is the sweet spot we landed on:
 * - 150ms collided with high-throughput streams (jitter from setInterval drift produced visible
 *   micro-stutters during peak agent output)
 * - 250ms is perceptibly laggy for users typing in the input area
 * - 200ms keeps streaming smooth without measurable input latency
 */
export const STREAM_FLUSH_INTERVAL_MS = 200;

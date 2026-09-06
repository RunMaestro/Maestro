/**
 * @file agent-liveness.ts
 * @description Which ProcessManager events prove a supervised agent is still working.
 *
 * Shared because getting this list wrong silently reintroduces a wall-clock
 * timeout, and it has already been got wrong twice in two different subsystems.
 *
 * For a `--print` stream-json run, `StdoutHandler` routes a turn's intermediate
 * activity to `thinking-chunk` / `tool-execution` / `usage`, and only emits
 * `data` when `isResultMessage(event)` is true - i.e. the terminal result, at the
 * very end (see `handleParsedEvent`, plus the exit-time flush in `ExitHandler`).
 * A healthy Claude run therefore emits ZERO `data` events until it is completely
 * finished.
 *
 * So a silence budget armed on `data` alone is not a silence budget at all: it is
 * a hard deadline, and an agent doing real work for longer than it is killed at
 * exactly the budget having never once re-armed the timer. That is the
 * "agent is working fine but gets killed anyway" failure, and both the
 * cross-agent consult router and the Group Chat router shipped it.
 *
 * Every event here is emitted as `(sessionId, payload)`, so one filter fits all.
 *
 * `raw-stdout` is deliberately NOT in this list. It is the rawest possible signal
 * and a fine liveness source, but it is emitted per chunk for every process in
 * the app, so a consumer opts into it explicitly rather than inheriting it here.
 */
export const AGENT_LIVENESS_EVENTS = ['data', 'thinking-chunk', 'tool-execution', 'usage'] as const;

export type AgentLivenessEvent = (typeof AGENT_LIVENESS_EVENTS)[number];

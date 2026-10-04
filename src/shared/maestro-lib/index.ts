/**
 * Maestro Library - Public Entry Point
 *
 * This module exports the stable public API of maestro-lib.
 * All library clients should import from here, not from deep module paths.
 *
 * Internal modules (bin/, test utilities) are not exported.
 */

// Paths and configuration
export * from './paths/userDataDir';
export * from './paths/resolve';
export * from './paths/syncPath';
export * from './paths/doctor';
export * from '../cli-server-discovery';

// Launch and argument building
export * from './launch/launch-plan';
export * from './launch/prompt-delivery';
export * from './launch/agent-args';
export * from './launch/env';
export * from './launch/interactive-mode';
export * from './launch/ssh-remote-resolver';
export * from './launch/path-prober';
export * from './launch/shell-escape';
export * from './launch/cwd';
export * from './launch/spawn-path';
export * from './launch/ssh-spawn-wrapper';
export * from './launch/ssh-command-builder';
export * from './launch/ssh-path';
export * from './launch/windows-command';
export * from './launch/claude-mode-selector';
export * from './launch/exec-file';
export * from './launch/getShellPath';
export * from './launch/image-refs';

// Output parsing
export * from './parsers/index';
export * from './parsers/agent-output-parser';
export * from './parsers/parser-factory';
export * from './parsers/usage-aggregator';
export * from './parsers/claude-output-parser';
export * from './parsers/codex-output-parser';
export * from './parsers/copilot-output-parser';
export * from './parsers/antigravity-output-parser';
export * from './parsers/grok-output-parser';
export * from './parsers/opencode-output-parser';
export * from './parsers/factory-droid-output-parser';
export * from './parsers/pi-output-parser';
export * from './parsers/omp-output-parser';
export * from './parsers/qwen-output-parser';
export * from './parsers/terminal-filter';
export * from './parsers/error-patterns';

// Provider definitions and capabilities
export * from './providers/definitions';
export * from './providers/capabilities';

// Streaming and turn contract
export * from './streaming/buffered-line-reader';
export * from './streaming/turn-outcome';
export * from './streaming/usage-accumulator';
export * from './streaming/usage-totals';

// Turn execution
export * from './run/start-turn';
export * from './run/turn-capture';
export * from './run/session';
export * from './run/run-to-completion';

// Process control
export * from './control/termination';
export * from './control/process-tree';
export * from './control/pty-kill';

// Host services
export * from './host';

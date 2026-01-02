/**
 * Slash Commands Module
 *
 * This module provides handlers for slash commands that are executed
 * by the AI agent or intercepted by Maestro.
 *
 * iOS commands (like /ios.snapshot, /ios.inspect, /ios.run_flow) are passed
 * to the AI agent which uses these handlers via IPC to execute the actual operations.
 */

// iOS Snapshot Command
export {
  executeSnapshotCommand,
  parseSnapshotArgs,
  snapshotCommandMetadata,
  type SnapshotCommandArgs,
  type SnapshotCommandResult,
} from './ios-snapshot';

// iOS Inspect Command
export {
  executeInspectCommand,
  parseInspectArgs,
  parseElementQuery,
  inspectCommandMetadata,
  type InspectCommandArgs,
  type InspectCommandResult,
} from './ios-inspect';

// iOS Run Flow Command
export {
  executeRunFlowCommand,
  parseRunFlowArgs,
  runFlowCommandMetadata,
  type RunFlowCommandArgs,
  type RunFlowCommandResult,
} from './ios-run-flow';

// iOS Tap Command
export {
  executeTapCommand,
  parseTapArgs,
  parseTarget,
  tapCommandMetadata,
  type TapCommandArgs,
  type TapCommandResult,
  type TapTarget,
  type TapTargetType,
} from './ios-tap';

// iOS Type Command
export {
  executeTypeCommand,
  parseTypeArgs,
  parseTypeTarget,
  typeCommandMetadata,
  type TypeCommandArgs,
  type TypeCommandResult,
  type TypeTarget,
  type TypeTargetType,
} from './ios-type';

// Command registry for all slash commands
export interface SlashCommandMetadata {
  command: string;
  description: string;
  usage: string;
  options: {
    name: string;
    description: string;
    valueHint: string | null;
  }[];
  examples: string[];
}

// Export command metadata for autocomplete
import { snapshotCommandMetadata } from './ios-snapshot';
import { inspectCommandMetadata } from './ios-inspect';
import { runFlowCommandMetadata } from './ios-run-flow';
import { tapCommandMetadata } from './ios-tap';
import { typeCommandMetadata } from './ios-type';

export const iosSlashCommandMetadata: SlashCommandMetadata[] = [
  snapshotCommandMetadata,
  inspectCommandMetadata,
  runFlowCommandMetadata,
  tapCommandMetadata,
  typeCommandMetadata,
];

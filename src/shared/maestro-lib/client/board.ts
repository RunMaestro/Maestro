import type { BridgeConnection } from './bridge-connection';
import type { BoardCommand, BoardCommandReply } from '../../board/commands';

/** Uses the existing discovery/authenticated connection; callers own its lifecycle. */
export function requestBoardCommand(
	connection: BridgeConnection,
	command: BoardCommand
): Promise<BoardCommandReply> {
	return connection.sendCommand<BoardCommandReply>(
		{ type: 'board_command', ...command },
		'board_command_result'
	);
}

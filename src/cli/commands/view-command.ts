import { readFileSync } from 'fs';
import { withMaestroClient } from '../services/maestro-client';
import type { CadenzaPayload } from '../../shared/cadenza-types';
import type { MovementPayload } from '../../shared/movement-types';

type ViewCommand =
	| {
			type: 'cadenza';
			payload: CadenzaPayload;
			responseType: 'cadenza_result';
	  }
	| {
			type: 'movement';
			payload: MovementPayload;
			responseType: 'movement_result';
	  };

interface ViewCommandResult {
	type: string;
	success: boolean;
	error?: string;
}

interface SendViewCommandOptions {
	command: ViewCommand;
	json: boolean | undefined;
	successMessage: string;
	failureMessage: string;
}

/** Resolve inline text or an UTF-8 body file for an external view command. */
export function resolveViewBody(
	body: string | undefined,
	bodyFile: string | undefined
): string | undefined {
	if (bodyFile) {
		try {
			return readFileSync(bodyFile, 'utf8');
		} catch (error) {
			console.error(
				`Error: could not read --body-file: ${error instanceof Error ? error.message : String(error)}`
			);
			process.exit(1);
		}
	}
	return body;
}

/**
 * Send a Cadenza or Movement mutation over the shared Maestro transport.
 * Domain payload construction and validation intentionally remain with each command.
 */
export async function sendViewCommand({
	command,
	json,
	successMessage,
	failureMessage,
}: SendViewCommandOptions): Promise<void> {
	const { payload } = command;
	try {
		const result = await withMaestroClient(async (client) =>
			client.sendCommand<ViewCommandResult>(
				{ type: command.type, ...payload },
				command.responseType
			)
		);

		if (result.success) {
			if (json) console.log(JSON.stringify({ success: true, id: payload.id, op: payload.op }));
			else console.log(successMessage);
			return;
		}

		const error = result.error || failureMessage;
		if (json) console.log(JSON.stringify({ success: false, error }));
		else console.error(`Error: ${error}`);
		process.exit(1);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (json) console.log(JSON.stringify({ success: false, error: message }));
		else console.error(`Error: ${message}`);
		process.exit(1);
	}
}

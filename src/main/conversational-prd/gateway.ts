/**
 * Conversational PRD Planner — gateway interface
 */

import type {
	ConversationalPrdMessage,
	PrdDraftDelta,
} from '../../shared/conversational-prd-types';

export type ConversationalPrdGatewayStatus =
	| 'gathering'
	| 'needs-clarification'
	| 'ready-to-finalize';

export interface ConversationalPrdGatewayResponse {
	messageToUser: string;
	prdDraftDelta: PrdDraftDelta;
	status: ConversationalPrdGatewayStatus;
}

export interface ConversationalPrdGatewayRequest {
	systemPrompt: string;
	history: ConversationalPrdMessage[];
	userMessage: string;
}

export interface ConversationalPrdGateway {
	respond(request: ConversationalPrdGatewayRequest): Promise<ConversationalPrdGatewayResponse>;
}

import { useState } from 'react';
import type { Session, Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui/Modal';
import { FeedbackChatView } from './FeedbackChatView';

interface FeedbackModalProps {
	theme: Theme;
	sessions: Session[];
	onClose: () => void;
	onSwitchToSession: (sessionId: string) => void;
}

export function FeedbackModal({ theme, sessions, onClose, onSwitchToSession }: FeedbackModalProps) {
	const [width, setWidth] = useState(462);

	return (
		<Modal
			theme={theme}
			title="Send Feedback"
			priority={MODAL_PRIORITIES.FEEDBACK}
			onClose={onClose}
			width={width}
			maxHeight="85vh"
			allowOverflow
			contentClassName="flex-1 flex flex-col min-h-0 p-0"
		>
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={onClose}
				onWidthChange={setWidth}
				onSubmitSuccess={(sessionId) => {
					onSwitchToSession(sessionId);
					onClose();
				}}
			/>
		</Modal>
	);
}

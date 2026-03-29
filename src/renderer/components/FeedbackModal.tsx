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
	return (
		<Modal
			theme={theme}
			title="Send Feedback"
			priority={MODAL_PRIORITIES.FEEDBACK}
			onClose={onClose}
			width={780}
			maxHeight="85vh"
		>
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={onClose}
				onSubmitSuccess={(sessionId) => {
					onSwitchToSession(sessionId);
					onClose();
				}}
			/>
		</Modal>
	);
}

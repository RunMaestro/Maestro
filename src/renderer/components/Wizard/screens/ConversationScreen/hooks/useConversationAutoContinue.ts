import {
	useEffect,
	useRef,
	useState,
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
} from 'react';
import { AUTO_CONTINUE_MESSAGE } from '../utils/deferredResponse';

export function useConversationAutoContinue({
	inputValue,
	isConversationLoading,
	isSendingRef,
	setInputValue,
	handleSendMessageRef,
}: {
	inputValue: string;
	isConversationLoading: boolean;
	isSendingRef: MutableRefObject<boolean>;
	setInputValue: Dispatch<SetStateAction<string>>;
	handleSendMessageRef: MutableRefObject<(() => void) | null>;
}): (message: string) => void {
	const [pendingAutoContinue, setPendingAutoContinue] = useState<string | null>(null);
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (pendingAutoContinue && !isConversationLoading && !isSendingRef.current) {
			const message = pendingAutoContinue;
			setPendingAutoContinue(null);

			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}

			timeoutRef.current = setTimeout(() => {
				setInputValue(message);
				timeoutRef.current = null;
			}, 800);
		}
	}, [pendingAutoContinue, isConversationLoading, isSendingRef, setInputValue]);

	useEffect(() => {
		return () => {
			if (timeoutRef.current) {
				clearTimeout(timeoutRef.current);
			}
		};
	}, []);

	useEffect(() => {
		if (
			inputValue === AUTO_CONTINUE_MESSAGE &&
			!isConversationLoading &&
			!isSendingRef.current &&
			handleSendMessageRef.current
		) {
			const sendTimer = setTimeout(() => {
				handleSendMessageRef.current?.();
			}, 0);
			return () => clearTimeout(sendTimer);
		}
	}, [inputValue, isConversationLoading, isSendingRef, handleSendMessageRef]);

	return setPendingAutoContinue;
}

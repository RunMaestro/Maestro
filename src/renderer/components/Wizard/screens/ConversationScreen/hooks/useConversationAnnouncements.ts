import { useCallback, useEffect, useRef, useState } from 'react';

export function useConversationAnnouncements({
	isReadyToProceed,
	confidenceLevel,
}: {
	isReadyToProceed: boolean;
	confidenceLevel: number;
}): {
	announcement: string;
	announcementKey: number;
	announce: (message: string) => void;
} {
	const [announcement, setAnnouncement] = useState('');
	const [announcementKey, setAnnouncementKey] = useState(0);
	const prevReadyRef = useRef(isReadyToProceed);

	const announce = useCallback((message: string) => {
		setAnnouncement(message);
		setAnnouncementKey((prev) => prev + 1);
	}, []);

	useEffect(() => {
		if (isReadyToProceed && !prevReadyRef.current) {
			announce(
				`Confidence level ${confidenceLevel}%. Ready to proceed! You can now create your Playbook.`
			);
		}
		prevReadyRef.current = isReadyToProceed;
	}, [announce, isReadyToProceed, confidenceLevel]);

	return { announcement, announcementKey, announce };
}

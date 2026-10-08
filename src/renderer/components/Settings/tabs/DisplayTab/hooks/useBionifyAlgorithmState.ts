import { useEffect, useState } from 'react';
import { DEFAULT_BIONIFY_ALGORITHM } from '../../../../../utils/bionifyReadingMode';
import type { BionifyAlgorithmState } from '../types';
import { isValidBionifyAlgorithm, normalizeBionifyAlgorithm } from '../utils';

interface UseBionifyAlgorithmStateOptions {
	bionifyAlgorithm: string | undefined;
	setBionifyAlgorithm: (value: string) => void;
}

export function useBionifyAlgorithmState({
	bionifyAlgorithm,
	setBionifyAlgorithm,
}: UseBionifyAlgorithmStateOptions): BionifyAlgorithmState {
	const [algorithmDraft, setAlgorithmDraft] = useState(
		bionifyAlgorithm ?? DEFAULT_BIONIFY_ALGORITHM
	);
	const [showInfoModal, setShowInfoModal] = useState(false);
	const isAlgorithmValid = isValidBionifyAlgorithm(algorithmDraft);

	useEffect(() => {
		setAlgorithmDraft(bionifyAlgorithm ?? DEFAULT_BIONIFY_ALGORITHM);
	}, [bionifyAlgorithm]);

	const commitAlgorithmDraft = () => {
		const normalizedDraft = normalizeBionifyAlgorithm(algorithmDraft);
		if (isAlgorithmValid && normalizedDraft !== (bionifyAlgorithm ?? DEFAULT_BIONIFY_ALGORITHM)) {
			setBionifyAlgorithm(normalizedDraft);
		}
	};

	return {
		algorithmDraft,
		setAlgorithmDraft,
		isAlgorithmValid,
		commitAlgorithmDraft,
		showInfoModal,
		openInfoModal: () => setShowInfoModal(true),
		closeInfoModal: () => setShowInfoModal(false),
	};
}

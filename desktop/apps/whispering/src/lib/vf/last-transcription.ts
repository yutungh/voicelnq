/**
 * VoiceFlow 0.9.23: "Paste last transcription" pastes the newest dictation's
 * text: what was delivered (tidied by its style, with saved spellings), or
 * the words as heard when nothing was delivered. Deleted dictations and
 * ones with no text are skipped. Pure, so it is unit tested.
 */
import type { Recording } from '$lib/services/isomorphic/db/models/recordings';

type Candidate = Pick<Recording, 'createdAt' | 'deletedAt' | 'finalText' | 'transcribedText'>;

export function lastTranscriptText(recordings: readonly Candidate[]): string | null {
	let best: { at: string; text: string } | null = null;
	for (const r of recordings) {
		if (r.deletedAt) continue;
		const text = r.finalText?.trim() ? r.finalText : r.transcribedText;
		if (!text?.trim()) continue;
		if (!best || r.createdAt > best.at) best = { at: r.createdAt, text };
	}
	return best?.text ?? null;
}

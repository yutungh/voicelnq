import { Ok } from 'wellcrafted/result';
import { defineMutation } from '$lib/query/client';
import { settings } from '$lib/stores/settings.svelte';
import {
	COPIED_INSTEAD,
	deliveryNotice,
	deliveryResult,
	restoreFor,
	copiedWhy,
	type DeliveryResult,
	type NativePasteResult,
} from '$lib/privacy/policy';
import { authorizePaste, type PasteContext } from '$lib/privacy/paste';
import { dictationTiming } from '$lib/timing';
import { rpc } from '..';
import { applySavedSpellings, updateRecordingFields } from './outcome';
// VoiceFlow A2: the recording bar shows each delivery's outcome.
import { bar } from '$lib/bar/controller';
// VoiceFlow phase F: stage evidence (what was delivered, and how).
import { noteEvidence } from '$lib/feedback/evidence-store';
import { problemNoticeIds } from '$lib/components/notification-log';
import { driftReasonText } from '$lib/vf/drift-check';
import { lastTranscriptText } from '$lib/vf/last-transcription';
import { services } from '$lib/services';

/**
 * VoiceFlow C1 (design B3.1 "Notices"), 0.9.11: delivery tells the person
 * only what happened. A paste is confirmed quietly ("Pasted into Telegram");
 * when there was nowhere to paste, the text is copied (0.9.23: "Couldn't
 * paste — transcription copied to clipboard.", which hides itself); "Not
 * pasted" is left for a real failure where the text is not on the clipboard
 * either. The result is kept on the
 * dictation so Home and History show it too.
 */

/** The dictation a delivery belongs to, so its outcome is kept with it. */
export type DeliveryRecording = {
	id: string;
	/** For spellings scoped to an app: exe name or bundle id. */
	appId: string | null;
	/** The style that tidied the text, if any. */
	styleName?: string;
	/**
	 * 0.9.13: the language guard kept the user's own words (the text delivered) and
	 * held the tidy-up back for "Use cleaned": why, and the style.
	 */
	keptWords?: KeptWords;
};

export type KeptWords = { reason: string; styleName: string };

/**
 * VoiceFlow: how a delivery ended, for its sound. `failed` is exactly when the
 * bar shows a paste failure (error cue); anything else is `done` (done cue).
 */
export type DeliveryOutcome = 'done' | 'failed';

function messageOf(error: object): string {
	if ('description' in error && typeof error.description === 'string') return error.description;
	if ('message' in error && typeof error.message === 'string') return error.message;
	return 'Unknown error';
}

/**
 * Pastes or copies the text (0.9.11), as `decidePaste` says for the window
 * in front now, and reports what actually happened. Not pasted: the text is
 * on the clipboard. Pasted: since 0.9.23 the previous clipboard is put back
 * (Keep my clipboard after pasting), else the text stays there.
 */
export async function placeText(
	text: string,
	paste: PasteContext | undefined,
	traceId?: string,
	/** 0.9.23: Paste last transcription borrows the clipboard even when unsure. */
	{ alwaysRestore = false }: { alwaysRestore?: boolean } = {},
): Promise<DeliveryResult> {
	const decision = await authorizePaste(paste);
	if (traceId) dictationTiming.markRecording(traceId, 'paste-checked');
	const { data, error } = await rpc.text.writeToCursor.execute({
		text,
		binding: decision.paste ? decision.binding : undefined,
		shortcut: decision.paste ? decision.shortcut : undefined,
		// 0.9.23: a confident paste puts the person's own clipboard back; an
		// unsure one leaves the text there (`restoreFor`).
		restore: restoreFor(decision, settings.value['paste.keepClipboard'], alwaysRestore),
	});
	let native: NativePasteResult | null = error ? null : data;
	const failure = error ? messageOf(error) : (data?.error ?? null);
	if (!native?.pasted && !native?.copied) {
		// Nothing pasted and the text isn't on the clipboard: one more try
		// another way, so it is (0.9.11 hard rule).
		const { error: copyError } = await rpc.text.copyToClipboard.execute({ text });
		if (!copyError) native = { pasted: false, copied: true, reason: native?.reason, error: failure };
	}
	const delivered = deliveryResult(decision, native, failure);
	if (traceId && delivered.result !== 'not-pasted')
		dictationTiming.markRecording(
			traceId,
			delivered.result === 'pasted' ? 'paste-done' : 'copy-done',
		);
	// The reason only, never the text.
	console.info(
		`[paste] ${delivered.result} (${delivered.decision.reason})${failure ? `: ${failure}` : ''}`,
	);
	return delivered;
}

/**
 * 0.9.12 (F3d): a dictation delivered (pasted or copied) is fixed, so its
 * earlier problem notices go, from the window and from the Notifications
 * list. `toastId` is the notice about to say so: its own entry leaves the
 * list, its toast is left for that notice to reuse.
 */
function clearFixedProblem(recordingId: string, toastId: string) {
	for (const id of problemNoticeIds(recordingId)) {
		if (id !== toastId) rpc.notify.dismiss(id);
		rpc.notify.unlog(id);
	}
}

/** 0.9.13: "Use cleaned" from a window notice (set by the engine). */
let useCleanedHandler: ((recordingId: string) => unknown) | null = null;
export function onUseCleaned(handler: (recordingId: string) => unknown) {
	useCleanedHandler = handler;
}

/** One line on why the user's own words were kept. */
export function keptWordsDetail(kept: KeptWords): string {
	return `${driftReasonText(kept.reason)}, so your own words went in instead of ${kept.styleName}'s tidy-up.`;
}

/**
 * Tells the person, the bar, History and the feedback evidence what a
 * delivery did. Returns the outcome for the dictation's last sound.
 */
export async function reportDelivered({
	delivered,
	text,
	toastId,
	recordingId,
	styleName,
	quietToast = false,
	keptWords,
}: {
	delivered: DeliveryResult;
	text: string;
	toastId: string;
	recordingId?: string;
	/** The style that tidied the text; null for raw text. */
	styleName?: string | null;
	/** No window notice (first-run setup dictates into VoiceFlow on purpose). */
	quietToast?: boolean;
	/** 0.9.13: the user's own words were kept; the bar offers Use cleaned. */
	keptWords?: KeptWords;
}): Promise<DeliveryOutcome> {
	const notice = deliveryNotice(delivered);
	const { decision } = delivered;
	const pastedInto = delivered.result === 'pasted' ? decision.appName : null;
	if (recordingId) {
		void noteEvidence(recordingId, {
			outcome: delivered.result,
			pastedInto: pastedInto ?? undefined,
		});
		if (delivered.result === 'not-pasted') {
			bar.failed(recordingId, 'paste', notice.title, notice.description);
			await updateRecordingFields(recordingId, {
				result: 'not-pasted',
				problemKind: 'paste',
				problem: `${notice.title}: ${delivered.error}`,
				problemDismissed: false,
			});
		} else {
			bar.delivered(recordingId, delivered.result, {
				app: pastedInto,
				text,
				styleName,
				copied:
					delivered.result === 'copied'
						? { keys: decision.keys, why: copiedWhy(decision) }
						: undefined,
				keptWords,
			});
			await updateRecordingFields(recordingId, {
				result: delivered.result,
				problem: undefined,
				problemKind: undefined,
				problemDismissed: undefined,
			});
			clearFixedProblem(recordingId, toastId);
		}
	}
	if (quietToast) return delivered.result === 'not-pasted' ? 'failed' : 'done';
	// 0.9.13: without the bar, the window's notice offers Use cleaned. It
	// hides by itself (History keeps it); never a question that blocks.
	if (keptWords && recordingId && delivered.result !== 'not-pasted' && !settings.value['bar.show']) {
		rpc.notify.info.execute({
			id: toastId,
			title: 'Kept your words',
			// 0.9.23: a copy instead of a paste says so here too.
			description: `${delivered.result === 'copied' ? `${COPIED_INSTEAD} ` : ''}${keptWordsDetail(keptWords)} Use cleaned copies the tidied text; History keeps it too.`,
			action: {
				type: 'button',
				label: 'Use cleaned',
				onClick: () => void useCleanedHandler?.(recordingId),
			},
		});
		return 'done';
	}
	switch (delivered.result) {
		case 'pasted':
			// 0.9.11: the bar says it; the window only without the bar.
			if (!settings.value['bar.show']) rpc.notify.success.execute({ id: toastId, ...notice });
			else rpc.notify.dismiss(toastId);
			return 'done';
		case 'copied':
			// Short and self-hiding: the text is safe on the clipboard.
			if (!settings.value['bar.show']) rpc.notify.info.execute({ id: toastId, ...notice });
			return 'done';
		case 'not-pasted':
			rpc.notify.warning.execute({
				// 0.9.11: one id per dictation, so dismissing it anywhere closes it.
				id: recordingId ? `paste-${recordingId}` : toastId,
				...notice,
				// Hides by itself; Home and History keep the problem (F3c).
				persist: false,
				action: {
					type: 'button',
					label: 'Copy text',
					onClick: async () => {
						const { error } = await rpc.text.copyToClipboard.execute({ text });
						if (!error)
							rpc.notify.success.execute({ id: toastId, title: 'Copied', description: '' });
					},
				},
			});
			return 'failed';
	}
}

type DeliverArgs = {
	text: string;
	toastId: string;
	/** VoiceFlow: the dictation's target, for paste-time authorization. */
	paste?: PasteContext;
	/** VoiceFlow C1: set for a dictation, so spellings apply and it is kept. */
	recording?: DeliveryRecording;
	/** VoiceFlow: the recording whose timings this delivery belongs to. */
	traceId?: string;
};

/**
 * Pastes or copies the final text, as the person's settings say. Saved
 * spellings are applied to a dictation's final text here, once.
 */
async function deliver(
	kind: 'transcription' | 'transformation',
	{ text: input, toastId, paste, recording, traceId }: DeliverArgs,
): Promise<DeliveryOutcome> {
	let text = input;
	if (recording) {
		const spelled = await applySavedSpellings(input, recording.appId, recording.id);
		text = spelled.text;
		void noteEvidence(recording.id, { deliveredText: text, corrections: spelled.changes });
		if (traceId) dictationTiming.markRecording(traceId, 'corrections-done');
	}

	if (settings.value[`${kind}.writeToCursorOnSuccess`]) {
		// 0.9.11: paste where the cursor is, or copy when there is nowhere to
		// paste. 0.9.23: after a paste the previous clipboard comes back.
		const delivered = await placeText(text, paste, traceId);
		if (delivered.result === 'pasted' && settings.value[`${kind}.simulateEnterAfterOutput`]) {
			const { error: enterError } = await rpc.text.simulateEnterKeystroke.execute();
			if (enterError) {
				rpc.notify.warning.execute({
					title: "Couldn't press Enter after pasting",
					description: enterError.message,
					action: { type: 'more-details', error: enterError },
				});
			}
		}
		if (recording) {
			await updateRecordingFields(recording.id, {
				finalText: text,
				styleName: recording.styleName,
			});
		}
		return await reportDelivered({
			delivered,
			text,
			toastId,
			recordingId: recording?.id,
			styleName: recording ? (recording.styleName ?? null) : undefined,
			// First-run setup dictates into VoiceFlow on purpose and shows the text.
			quietToast:
				delivered.decision.reason === 'self' &&
				window.location.pathname.startsWith('/welcome'),
			keptWords: recording?.keptWords,
		});
	}

	// Pasting is turned off: copy (0.9.11 hard rule: a dictation that is not
	// pasted is always on the clipboard).
	let copied = false;
	{
		// Through write_text (no window: copy only), one delivery at a time.
		const { data } = await rpc.text.writeToCursor.execute({ text });
		copied = data?.copied === true || !(await rpc.text.copyToClipboard.execute({ text })).error;
	}
	if (!copied) {
		// The clipboard can't be used: say so, and keep it on Home.
		return await reportDelivered({
			delivered: {
				result: 'not-pasted',
				decision: { paste: false, reason: 'keys-failed', appName: null, keys: 'Ctrl+V' },
				error: "Couldn't use the clipboard.",
			},
			text,
			toastId,
			recordingId: recording?.id,
		});
	}
	if (recording) {
		void noteEvidence(recording.id, {
			outcome: copied ? 'copied' : 'kept',
			pastedInto: undefined,
		});
		await updateRecordingFields(recording.id, {
			finalText: text,
			styleName: recording.styleName,
			result: copied ? 'copied' : undefined,
			problem: undefined,
			problemKind: undefined,
			problemDismissed: undefined,
		});
		if (copied) {
			clearFixedProblem(recording.id, toastId);
			bar.delivered(recording.id, 'copied', {
				app: null,
				text,
				styleName: recording.styleName ?? null,
				keptWords: recording.keptWords,
			});
		} else {
			bar.hide(recording.id);
		}
	}
	if (copied && recording?.keptWords) {
		// 0.9.13: the user's own words were copied; the notice says why, with Use cleaned.
		const recordingId = recording.id;
		rpc.notify.info.execute({
			id: toastId,
			title: 'Kept your words (copied)',
			description: `${keptWordsDetail(recording.keptWords)} Use cleaned copies the tidied text; History keeps it too.`,
			action: {
				type: 'button',
				label: 'Use cleaned',
				onClick: () => void useCleanedHandler?.(recordingId),
			},
		});
	} else if (copied) {
		rpc.notify.success.execute({
			id: toastId,
			title: 'Copied to the clipboard',
			description: '',
		});
	} else {
		rpc.notify.info.execute({
			id: toastId,
			title: 'Your words are ready in History',
			description: '',
			action: {
				type: 'button',
				label: 'Copy text',
				onClick: async () => {
					await rpc.text.copyToClipboard.execute({ text });
				},
			},
		});
	}
	return 'done';
}

/** 0.9.23: one Paste last transcription at a time (a held key repeats). */
let pastingLast = false;

/**
 * VoiceFlow 0.9.23: "Paste last transcription" (a global shortcut). Pastes
 * the newest dictation's text where the cursor is, borrowing the clipboard
 * and putting it back, as a confident paste does. Nowhere to paste: it is
 * copied, with the notice. The dictation itself isn't changed.
 */
export async function pasteLastTranscription(): Promise<void> {
	if (pastingLast) return;
	pastingLast = true;
	try {
		const { data: recordings } = await services.db.recordings.getAll();
		const text = lastTranscriptText(recordings ?? []);
		if (!text) {
			rpc.notify.info.execute({
				title: 'Nothing to paste yet',
				description: 'Your next dictation can be pasted again with this key.',
			});
			return;
		}
		const delivered = await placeText(text, { target: null, restoreFocus: false }, undefined, {
			alwaysRestore: true,
		});
		const notice = deliveryNotice(delivered);
		// Shown whether or not the bar is on: this paste has no bar of its own.
		if (delivered.result === 'copied') rpc.notify.info.execute(notice);
		else if (delivered.result === 'not-pasted') rpc.notify.warning.execute(notice);
	} finally {
		pastingLast = false;
	}
}

export const delivery = {
	/** Delivers a transcript that no style tidied. */
	deliverTranscriptionResult: defineMutation({
		mutationKey: ['delivery', 'deliverTranscriptionResult'],
		mutationFn: async (args: DeliverArgs) => {
			return Ok(await deliver('transcription', args));
		},
	}),

	/** Delivers text a style tidied (a dictation, or the clipboard). */
	deliverTransformationResult: defineMutation({
		mutationKey: ['delivery', 'deliverTransformationResult'],
		mutationFn: async (args: DeliverArgs) => {
			return Ok(await deliver('transformation', args));
		},
	}),
};

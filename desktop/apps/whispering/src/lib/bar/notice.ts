/**
 * VoiceFlow A2 (0.9.5): what a result notice says on the pill. One short
 * line, at most two compact text buttons and a close button; the full
 * explanation is the line's tooltip and stays in History. Pure, so it is
 * unit tested.
 */
import type { BarAction, DictationState } from './contract';
import { COPIED_INSTEAD } from '../privacy/policy';

export type NoticeTone = 'ok' | 'quiet' | 'warn' | 'bad';
export type NoticeIcon = 'check-circle' | 'copy' | 'warning' | 'warning-circle' | 'x-circle';
export type NoticeButton = {
	action: Exclude<BarAction, 'dismiss' | 'set-style' | 'set-expression'>;
	label: string;
};

export type Notice = {
	tone: NoticeTone;
	icon: NoticeIcon;
	/** The short line. */
	title: string;
	/** Quieter words after the line (an app name), when there is room. */
	aside: string | null;
	/** The whole story, for the tooltip. */
	detail: string;
	/** At most two, in order. */
	buttons: NoticeButton[];
	/** Shows the × button. */
	closable: boolean;
};

type NoticeView = Pick<
	DictationState,
	'phase' | 'pastedInto' | 'error' | 'actions' | 'app' | 'style' | 'copied'
> &
	Partial<Pick<DictationState, 'keptWords'>>;

/** 0.9.13: plain words for the language guard's reason codes. */
function keptReason(reason: string): string {
	switch (reason) {
		case 'translated':
			return 'tidy-up translated what you said';
		case 'han-added':
			return 'tidy-up put part of it into Chinese';
		case 'latin-added':
			return 'tidy-up put part of it into English';
		case 'swapped':
			return 'tidy-up swapped a word into the other language';
		default:
			return 'tidy-up changed the language of part of it';
	}
}

const MAX_BUTTONS = 2;

function pick(view: NoticeView, wanted: NoticeButton[]): NoticeButton[] {
	return wanted.filter((b) => view.actions.includes(b.action)).slice(0, MAX_BUTTONS);
}

function full(title: string, detail: string | null | undefined): string {
	return detail ? `${title}. ${detail}`.replace(/\.\. /g, '. ') : title;
}

/** The notice for a result phase; null while listening or working. */
export function noticeFor(view: NoticeView): Notice | null {
	const closable = view.actions.includes('dismiss');
	// 0.9.13: the language guard kept the user's own words (pasted or copied as
	// usual) and holds the tidy-up back. A quiet notice, never a question.
	if ((view.phase === 'pasted' || view.phase === 'copied') && view.keptWords) {
		const where =
			view.phase === 'pasted'
				? view.pastedInto
					? `Pasted into ${view.pastedInto}.`
					: 'Pasted.'
				: view.copied
					? `${COPIED_INSTEAD} Press ${view.copied.keys} to paste.`
					: 'Copied: press Ctrl+V to paste.';
		return {
			tone: 'warn',
			icon: 'warning',
			title: 'Kept your words',
			aside: 'mixed languages: tidy-up held back',
			detail: `Kept your words: ${keptReason(view.keptWords.reason)}, so ${view.keptWords.styleName}'s tidy-up was held back. ${where} Use cleaned copies the tidied text; History keeps it too.`,
			buttons: pick(view, [
				{ action: 'use-cleaned', label: 'Use cleaned' },
				{ action: 'feedback', label: 'Feedback' },
			]),
			closable,
		};
	}
	switch (view.phase) {
		case 'listening':
		case 'transcribing':
		case 'tidying':
			return null;
		case 'pasted':
			return {
				tone: 'ok',
				icon: 'check-circle',
				title: 'Pasted',
				aside: view.pastedInto,
				detail: view.pastedInto
					? `Pasted into ${view.pastedInto} (${view.style.name})`
					: `Pasted (${view.style.name})`,
				buttons: pick(view, [{ action: 'feedback', label: 'Feedback' }]),
				// It fades by itself.
				closable: false,
			};
		case 'copied': {
			const keys = view.copied?.keys ?? null;
			if (keys) {
				// 0.9.23: a paste was meant to happen and the text was copied
				// instead: "Couldn't paste · transcription copied to clipboard",
				// with why in the tooltip.
				return {
					tone: 'warn',
					icon: 'copy',
					title: "Couldn't paste",
					aside: 'transcription copied to clipboard',
					detail: [COPIED_INSTEAD, view.copied?.why, `Press ${keys} to paste. It is also in History.`]
						.filter(Boolean)
						.join(' '),
					buttons: pick(view, [{ action: 'feedback', label: 'Feedback' }]),
					closable,
				};
			}
			// Pasting is turned off: copied on purpose.
			return {
				tone: 'ok',
				icon: 'copy',
				title: 'Copied',
				aside: 'ready to paste',
				detail: 'Your words are on the clipboard. Paste them where you want them.',
				buttons: pick(view, [{ action: 'feedback', label: 'Feedback' }]),
				closable,
			};
		}
		case 'cancelled':
			return {
				tone: 'quiet',
				icon: 'x-circle',
				title: 'Cancelled',
				aside: null,
				detail: 'Cancelled. Nothing was sent.',
				buttons: [],
				closable: false,
			};
		case 'failed': {
			const error = view.error;
			const detail = full(error?.title ?? 'Something went wrong', error?.detail);
			switch (error?.kind) {
				case 'tidy-up':
					return {
						tone: 'bad',
						icon: 'warning-circle',
						// 0.9.11: the words as heard are on the clipboard.
						title: error.title.startsWith('Copied') ? 'Copied' : 'Not pasted',
						aside: error.title.startsWith('Copied') ? 'press Ctrl+V' : null,
						detail,
						buttons: pick(view, [
							{ action: 'retry', label: 'Retry' },
							{ action: 'paste-raw', label: 'Paste raw' },
						]),
						closable,
					};
				case 'transcription':
					return {
						tone: 'bad',
						icon: 'warning-circle',
						title: "Couldn't transcribe",
						aside: null,
						detail,
						buttons: pick(view, [{ action: 'retry', label: 'Retry' }]),
						closable,
					};
				case 'paste':
					return {
						tone: 'bad',
						icon: 'warning-circle',
						title: 'Not pasted',
						aside: view.app.name,
						detail,
						buttons: pick(view, [{ action: 'feedback', label: 'Feedback' }]),
						closable,
					};
				case 'empty':
					return {
						tone: 'quiet',
						icon: 'x-circle',
						title: 'Nothing heard',
						aside: null,
						detail,
						// 0.9.12: Retry, for a recording long enough to have been misheard.
						buttons: pick(view, [{ action: 'retry', label: 'Retry' }]),
						closable,
					};
				case 'refused':
					return {
						tone: 'warn',
						icon: 'warning',
						title: error.title,
						aside: null,
						detail,
						buttons: [],
						closable,
					};
				default:
					return {
						tone: 'bad',
						icon: 'warning-circle',
						title: error?.title ?? 'Something went wrong',
						aside: null,
						detail,
						buttons: pick(view, [{ action: 'retry', label: 'Retry' }]),
						closable,
					};
			}
		}
	}
}

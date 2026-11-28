import { nanoid } from 'nanoid/non-secure';
import { IS_MACOS } from '$lib/constants/platform';
import { Ok } from 'wellcrafted/result';
import { defineMutation } from '$lib/query/client';
import { WhisperingErr } from '$lib/result';
import { DbServiceErr } from '$lib/services/isomorphic/db';
import { services } from '$lib/services';
import { settings } from '$lib/stores/settings.svelte';
import { vadRecorder } from '$lib/stores/vad-recorder.svelte';
import { passwordCheckCounters } from '$lib/privacy/counters.svelte';
import {
	appIdOf,
	recordingTargetFields,
	targetFromRecording,
} from '$lib/privacy/history';
import { dictation } from '$lib/stores/dictation.svelte';
import type { PasteContext } from '$lib/privacy/paste';
import {
	decideAtRecordStart,
	deliveryNotice,
	recordNotice,
	recordingPrivacyFor,
	type RecordDecision,
	type TargetSnapshot,
} from '$lib/privacy/policy';
import { captureTarget, unresolvedTarget } from '$lib/privacy/target';
import { countWords, dictationTiming } from '$lib/timing';
import {
	usesOpenAIOrigin,
	warmOpenAIConnection,
} from '$lib/services/isomorphic/openai-pool';
import type { Recording } from '$lib/services/isomorphic/db';
import * as transformClipboardWindow from '$routes/transform-clipboard/transformClipboardWindow.tauri';
import { rpc } from '..';
import { db } from './db';
import {
	type DeliveryOutcome,
	delivery,
	onUseCleaned,
	pasteLastTranscription,
	placeText,
	reportDelivered,
} from './delivery';
import { applySavedSpellings, updateRecordingFields } from './outcome';
// VoiceFlow phase F: stage evidence for feedback, kept with each dictation.
import { noteEvidence } from '$lib/feedback/evidence-store';
import { tidyConfigOf, type TidyConfig } from '$lib/feedback/evidence';
import { tidyModelOf, transcriptionModelOf } from '$lib/feedback/models';
import { removeAudioIfOff } from '$lib/vf/audio-cleanup';
import { EMPTY_RETRY_KEEP_MS } from '$lib/vf/audio-retention';
import { emptyInputLeftovers, worthRetrying } from '$lib/vf/dictations';
import { profilePins, type ProfilePin } from '$lib/profile/service.svelte';
import { profileStyleOf, resolveProfileStyle } from '$lib/profile/styles';
import { buildPrompt } from '$lib/profile/prompt';
import { tidyWordsBlock, withTidyWords } from '$lib/profile/tidy-words';
import { tidyUpTimeoutMs } from '$lib/profile/timeout';
// VoiceFlow A2: the floating recording bar.
import { bar } from '$lib/bar/controller';
import { RAW_STYLE_ID } from '$lib/bar/contract';
import {
	DEFAULT_EXPRESSION,
	isFunKind,
	presetKindOf,
	presetKindOfProfileStyle,
	withExpression,
} from '$lib/bar/expression';
import {
	driftReasonText,
	guardedTidyUp,
	strictTransformation,
	withFindReplace,
	type TidyAttempt,
} from '$lib/vf/drift-check';
import { removeFeedbackAudio } from '$lib/bar/feedback-audio';
import { captureFeedback, finishStopped } from '$lib/bar/feedback-flow';
import { createExclusive } from '$lib/bar/exclusive';
import type { DictationPurpose } from '$lib/bar/contract';
import type { FrozenOverrides } from '$lib/bar/machine';
import type { DeviceAcquisitionOutcome } from '$lib/services/types';
import { FsServiceLive } from '$lib/services/desktop/fs';
import { remove as removeFile } from '@tauri-apps/plugin-fs';
import { nativeHotkeys } from '$lib/hotkeys/native-hotkeys.svelte';
import { initNativeSound } from '$lib/sound/native-sound.svelte';
import {
	type EventContext,
	NATIVE_ACTIONS,
	type NativeEvent,
} from '$lib/hotkeys/native';
import { notify } from './notify';
import { liveRecordingId, recorder, setNativeRecording } from './recorder';
import { sound } from './sound';
import { text } from './text';
import { transcribeAudioOnly, transcription } from './transcription';
import { transformer } from './transformer';

/**
 * Application actions. These are mutations at the UI boundary that can be invoked
 * from anywhere: command registry, components, stores, etc.
 *
 * They always return Ok() because there's nowhere left to propagate errors—errors flow
 * sideways through notify.error.execute() instead of up the call stack. Actions are
 * the end of the operation chain.
 */

// Track manual recording start time for duration calculation
let manualRecordingStartTime: number | null = null;

/**
 * Mutex flag to prevent concurrent recording operations.
 *
 * This flag guards against a race condition where rapid toggle calls (e.g., push-to-talk)
 * can both see 'IDLE' state before the recorder has fully started. Without this guard:
 * 1. Call 1 checks recorder state → IDLE (during setup, is_recording not yet true)
 * 2. Call 2 checks recorder state → IDLE (Call 1's recording hasn't fully started)
 * 3. Both calls try to start recording, causing state desync
 *
 * The flag is set synchronously at the start of any recording operation and cleared
 * when the core operation completes (after the recorder service call returns).
 */
let isRecordingOperationBusy = false;

// ============================================================================
// VoiceFlow: app identity at record start (spec §2.1, §4.1, §4.3)
// ============================================================================

/** A target snapshot and the privacy decision made on it at the hotkey. */
type TargetAuthorization = {
	target: TargetSnapshot;
	decision: RecordDecision;
	/** VoiceFlow B + C2: the word lists this dictation uses, pinned at start. */
	profile?: ProfilePin;
	/**
	 * VoiceFlow 0.9.11: the window in front when the recording stopped. The
	 * text is pasted only if that window is still in front when it is ready.
	 */
	atStop?: TargetSnapshot | null;
};

/**
 * The snapshot of the manual recording in progress. Set at start, taken
 * (and cleared) at stop, so each recording keeps its own snapshot even when
 * the next one starts while the previous one is still being transcribed.
 */
let manualRecordingTarget: TargetAuthorization | null = null;

/**
 * True after a start was refused (Tier B), so the push-to-talk release that
 * follows does not try to stop a recording that never started.
 */
let manualStartRefused = false;

/**
 * Captures the app in front and decides on it. Called first thing at the
 * hotkey, before VoiceFlow shows anything.
 */
async function captureAndAuthorize(): Promise<TargetAuthorization> {
	return authorizeTarget(await captureTarget());
}

/**
 * The decision on a snapshot already taken (VoiceFlow: the native hotkeys
 * capture it in Rust at the key).
 */
function authorizeTarget(target: TargetSnapshot): TargetAuthorization {
	passwordCheckCounters.record(target.passwordCheck);
	const decision = decideAtRecordStart(target);
	if (decision.action === 'refuse') return { target, decision };
	return { target, decision, profile: profilePins.pin() };
}

/** A refused recording: a persistent notice, nothing recorded or sent. */
function reportRefused(decision: RecordDecision) {
	const notice = recordNotice(decision);
	if (!notice) return;
	notify.warning.execute({
		id: `refused-${nanoid()}`,
		title: notice.title,
		description: notice.description,
		persist: true,
		action: {
			type: 'link',
			label: 'Privacy settings',
			href: '/settings#privacy',
		},
	});
}

// Internal mutations for manual recording
/**
 * VoiceFlow (speed): open the OpenAI connection while the person is still
 * talking, so the upload and tidy-up don't wait for a handshake. Only for a
 * dictation that will be sent (never a held or refused one), and only when
 * transcription goes to the default OpenAI endpoint.
 */
function warmUploadConnection(authorization: TargetAuthorization | null) {
	if (authorization?.decision.action !== 'allow') return;
	if (settings.value['transcription.selectedTranscriptionService'] !== 'OpenAI')
		return;
	if (!usesOpenAIOrigin(settings.value['apiEndpoints.openai'])) return;
	warmOpenAIConnection();
}

/** The toast once the microphone is on, by how it was chosen. */
function announceListening(toastId: string, outcome: DeviceAcquisitionOutcome) {
	switch (outcome.outcome) {
		case 'success': {
			if (routineToasts())
				notify.success.execute({
				id: toastId,
				title: 'Listening',
				description: 'Press the same keys again to paste.',
			});
			break;
		}
		case 'fallback': {
			const method = settings.value['recording.method'];
			settings.updateKey(
				`recording.${method}.deviceId`,
				outcome.deviceId,
			);
			switch (outcome.reason) {
				case 'no-device-selected': {
					notify.info.execute({
						id: toastId,
						title: 'Listening with the first microphone found',
						description: 'Choose a microphone in Settings to keep using the same one.',
						action: {
							type: 'link',
							label: 'Settings',
							href: '/settings#microphone',
						},
					});
					break;
				}
				case 'preferred-device-unavailable': {
					notify.info.execute({
						id: toastId,
						title: 'Listening with another microphone',
						description: "The one you chose isn't connected.",
						action: {
							type: 'link',
							label: 'Settings',
							href: '/settings#microphone',
						},
					});
					break;
				}
			}
		}
	}
}

const startManualRecording = defineMutation({
	mutationKey: ['commands', 'startManualRecording'] as const,
	/**
	 * VoiceFlow A2: `purpose` belongs to this start alone (the feedback
	 * hotkey), so a second press that is ignored can't change it.
	 */
	mutationFn: async (input?: { purpose?: DictationPurpose }) => {
		// VoiceFlow: Rust runs the recorder; the result comes back as an event.
		if (nativeHotkeys.recordsNatively) {
			await triggerNative('start', input?.purpose);
			return Ok(undefined);
		}
		// Prevent concurrent recording operations
		if (isRecordingOperationBusy) {
			console.info('Recording operation already in progress, ignoring start');
			return Ok(undefined);
		}
		isRecordingOperationBusy = true;
		dictationTiming.hotkey();

		// VoiceFlow: snapshot the target app before any VoiceFlow UI appears.
		const authorization = await captureAndAuthorize();
		dictationTiming.mark('target');
		if (authorization.decision.action === 'refuse') {
			isRecordingOperationBusy = false;
			manualStartRefused = true;
			reportRefused(authorization.decision);
			bar.refused(authorization.target, recordNotice(authorization.decision));
			playErrorSound();
			return Ok(undefined);
		}
		manualStartRefused = false;
		warmUploadConnection(authorization);

		await settings.switchRecordingMode('manual');

		const toastId = nanoid();
		if (routineToasts())
			notify.loading.execute({
			id: toastId,
			title: 'Starting…',
			description: '',
		});

		const { data: deviceAcquisitionOutcome, error: startRecordingError } =
			await recorder.startRecording.execute({ toastId });

		// Release mutex after the actual start operation completes
		isRecordingOperationBusy = false;

		if (startRecordingError) {
			notify.error.execute({ id: toastId, ...startRecordingError });
			bar.startFailed();
			playErrorSound();
			profilePins.release(authorization.profile);
			return Ok(undefined);
		}
		manualRecordingTarget = authorization;
		dictation.start(authorization.target);
		dictationTiming.mark('mic-ready');
		// VoiceFlow A2: the bar shows Listening with this dictation's style.
		const liveId = liveRecordingId();
		if (liveId)
			bar.begin({
				recordingId: liveId,
				purpose: input?.purpose ?? 'dictation',
				target: authorization.target,
				snapshot: authorization.profile?.snapshot ?? null,
			});

		announceListening(toastId, deviceAcquisitionOutcome);
		// Track start time for duration calculation
		manualRecordingStartTime = Date.now();
		console.info('Recording started');
		sound.playSoundIfEnabled.execute('manual-start');
		return Ok(undefined);
	},
});

/**
 * Everything after the microphone is off and the audio read back: timing,
 * the stop sound, then transcription (or voice feedback). Shared by the
 * webview's own stop and the native hotkeys' (VoiceFlow).
 */
async function afterStop({
	blob,
	recordingId,
	toastId,
	authorization,
	overrides,
	native = false,
}: {
	blob: Blob;
	recordingId: string;
	toastId: string;
	authorization: TargetAuthorization | null;
	overrides: FrozenOverrides | null;
	/** Recorded by Rust, which already played the stop sound. */
	native?: boolean;
}) {
	// A feedback recording is not a dictation: it has no timing record.
	if (overrides?.purpose === 'feedback') dictationTiming.discardOpen();
	else dictationTiming.bind(recordingId, { audioBytes: blob.size });

	console.info('Recording stopped');
	if (!native) sound.playSoundIfEnabled.execute('manual-stop');

	// Log manual recording completion
	let duration: number | undefined;
	if (manualRecordingStartTime) {
		duration = Date.now() - manualRecordingStartTime;
		manualRecordingStartTime = null; // Reset for next recording
	}
	rpc.analytics.logEvent.execute({
		type: 'manual_recording_completed',
		blob_size: blob.size,
		duration,
	});

	// VoiceFlow A2: a feedback recording is transcribed only; it never
	// reaches spellings, tidy-up or delivery (`finishStopped`).
	await finishStopped(overrides, {
		feedback: async (frozen) => {
			notify.dismiss(toastId);
			try {
				await captureVoiceFeedback({ blob, recordingId, authorization, overrides: frozen });
			} finally {
				profilePins.release(authorization?.profile);
			}
		},
		// Pipeline runs after mutex is released - new recordings can start
		// while transcription/transformation are in progress
		dictation: () =>
			processRecordingPipeline({
				blob,
				recordingId,
				toastId,
				authorization,
				durationMs: duration,
				completionTitle: 'Saved',
				completionDescription: '',
				overrides,
			}),
	});
}

/**
 * VoiceFlow 0.9.11 (warnings audit F2): with the recording bar on, it shows
 * every step, so the window's routine toasts (Starting, Listening,
 * Finishing, Saved, Transcribing, Tidying, Cancelled, Pasted, Copied) are
 * left out. Problems still show.
 */
export function routineToasts(): boolean {
	return !settings.value['bar.show'];
}

/** VoiceFlow: the soft error cue (a failed or refused dictation). */
function playErrorSound() {
	sound.playSoundIfEnabled.execute('error');
}

/**
 * VoiceFlow: a dictation's last sound, after its text was delivered, so it
 * matches what the bar shows: error when the paste failed, else done.
 */
function playDeliverySound(
	outcome: DeliveryOutcome | null | undefined,
	done: 'transcriptionComplete' | 'transformationComplete',
) {
	if (outcome === 'failed') playErrorSound();
	else sound.playSoundIfEnabled.execute(done);
}

/** A cancelled dictation: nothing kept, nothing sent. */
function afterCancel(
	cancellingId: string | null,
	toastId: string,
	/** Recorded by Rust, which already played the cancel sound. */
	native = false,
) {
	// Reset start time if recording was cancelled
	manualRecordingStartTime = null;
	profilePins.release(manualRecordingTarget?.profile);
	manualRecordingTarget = null;
	dictation.clear();
	bar.cancelled(cancellingId);
	if (routineToasts())
		notify.success.execute({
		id: toastId,
		title: 'Dictation cancelled',
		description: 'Nothing was sent.',
	});
	if (!native) sound.playSoundIfEnabled.execute('manual-cancel');
	console.info('Recording cancelled');
}

const stopManualRecording = defineMutation({
	mutationKey: ['commands', 'stopManualRecording'] as const,
	mutationFn: async () => {
		if (nativeHotkeys.recordsNatively) {
			await triggerNative('stop');
			return Ok(undefined);
		}
		// Prevent concurrent recording operations
		if (isRecordingOperationBusy) {
			console.info('Recording operation already in progress, ignoring stop');
			return Ok(undefined);
		}
		if (manualStartRefused) {
			// The start was refused; there is nothing to stop.
			manualStartRefused = false;
			return Ok(undefined);
		}
		isRecordingOperationBusy = true;
		dictationTiming.mark('stop');

		const toastId = nanoid();
		if (routineToasts())
			notify.loading.execute({
			id: toastId,
			title: 'Finishing…',
			description: '',
		});

		// VoiceFlow: this recording's snapshot, taken now so a new recording
		// started while this one is processed gets its own.
		const authorization = manualRecordingTarget;
		manualRecordingTarget = null;
		dictation.clear();
		// 0.9.11: the window the user left their cursor in (identity only, quick).
		if (authorization) authorization.atStop = await captureTarget({ checkPassword: false });
		// VoiceFlow A2: the style and expression chosen on the bar are frozen
		// now, before the audio is read back.
		const stoppingId = liveRecordingId();
		const overrides = stoppingId ? bar.stop(stoppingId) : null;
		// A long dictation may have outlived the idle connection: refresh it
		// while the audio is read back and saved.
		warmUploadConnection(authorization);

		const { data, error: stopRecordingError } =
			await recorder.stopRecording.execute({ toastId });

		// Release mutex after the actual stop operation completes
		// This allows new recordings to start while pipeline runs
		isRecordingOperationBusy = false;

		if (stopRecordingError) {
			notify.error.execute({ id: toastId, ...stopRecordingError });
			if (stoppingId)
				bar.failed(stoppingId, 'start', stopRecordingError.title, null);
			playErrorSound();
			// Feedback audio is never kept, even when reading it back failed.
			if (stoppingId && overrides?.purpose === 'feedback')
				void removeFeedbackAudio(stoppingId);
			profilePins.release(authorization?.profile);
			return Ok(undefined);
		}

		const { blob, recordingId } = data;
		await afterStop({ blob, recordingId, toastId, authorization, overrides });

		return Ok(undefined);
	},
});

// Internal mutations for VAD recording
const startVadRecording = defineMutation({
	mutationKey: ['commands', 'startVadRecording'] as const,
	mutationFn: async () => {
		await settings.switchRecordingMode('vad');

		const toastId = nanoid();
		console.info('Starting voice activated capture');
		notify.loading.execute({
			id: toastId,
			title: 'Starting voice activated capture',
			description: 'Your voice activated capture is starting...',
		});
		// VoiceFlow: each speech segment is its own recording, so each takes
		// its own snapshot when speech starts.
		let segmentTarget: Promise<TargetAuthorization> | null = null;
		const { data: deviceAcquisitionOutcome, error: startActiveListeningError } =
			await vadRecorder.startActiveListening({
				onSpeechStart: () => {
					segmentTarget = captureAndAuthorize();
					notify.success.execute({
						title: 'Speech started',
						description: 'Recording started. Speak clearly and loudly.',
					});
				},
				onSpeechEnd: async (blob) => {
					const authorization = await (segmentTarget ?? captureAndAuthorize());
					segmentTarget = null;
					if (authorization.decision.action === 'refuse') {
						// Speech was already captured: drop it, record nothing.
						reportRefused(authorization.decision);
						return;
					}
					const toastId = nanoid();
					notify.success.execute({
						id: toastId,
						title: 'Voice activated speech captured',
						description: 'Your voice activated speech has been captured.',
					});
					console.info('Voice activated speech captured');
					sound.playSoundIfEnabled.execute('vad-capture');

					// Log VAD recording completion
					rpc.analytics.logEvent.execute({
						type: 'vad_recording_completed',
						blob_size: blob.size,
						// VAD doesn't track duration by default
					});

					await processRecordingPipeline({
						blob,
						toastId,
						authorization,
						completionTitle: 'Voice activated capture complete!',
						completionDescription:
							'Voice activated capture complete! Ready for another take',
					});
				},
			});
		if (startActiveListeningError) {
			notify.error.execute({ id: toastId, ...startActiveListeningError });
			return Ok(undefined);
		}

		// Handle device acquisition outcome
		switch (deviceAcquisitionOutcome.outcome) {
			case 'success': {
				notify.success.execute({
					id: toastId,
					title: 'Voice activated capture started',
					description: 'Your voice activated capture has been started.',
				});
				break;
			}
			case 'fallback': {
				settings.updateKey(
					'recording.navigator.deviceId',
					deviceAcquisitionOutcome.deviceId,
				);
				switch (deviceAcquisitionOutcome.reason) {
					case 'no-device-selected': {
						notify.info.execute({
							id: toastId,
							title: 'VAD started with available microphone',
							description:
								'No microphone was selected for VAD, so we automatically connected to an available one. You can update your selection in settings.',
							action: {
								type: 'link',
								label: 'Settings',
								href: '/settings#microphone',
							},
						});
						break;
					}
					case 'preferred-device-unavailable': {
						notify.info.execute({
							id: toastId,
							title: 'VAD switched to different microphone',
							description:
								"Your previously selected VAD microphone wasn't found, so we automatically connected to an available one.",
							action: {
								type: 'link',
								label: 'Settings',
								href: '/settings#microphone',
							},
						});
						break;
					}
				}
			}
		}

		sound.playSoundIfEnabled.execute('vad-start');
		return Ok(undefined);
	},
});

const stopVadRecording = defineMutation({
	mutationKey: ['commands', 'stopVadRecording'] as const,
	mutationFn: async () => {
		const toastId = nanoid();
		console.info('Stopping voice activated capture');
		notify.loading.execute({
			id: toastId,
			title: 'Stopping voice activated capture...',
			description: 'Finalizing your voice activated capture...',
		});
		const { error: stopVadError } = await vadRecorder.stopActiveListening();
		if (stopVadError) {
			notify.error.execute({ id: toastId, ...stopVadError });
			return Ok(undefined);
		}
		notify.success.execute({
			id: toastId,
			title: 'Voice activated capture stopped',
			description: 'Your voice activated capture has been stopped.',
		});
		sound.playSoundIfEnabled.execute('vad-stop');
		return Ok(undefined);
	},
});

export const commands = {
	startManualRecording,
	stopManualRecording,
	startVadRecording,
	stopVadRecording,

	// Toggle manual recording
	toggleManualRecording: defineMutation({
		mutationKey: ['commands', 'toggleManualRecording'] as const,
		mutationFn: async () => {
			if (nativeHotkeys.recordsNatively) {
				await triggerNative('toggle');
				return Ok(undefined);
			}
			const { data: recorderState, error: getRecorderStateError } =
				await recorder.getRecorderState.fetch();
			if (getRecorderStateError) {
				notify.error.execute(getRecorderStateError);
				return Ok(undefined);
			}
			if (recorderState === 'RECORDING') {
				return await stopManualRecording.execute(undefined);
			}
			return await startManualRecording.execute(undefined);
		},
	}),

	// Cancel manual recording
	cancelManualRecording: defineMutation({
		mutationKey: ['commands', 'cancelManualRecording'] as const,
		mutationFn: async () => {
			if (nativeHotkeys.recordsNatively) {
				await triggerNative('cancel');
				return Ok(undefined);
			}
			// Prevent concurrent recording operations
			if (isRecordingOperationBusy) {
				console.info(
					'Recording operation already in progress, ignoring cancel',
				);
				return Ok(undefined);
			}
			isRecordingOperationBusy = true;
			const cancellingId = liveRecordingId();

			const toastId = nanoid();
			notify.loading.execute({
				id: toastId,
				title: 'Cancelling…',
				description: '',
			});
			const { data: cancelRecordingResult, error: cancelRecordingError } =
				await recorder.cancelRecording.execute({ toastId });

			// Release mutex after the actual cancel operation completes
			isRecordingOperationBusy = false;

			if (cancelRecordingError) {
				notify.error.execute({ id: toastId, ...cancelRecordingError });
				return Ok(undefined);
			}
			switch (cancelRecordingResult.status) {
				case 'no-recording': {
					notify.info.execute({
						id: toastId,
						title: 'Nothing to cancel',
						description: '',
					});
					break;
				}
				case 'cancelled': {
					// Session cleanup is now handled internally by the recorder service
					afterCancel(cancellingId, toastId);
					break;
				}
			}
			return Ok(undefined);
		},
	}),

	// Toggle VAD recording
	toggleVadRecording: defineMutation({
		mutationKey: ['commands', 'toggleVadRecording'] as const,
		mutationFn: async () => {
			if (
				vadRecorder.state === 'LISTENING' ||
				vadRecorder.state === 'SPEECH_DETECTED'
			) {
				return await stopVadRecording.execute(undefined);
			}
			return await startVadRecording.execute(undefined);
		},
	}),

	// Upload recordings (supports multiple files)
	uploadRecordings: defineMutation({
		mutationKey: ['recordings', 'uploadRecordings'] as const,
		mutationFn: async ({ files }: { files: File[] }) => {
			await settings.switchRecordingMode('upload');
			// Partition files into valid and invalid in a single pass
			const { valid: validFiles, invalid: invalidFiles } = files.reduce<{
				valid: File[];
				invalid: File[];
			}>(
				(acc, file) => {
					const isValid =
						file.type.startsWith('audio/') || file.type.startsWith('video/');
					acc[isValid ? 'valid' : 'invalid'].push(file);
					return acc;
				},
				{ valid: [], invalid: [] },
			);

			if (validFiles.length === 0) {
				return DbServiceErr({
					message: 'No valid audio or video files found.',
				});
			}

			if (invalidFiles.length > 0) {
				notify.warning.execute({
					title: 'Some files were skipped',
					description: `${invalidFiles.length} file(s) were not audio or video files`,
				});
			}

			// VoiceFlow: uploads start inside VoiceFlow; their target is whatever
			// is in front now (normally VoiceFlow itself, so nothing is pasted).
			const authorization = await captureAndAuthorize();
			if (authorization.decision.action === 'refuse') {
				reportRefused(authorization.decision);
				return Ok({ processedCount: 0, skippedCount: files.length });
			}

			// Process all valid files in parallel
			await Promise.all(
				validFiles.map(async (file) => {
					const arrayBuffer = await file.arrayBuffer();
					const audioBlob = new Blob([arrayBuffer], { type: file.type });

					// Log file upload event
					rpc.analytics.logEvent.execute({
						type: 'file_uploaded',
						blob_size: audioBlob.size,
					});

					// Each file gets its own toast notification
					const toastId = nanoid();
					await processRecordingPipeline({
						blob: audioBlob,
						toastId,
						authorization,
						completionTitle: 'File uploaded successfully!',
						completionDescription: file.name,
					});
				}),
			);

			return Ok({
				processedCount: validFiles.length,
				skippedCount: invalidFiles.length,
			});
		},
	}),

	// Open transformation picker to select a transformation
	openTransformationPicker: defineMutation({
		mutationKey: ['commands', 'openTransformationPicker'] as const,
		mutationFn: async () => {
			// VoiceFlow A2: while dictating, the same key changes this
			// dictation's style instead.
			if (bar.cycleStyle()) return Ok(undefined);
			await transformClipboardWindow.toggle();
			return Ok(undefined);
		},
	}),

	// VoiceFlow A2: expression up/down for the dictation being recorded
	nudgeExpression: defineMutation({
		mutationKey: ['commands', 'nudgeExpression'] as const,
		mutationFn: async ({ delta }: { delta: number }) => {
			bar.nudgeExpression(delta);
			return Ok(undefined);
		},
	}),

	// VoiceFlow A2: the feedback hotkey. While dictating it turns this
	// recording into feedback; otherwise it starts a feedback recording, and
	// pressed again it stops it.
	feedbackRecording: defineMutation({
		mutationKey: ['commands', 'feedbackRecording'] as const,
		mutationFn: async () => {
			const next = bar.feedbackHotkey();
			if (next === 'stop') return await stopManualRecording.execute(undefined);
			if (next === 'start')
				return await startManualRecording.execute({ purpose: 'feedback' });
			return Ok(undefined);
		},
	}),

	// VoiceFlow 0.9.23: paste the newest dictation again.
	pasteLastTranscription: defineMutation({
		mutationKey: ['commands', 'pasteLastTranscription'] as const,
		mutationFn: async () => {
			await pasteLastTranscription();
			return Ok(undefined);
		},
	}),

	// Run selected transformation on clipboard
	runTransformationOnClipboard: defineMutation({
		mutationKey: ['commands', 'runTransformationOnClipboard'] as const,
		mutationFn: async () => {
			// Get selected transformation from settings
			const transformationId =
				settings.value['transformations.selectedTransformationId'];

			if (!transformationId) {
				return WhisperingErr({
					title: 'No style chosen',
					description: 'Pick a default style under Styles first.',
					action: {
						type: 'link',
						label: 'Styles',
						href: '/styles',
					},
				});
			}

			// Get the transformation: a style from the word lists first.
			const fromProfile = resolveProfileStyle(
				transformationId,
				profilePins.snapshotFor(null),
			);
			if (fromProfile === null) {
				return WhisperingErr({
					title: 'That style is no longer in your word lists',
					description: 'Pick another default style under Styles.',
					action: {
						type: 'link',
						label: 'Styles',
						href: '/styles',
					},
				});
			}
			const { data: transformation, error: getTransformationError } =
				fromProfile
					? { data: fromProfile, error: null }
					: await db.transformations.getById(() => transformationId).fetch();

			if (getTransformationError) {
				return WhisperingErr({
					title: "Couldn't load the style",
					serviceError: getTransformationError,
				});
			}

			if (!transformation) {
				settings.updateKey('transformations.selectedTransformationId', null);
				return WhisperingErr({
					title: 'That style no longer exists',
					description: 'Pick another default style under Styles.',
					action: {
						type: 'link',
						label: 'Styles',
						href: '/styles',
					},
				});
			}

			// Read clipboard text
			const { data: clipboardText, error: readClipboardError } =
				await text.readFromClipboard.fetch();

			if (readClipboardError) {
				return WhisperingErr({
					title: "Couldn't read the clipboard",
					serviceError: readClipboardError,
				});
			}

			if (!clipboardText?.trim()) {
				return WhisperingErr({
					title: 'The clipboard is empty',
					description: 'Copy some text first, then tidy it up.',
				});
			}

			// Run transformation
			const toastId = nanoid();
			notify.loading.execute({
				id: toastId,
				title: 'Tidying up…',
				description: '',
			});

			const { data: output, error: transformError } =
				await transformer.transformInput.execute({
					input: clipboardText,
					transformation,
				});

			if (transformError) {
				notify.error.execute({ id: toastId, ...transformError });
				return Ok(undefined);
			}

			sound.playSoundIfEnabled.execute('transformationComplete');

			await delivery.deliverTransformationResult.execute({
				text: output,
				toastId,
			});

			return Ok(undefined);
		},
		onError: (error) => {
			notify.error.execute(error);
		},
	}),
};

/**
 * Processes a recording through the full pipeline: save → transcribe → transform
 *
 * This function handles the complete flow from recording creation through transcription:
 * 1. Creates recording metadata and saves to database
 * 2. Handles database save errors
 * 3. Shows completion toast
 * 4. Executes transcription flow
 * 5. Applies transformation if one is selected
 *
 * VoiceFlow: the recording carries the target snapshot taken at the hotkey
 * (spec §2.1). Since 0.9.11 nothing is held: every recording is
 * transcribed, and where the words go is decided when they are ready.
 *
 * @param recordingId - Optional recording ID. When provided (e.g., from CPAL recorder),
 * the ID was generated earlier in the pipeline and is passed through for consistency.
 * When omitted (e.g., VAD recording, file uploads), a new ID is generated here using nanoid().
 * This flexibility allows different recording methods to control ID generation at the
 * appropriate point in their respective pipelines.
 */
async function processRecordingPipeline({
	blob,
	recordingId,
	toastId,
	authorization,
	durationMs,
	completionTitle,
	completionDescription,
	overrides,
}: {
	blob: Blob;
	/** VoiceFlow A2: the style and expression frozen at Stop on the bar. */
	overrides?: FrozenOverrides | null;
	/** VoiceFlow C1: how long the audio is, when the recorder knows. */
	durationMs?: number;
	recordingId?: string;
	toastId: string;
	/** The snapshot from the hotkey. Missing → treated as unresolved. */
	authorization: TargetAuthorization | null;
	completionTitle: string;
	completionDescription: string;
}) {
	const newRecordingId = recordingId ?? nanoid();
	// VoiceFlow B + C2: this dictation keeps the word lists it started with;
	// once it is delivered (or failed) refreshes may run again.
	profilePins.bind(newRecordingId, authorization?.profile);
	try {
		await runRecordingPipeline({
			blob,
			newRecordingId,
			toastId,
			authorization,
			durationMs,
			completionTitle,
			completionDescription,
			overrides,
		});
	} finally {
		profilePins.release(authorization?.profile);
	}
}

async function runRecordingPipeline({
	blob,
	newRecordingId,
	toastId,
	authorization,
	durationMs,
	completionTitle,
	completionDescription,
	overrides,
}: {
	blob: Blob;
	newRecordingId: string;
	toastId: string;
	authorization: TargetAuthorization | null;
	durationMs?: number;
	completionTitle: string;
	completionDescription: string;
	overrides?: FrozenOverrides | null;
}) {
	const now = new Date().toISOString();

	// No snapshot means identity was never established: no app context.
	// (0.9.11: it is still transcribed; the paste rule decides where it goes.)
	const { target, decision } = authorization ?? {
		target: unresolvedTarget('no snapshot for this recording'),
		decision: decideAtRecordStart(unresolvedTarget('no snapshot for this recording')),
	};
	const privacy = recordingPrivacyFor(decision);
	rememberStopTarget(newRecordingId, authorization?.atStop);

	const recording: Recording = {
		id: newRecordingId,
		title: '',
		subtitle: '',
		timestamp: now,
		createdAt: now,
		updatedAt: now,
		transcribedText: '',
		transcriptionStatus: 'UNPROCESSED',
		...recordingTargetFields(target, privacy),
	};
	const length = durationMs ?? (await audioDurationMs(blob));
	if (length && length > 0) recording.durationMs = Math.round(length);

	const { error: createRecordingError } = await db.recordings.create.execute({
		recording,
		audio: blob,
	});

	if (createRecordingError) {
		playErrorSound();
		bar.failed(
			newRecordingId,
			'start',
			"Your dictation was recorded but couldn't be saved.",
			createRecordingError.message,
		);
		notify.error.execute({
			id: toastId,
			title:
				"Your dictation was recorded but couldn't be saved.",
			description: createRecordingError.message,
			action: { type: 'more-details', error: createRecordingError },
		});
		return;
	}

	dictationTiming.markRecording(newRecordingId, 'db-saved');
	if (routineToasts())
		notify.success.execute({
		id: toastId,
		title: completionTitle,
		description: completionDescription,
	});

	await transcribeAndDeliver({
		recording,
		paste: { target, privacy, restoreFocus: false, atStop: authorization?.atStop ?? null },
		audio: blob,
		overrides,
	});
}

/**
 * Send anyway (spec §4.3), kept for dictations held by 0.9.10 (nothing is
 * held since 0.9.11): this one recording's audio is transcribed, with
 * no context; the result is never pasted automatically, it goes to the
 * clipboard and Recordings with a notice. It never overrides a refusal:
 * refused dictations are never recorded in the first place.
 */
function sendHeldRecording(recordingId: string) {
	return recoveryOnce.run(recordingId, () => sendHeldRecordingNow(recordingId));
}

async function sendHeldRecordingNow(recordingId: string) {
	notify.dismiss(`held-${recordingId}`);
	const { data: stored, error } = await db.recordings
		.getById(() => recordingId)
		.fetch();
	if (error || !stored) {
		notify.error.execute({
			title: "Couldn't find the held dictation",
			description: error
				? error.message
				: 'It may have been deleted from History.',
		});
		return;
	}
	if (stored.privacy !== 'held') return;

	const recording: Recording = { ...stored, privacy: 'sent-anyway' };
	const { error: updateError } = await db.recordings.update.execute(recording);
	if (updateError) {
		notify.error.execute({
			title: "Couldn't send the held dictation",
			description: updateError.message,
			action: { type: 'more-details', error: updateError },
		});
		return;
	}
	await transcribeAndDeliver({
		recording,
		paste: { target: null, privacy: 'sent-anyway', restoreFocus: false },
		// VoiceFlow A2: the style chosen on the bar, if it was this session.
		overrides: bar.frozen(recordingId),
	});
}

// ============================================================================
// VoiceFlow: transcription, tidy-up and delivery with visible failures
// (spec §2.1, design B3.1 "Problems explain themselves").
//
// - With a tidy-up selected, only the tidied text is pasted. If tidy-up fails
//   or takes longer than TIDY_UP_TIMEOUT_MS, NOTHING is pasted: the raw
//   transcript stays in Recordings (and goes to the clipboard only if the user
//   turned on clipboard copy for transcripts), and a persistent error offers
//   Retry tidy-up and Paste raw text.
// - If transcription fails, the audio stays saved and a persistent error
//   offers Retry.
// - Both errors also go to the notification log and an OS notification.
// - Every paste goes through paste-time authorization (spec §4.3). A paste
//   started from a button first brings the recording's own window back.
// ============================================================================

/** Tidy-up gets this long before VoiceFlow gives up on it (spec §2.1). */
const TIDY_UP_TIMEOUT_MS = 10_000;

/**
 * 0.9.12 (F5): when "Nothing heard" removes a longer recording's audio with
 * Keep recordings off: just after the minute retention keeps it for Retry.
 */
const EMPTY_RETRY_AUDIO_MS = EMPTY_RETRY_KEEP_MS + 1000;

/** The same paste context, started from a VoiceFlow button. */
function fromButton(paste: PasteContext): PasteContext {
	return { ...paste, restoreFocus: true };
}

async function transcribeAndDeliver({
	recording,
	paste,
	audio,
	overrides,
}: {
	recording: Recording;
	/** Where the text may go: the recording's target and how it was authorized. */
	paste: PasteContext;
	/** VoiceFlow (speed): the audio already in memory, for a fresh dictation. */
	audio?: Blob;
	/** VoiceFlow A2: style and expression chosen on the bar for this dictation. */
	overrides?: FrozenOverrides | null;
}) {
	const transcribeToastId = `transcribe-${recording.id}`;
	dictationTiming.markRecording(recording.id, 'transcribe-start');
	bar.transcribing(recording.id);
	if (routineToasts())
		notify.loading.execute({
		id: transcribeToastId,
		title: 'Turning your words into text…',
		description: '',
	});

	const { data: transcribedText, error: transcribeError } =
		await transcription.transcribeRecording.execute(
			audio ? { recording, audio } : recording,
		);
	dictationTiming.markRecording(recording.id, 'transcript-saved');

	if (transcribeError) {
		void noteEvidence(recording.id, { outcome: 'transcription-failed' });
		dictationTiming.finish(recording.id, { outcome: 'transcription-failed' });
		const reason =
			transcribeError.name === 'WhisperingError'
				? [transcribeError.title, transcribeError.description]
						.filter(Boolean)
						.join(': ')
				: 'Your recording could not be transcribed.';
		await updateRecordingFields(recording.id, {
			result: 'no-text',
			problemKind: 'transcription',
			problem: reason,
			problemDismissed: false,
		});
		playErrorSound();
		bar.failed(
			recording.id,
			'transcription',
			"Couldn't turn your words into text",
			`${reason} Your audio is saved in History.`,
		);
		notify.error.execute({
			id: transcribeToastId,
			title: "VoiceLnq couldn't turn your words into text",
			description: `${reason} Your audio is saved in History.`,
			// 0.9.11: hides by itself; Home and History keep the problem.
			persist: false,
			action: {
				type: 'button',
				label: 'Retry',
				onClick: () =>
					recoveryOnce.run(recording.id, () =>
						transcribeAndDeliver({ recording, paste: fromButton(paste), overrides }),
					),
			},
			secondaryAction:
				transcribeError.name === 'WhisperingError' &&
				transcribeError.action?.type === 'link'
					? transcribeError.action
					: undefined,
		});
		return;
	}

	// 0.9.11: no speech, nothing to deliver: a short "Nothing heard" that
	// hides itself. The only dictation that delivers nothing.
	if (!transcribedText.trim()) {
		void noteEvidence(recording.id, { outcome: 'kept', pastedInto: undefined });
		dictationTiming.finish(recording.id, { outcome: 'nothing-heard' });
		await updateRecordingFields(recording.id, {
			result: 'no-text',
			problem: undefined,
			problemKind: undefined,
			problemDismissed: undefined,
		});
		// 0.9.12 (F5): a recording of 3 s or more may have been misheard, so
		// the bar offers Retry; its audio stays a minute for that, even with
		// Keep recordings off. A short tap has nothing worth retrying.
		const retry = worthRetrying(recording.durationMs);
		bar.failed(
			recording.id,
			'empty',
			'Nothing heard',
			'No speech was heard, so there was nothing to paste.',
			{ retry },
		);
		notify.dismiss(transcribeToastId);
		if (retry) setTimeout(() => void removeAudioIfOff(recording.id), EMPTY_RETRY_AUDIO_MS);
		else await removeAudioIfOff(recording.id);
		return;
	}

	const transformationId = styleIdFor(overrides);
	// VoiceFlow phase F: a new transcript starts the dictation's evidence over.
	void noteEvidence(recording.id, {
		appName: recording.appName,
		appId: appIdOf(recording) ?? undefined,
		appBundleId: recording.appBundleId?.toLowerCase(),
		rawText: transcribedText,
		models: { transcription: transcriptionModelOf(settings.value) },
		profileId: profilePins.snapshotFor(recording.id)?.id,
		tidyOutput: undefined,
		tidyConfig: undefined,
		deliveredText: undefined,
		corrections: undefined,
		outcome: undefined,
		pastedInto: undefined,
		...(transformationId ? {} : { styleId: RAW_STYLE_ID, styleName: undefined, expression: null }),
	});

	// No tidy-up selected: the transcript is the final text.
	if (!transformationId) {
		const { data: outcome } = await delivery.deliverTranscriptionResult.execute({
			text: transcribedText,
			toastId: transcribeToastId,
			paste,
			recording: { id: recording.id, appId: appIdOf(recording) },
			traceId: recording.id,
		});
		// One sound per dictation, with the bar's outcome: done, or error when
		// the paste failed. With a tidy-up, it plays when that finishes.
		playDeliverySound(outcome, 'transcriptionComplete');
		dictationTiming.finish(recording.id, { words: countWords(transcribedText) });
		await removeAudioIfOff(recording.id);
		return;
	}

	notify.dismiss(transcribeToastId);
	await tidyUpAndDeliver({
		recordingId: recording.id,
		rawText: transcribedText,
		transformationId,
		expression: overrides?.expression ?? null,
		paste,
		appId: appIdOf(recording),
	});
	// VoiceFlow C1: Keep recordings Off removes the audio once there is text.
	await removeAudioIfOff(recording.id);
}

async function tidyUpAndDeliver({
	recordingId,
	rawText,
	transformationId,
	expression = null,
	paste,
	appId,
}: {
	recordingId: string;
	rawText: string;
	transformationId: string;
	/** VoiceFlow A2: 0–4 chosen on the bar; null keeps the style's own. */
	expression?: number | null;
	paste: PasteContext;
	/** For spellings scoped to an app. */
	appId: string | null;
}) {
	const tidyToastId = `tidy-up-${recordingId}`;
	dictationTiming.markRecording(recordingId, 'tidy-start');
	bar.tidying(recordingId);
	if (routineToasts())
		notify.loading.execute({
		id: tidyToastId,
		title: 'Tidying up…',
		description: '',
	});

	const outcome = await runTidyUpWithTimeout({
		recordingId,
		rawText,
		transformationId,
		expression,
		appId,
	});
	dictationTiming.markRecording(recordingId, 'tidy-done');

	if (!outcome.ok) {
		void noteEvidence(recordingId, {
			styleId: transformationId,
			outcome: 'tidy-failed',
			tidyOutput: undefined,
			tidyConfig: undefined,
		});
		dictationTiming.finish(recordingId, { outcome: 'tidy-failed' });
		await reportTidyUpFailure({
			recordingId,
			rawText,
			transformationId,
			expression,
			reason: outcome.reason,
			timedOut: outcome.timedOut,
			toastId: tidyToastId,
			paste,
			appId,
		});
		return;
	}

	void noteEvidence(recordingId, {
		styleId: transformationId,
		styleName: outcome.styleName,
		expression: outcome.expression,
		tidyOutput: outcome.heldBack || outcome.output,
		models: { tidyUp: outcome.model },
		// 0.9.16: the tidy-up exactly as it ran, for a faithful re-run later.
		tidyConfig: await outcome.config.catch(() => undefined),
	});
	// 0.9.13: the language guard kept the user's own words. They are delivered as
	// usual (spellings applied once); the tidy-up stays in History for "Use
	// cleaned", and the bar says so. Nothing blocks, nothing is lost.
	const keptWords = !!outcome.heldBack;
	await updateRecordingFields(recordingId, {
		heldBackText: keptWords ? outcome.heldBack : undefined,
		heldBackReason: keptWords ? outcome.fallbackReason : undefined,
		heldBackStyle: keptWords ? outcome.styleName : undefined,
	});
	const { data: delivered } = await delivery.deliverTransformationResult.execute({
		text: outcome.output,
		toastId: tidyToastId,
		paste,
		recording: {
			id: recordingId,
			appId,
			styleName: keptWords ? undefined : outcome.styleName,
			keptWords: keptWords
				? { reason: outcome.fallbackReason, styleName: outcome.styleName }
				: undefined,
		},
		traceId: recordingId,
	});
	playDeliverySound(delivered, 'transformationComplete');
	dictationTiming.finish(recordingId, { words: countWords(outcome.output) });
}

/**
 * Runs the selected tidy-up on a recording's transcript, giving up after
 * TIDY_UP_TIMEOUT_MS. Every failure comes back as a plain-language reason.
 */
async function runTidyUpWithTimeout({
	recordingId,
	rawText,
	transformationId,
	expression = null,
	appId = null,
}: {
	recordingId: string;
	/** 0.9.13: the transcript as captured, for the language guard. */
	rawText: string;
	transformationId: string;
	/** VoiceFlow A2: added to the style's prompt for this run only. */
	expression?: number | null;
	/** 0.9.14: the app it was dictated into, for the tidy-up's word list. */
	appId?: string | null;
}): Promise<
	| {
			ok: true;
			/** What to deliver: the tidy-up, or the user's own words after the guard held it back. */
			output: string;
			styleName: string;
			/** VoiceFlow phase F: the level used (null: the style's prompt only). */
			expression: number | null;
			model?: string;
			/** 0.9.13: the tidy-up held back for "Use cleaned"; empty when none. */
			heldBack: string;
			/** 0.9.13: why it was held back (a drift reason); empty when it wasn't. */
			fallbackReason: string;
			/** 0.9.13: a strict retry was made. */
			retried: boolean;
			/** 0.9.16: the tidy-up exactly as it ran (stage evidence). */
			config: Promise<TidyConfig>;
	  }
	| { ok: false; reason: string; timedOut?: boolean }
> {
	// VoiceFlow B + C2: a style from the word lists, as pinned for this dictation.
	const fromProfile =
		resolveProfileStyle(transformationId, profilePins.snapshotFor(recordingId)) ??
		resolveProfileStyle(transformationId, profilePins.snapshotFor(null));
	if (fromProfile === null) {
		return {
			ok: false,
			reason:
				'The style it uses is no longer in your word lists. Pick another one under Styles.',
		};
	}
	const { data: transformation, error: getTransformationError } = fromProfile
		? { data: fromProfile, error: null }
		: await db.transformations.getById(() => transformationId).fetch();

	if (getTransformationError) {
		return {
			ok: false,
			reason: `The tidy-up could not be loaded (${getTransformationError.message}).`,
		};
	}

	if (!transformation) {
		// VoiceFlow A2: only the default is reset; a style picked on the bar
		// for one dictation is not the default.
		if (settings.value['transformations.selectedTransformationId'] === transformationId)
			settings.updateKey('transformations.selectedTransformationId', null);
		return {
			ok: false,
			reason:
				'The style it uses no longer exists. Pick another one under Styles.',
		};
	}
	// The expression chosen on the bar, else a word-list style's own.
	const profileStyle = fromProfile
		? (profileStyleOf(transformationId, profilePins.snapshotFor(recordingId)) ??
			profileStyleOf(transformationId, profilePins.snapshotFor(null)))
		: null;
	// 0.9.13: a word-list style's expression override needs a level to
	// follow; as on Android (which always has one), Natural when none is set.
	const level =
		expression ??
		profileStyle?.expression ??
		(profileStyle?.expressionOverride?.trim() ? DEFAULT_EXPRESSION : null);
	const kind = profileStyle
		? presetKindOfProfileStyle(profileStyle)
		: presetKindOf(transformation.title);
	const expressed =
		level === null
			? transformation
			: profileStyle
				? withExpression(transformation, level, kind, profileStyle.expressionOverride)
				: withExpression(transformation, level);
	// 0.9.14: the words this speaker uses, after the style's own instructions,
	// so the tidy-up can fix a sound-alike mishearing from the context. From
	// the snapshot pinned to this dictation; never for the fun styles.
	const tidyWords = isFunKind(kind)
		? { text: '', words: [] }
		: tidyWordsBlock(profilePins.snapshotFor(recordingId), appId);
	const withWords = withTidyWords(expressed, tidyWords.text);
	// 0.9.16: a local endpoint is fixed before the run (a step's own, else the
	// default), so what runs is exactly what the dictation's evidence keeps.
	// The same value the transformer would fall back to; never a key.
	const styled: typeof withWords = {
		...withWords,
		steps: withWords.steps.map((step) =>
			step['prompt_transform.inference.provider'] === 'Custom' &&
			!step['prompt_transform.inference.provider.Custom.baseUrl']?.trim()
				? {
						...step,
						'prompt_transform.inference.provider.Custom.baseUrl':
							settings.value['completion.custom.baseUrl']?.trim() ?? '',
					}
				: step,
		),
	};

	// The word lists may give tidy-up more (or less) time than the default.
	const timeoutMs = tidyUpTimeoutMs(
		profilePins.snapshotFor(recordingId) ?? profilePins.snapshotFor(null),
		TIDY_UP_TIMEOUT_MS,
	);

	/** One run of the style, within the time allowed (each run gets it all). */
	const attempt: TidyAttempt = async (strict) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(() => resolve('timeout'), timeoutMs);
		});
		const result = await Promise.race([
			transformer.transformRecording.execute({
				recordingId,
				transformation: strict ? strictTransformation(styled) : styled,
			}),
			timedOut,
		]);
		clearTimeout(timer);
		if (result === 'timeout')
			return { ok: false, reason: `Tidy-up took over ${timeoutMs / 1000} seconds`, timedOut: true };
		const { data: run, error: transformError } = result;
		if (transformError)
			return {
				ok: false,
				reason: [transformError.title, transformError.description].filter(Boolean).join(': '),
			};
		if (run.status === 'failed') return { ok: false, reason: run.error };
		if (!run.output.trim()) return { ok: false, reason: 'Tidy-up returned no text.' };
		return { ok: true, output: run.output };
	};

	// 0.9.13: the language guard (Android parity): check, one strict retry,
	// then the user's own words with the tidy-up held back. The style's own
	// find-and-replace steps are applied to the transcript it is compared
	// with, so what the style replaces never counts as drift.
	const guarded = await guardedTidyUp({
		transcript: rawText,
		source: withFindReplace(rawText, styled.steps),
		funStyle: isFunKind(kind),
		words: tidyWords.words,
		attempt,
	});
	if (!guarded.ok) return guarded;
	if (guarded.retried || guarded.mixed)
		// Reason codes only, never text.
		console.info(
			`[tidy] language guard: mixed=${guarded.mixed} retried=${guarded.retried} fallback=${guarded.fallbackReason || 'none'}`,
		);
	const pinned = profilePins.snapshotFor(recordingId);
	return {
		ok: true,
		output: guarded.text,
		styleName: transformation.title,
		expression: level,
		model: tidyModelOf(transformation),
		heldBack: guarded.heldBack,
		fallbackReason: guarded.fallbackReason,
		retried: guarded.retried,
		config: tidyConfigOf({
			styleId: transformationId,
			styleName: transformation.title,
			source: fromProfile ? 'word-lists' : 'this-pc',
			styleSteps: transformation.steps,
			runSteps: styled.steps,
			...(profileStyle?.layer ? { styleLayer: profileStyle.layer } : {}),
			...(profileStyle?.editIds?.length ? { styleEdits: profileStyle.editIds } : {}),
			expression: level,
			model: tidyModelOf(transformation),
			profileId: pinned?.id,
			words: tidyWords.words,
			retried: guarded.retried,
		}),
	};
}

async function reportTidyUpFailure({
	recordingId,
	rawText,
	transformationId,
	expression = null,
	reason,
	timedOut,
	toastId,
	paste,
	appId,
}: {
	recordingId: string;
	rawText: string;
	transformationId: string;
	expression?: number | null;
	reason: string;
	timedOut?: boolean;
	toastId: string;
	paste: PasteContext;
	appId: string | null;
}) {
	// 0.9.11 (hard rule): a dictation that is not pasted is always on the
	// clipboard. Here that is the words as heard; they are also saved.
	// Through write_text (no window: copy only), one delivery at a time.
	const { data: copyResult } = await text.writeToCursor.execute({ text: rawText });
	const copied =
		copyResult?.copied === true ||
		!(await text.copyToClipboard.execute({ text: rawText })).error;

	const kept = copied
		? 'Your words as heard are on the clipboard: press Ctrl+V to paste them.'
		: 'Your words were kept instead of pasted.';
	const cause = timedOut
		? `${reason}. ${kept}`
		: `${reason.replace(/[.\s]+$/, '')}. ${kept}`;
	// 0.9.12 (F4b): words on the clipboard are delivered (Copied), so Home
	// leaves it out; History keeps what went wrong, and Retry tidy-up.
	await updateRecordingFields(recordingId, {
		result: copied ? 'copied' : 'not-pasted',
		problemKind: 'tidy-up',
		problem: cause,
		problemDismissed: false,
	});

	const app = paste.target?.appName;
	playErrorSound();
	bar.failed(
		recordingId,
		'tidy-up',
		// 0.9.11: the visible line says the words are on the clipboard.
		copied
			? 'Copied. Press Ctrl+V to paste.'
			: app
				? `Nothing was pasted into ${app}`
				: 'Nothing was pasted',
		cause,
	);
	notify.error.execute({
		id: toastId,
		title: copied
			? 'Copied. Press Ctrl+V to paste.'
			: app
				? `Nothing was pasted into ${app}`
				: 'Nothing was pasted',
		description: cause,
		// 0.9.11: hides by itself; Home and History keep the problem.
		persist: false,
		action: {
			type: 'button',
			label: 'Retry tidy-up',
			onClick: () =>
				recoveryOnce.run(recordingId, () =>
					tidyUpAndDeliver({
						recordingId,
						rawText,
						transformationId,
						expression,
						paste: fromButton(paste),
						appId,
					}),
				),
		},
		secondaryAction: {
			type: 'button',
			label: 'Paste raw text',
			onClick: () =>
				recoveryOnce.run(recordingId, () =>
					pasteRawText({ rawText, paste: fromButton(paste), recordingId, appId }),
				),
		},
	});
}

/**
 * Paste raw text, from the tidy-up notice: bring the recording's window back,
 * re-run the paste-time check, then paste. If the window is gone, the text
 * goes to the clipboard with a notice. Saved spellings still apply.
 */
async function pasteRawText({
	rawText,
	paste,
	recordingId,
	appId,
}: {
	rawText: string;
	paste: PasteContext;
	recordingId?: string;
	appId?: string | null;
}) {
	const toastId = `paste-raw-${nanoid()}`;
	const spelled = await applySavedSpellings(rawText, appId ?? null, recordingId);
	const finalText = spelled.text;
	if (recordingId)
		void noteEvidence(recordingId, {
			styleId: RAW_STYLE_ID,
			expression: null,
			tidyOutput: undefined,
			deliveredText: finalText,
			corrections: spelled.changes,
		});
	// 0.9.11: pasted or copied by the same rules as a fresh dictation.
	const delivered = await placeText(finalText, paste);
	if (recordingId) {
		await updateRecordingFields(recordingId, { finalText, styleName: undefined });
		if (delivered.result !== 'not-pasted') notify.dismiss(`tidy-up-${recordingId}`);
	}
	await reportDelivered({
		delivered,
		text: finalText,
		toastId,
		recordingId,
		styleName: recordingId ? null : undefined,
	});
}

// ============================================================================
// VoiceFlow C1: fixes offered on Home ("Needs you") and in History.
// ============================================================================

async function loadRecording(recordingId: string): Promise<Recording | null> {
	const { data, error } = await db.recordings
		.getById(() => recordingId)
		.fetch();
	if (error || !data) {
		notify.error.execute({
			title: "Couldn't find that dictation",
			description: error ? error.message : 'It may have been deleted.',
		});
		return null;
	}
	return data;
}

function pasteContextFor(recording: Recording): PasteContext {
	// 0.9.11 (Codex review): a retry goes to the window that was in front at
	// Stop, as the first try would have; known for this session's dictations.
	const atStop = stopTargets.get(recording.id) ?? null;
	return {
		target: atStop ?? targetFromRecording(recording),
		privacy: recording.privacy,
		restoreFocus: true,
		atStop,
	};
}

/**
 * 0.9.11: the window in front at Stop, per dictation, for retries from the
 * bar, notices, Home and History in this session. Bounded.
 */
const stopTargets = new Map<string, TargetSnapshot>();
function rememberStopTarget(recordingId: string, target: TargetSnapshot | null | undefined) {
	if (!target) return;
	stopTargets.set(recordingId, target);
	while (stopTargets.size > 50) {
		const oldest = stopTargets.keys().next().value;
		if (oldest === undefined) break;
		stopTargets.delete(oldest);
	}
}

/** One recovery action per dictation at a time (bar, notices, Home, History). */
const recoveryOnce = createExclusive();

async function retryTidyUpNow(recordingId: string) {
	const recording = await loadRecording(recordingId);
	if (!recording) return;
	// VoiceFlow A2: the style chosen on the bar for this dictation, if any.
	const overrides = bar.frozen(recordingId);
	const transformationId = styleIdFor(overrides);
	if (!transformationId) {
		await pasteRawText({
			rawText: recording.transcribedText,
			paste: pasteContextFor(recording),
			recordingId,
			appId: appIdOf(recording),
		});
		return;
	}
	await tidyUpAndDeliver({
		recordingId,
		rawText: recording.transcribedText,
		transformationId,
		expression: overrides?.expression ?? null,
		paste: pasteContextFor(recording),
		appId: appIdOf(recording),
	});
}

async function pasteRawNow(recordingId: string) {
	const recording = await loadRecording(recordingId);
	if (!recording) return;
	await pasteRawText({
		rawText: recording.transcribedText,
		paste: pasteContextFor(recording),
		recordingId,
		appId: appIdOf(recording),
	});
}

/** The paste keys, for the Use cleaned notice. */
const PASTE_KEYS = IS_MACOS ? 'Cmd+V' : 'Ctrl+V';

async function useCleanedNow(recordingId: string): Promise<{ ok: boolean; message: string }> {
	const recording = await loadRecording(recordingId);
	if (!recording) return { ok: false, message: 'That dictation is no longer in History.' };
	const held = recording.heldBackText?.trim();
	if (!held) return { ok: false, message: 'There is no tidied text held back for this dictation.' };
	const appId = appIdOf(recording);
	const spelled = await applySavedSpellings(held, appId, recordingId);
	const cleaned = spelled.text;
	const { error } = await text.copyToClipboard.execute({ text: cleaned });
	if (error) return { ok: false, message: `Couldn't use the clipboard (${error.message}).` };
	// It is on the clipboard now: the dictation counts as copied, and an
	// earlier problem with it (a paste that failed) is fixed.
	for (const prefix of ['tidy-up-', 'transcribe-', 'paste-'])
		notify.dismiss(`${prefix}${recordingId}`);
	await updateRecordingFields(recordingId, {
		finalText: cleaned,
		styleName: recording.heldBackStyle,
		result: 'copied',
		problem: undefined,
		problemKind: undefined,
		problemDismissed: undefined,
		heldBackText: undefined,
		heldBackReason: undefined,
		heldBackStyle: undefined,
	});
	void noteEvidence(recordingId, { deliveredText: cleaned, corrections: spelled.changes, outcome: 'copied' });
	bar.delivered(recordingId, 'copied', {
		app: null,
		text: cleaned,
		styleName: recording.heldBackStyle ?? undefined,
		copied: { keys: PASTE_KEYS, why: 'The tidied text is on the clipboard: select your words and paste to replace them.' },
	});
	return { ok: true, message: `Tidied text copied. Select your words and press ${PASTE_KEYS} to replace them.` };
}

async function retryTranscriptionNow(recordingId: string) {
	const recording = await loadRecording(recordingId);
	if (!recording) return;
	await transcribeAndDeliver({
		recording,
		paste: pasteContextFor(recording),
		overrides: bar.frozen(recordingId),
	});
}

/**
 * VoiceFlow phase F: "Paste into <app>" for a feedback fix's corrected text.
 * The dictation's own window is brought back and the paste-time check runs
 * again (spec §4.3); a held or sent-anyway dictation is never pasted, and
 * when the target is gone the text goes to the clipboard instead. The text
 * is pasted as the person edited it: no spellings are applied to it.
 */
async function pasteCorrectedNow(
	recordingId: string,
	corrected: string,
): Promise<{ ok: boolean; message: string }> {
	const recording = await loadRecording(recordingId);
	if (!recording) return { ok: false, message: 'That dictation is no longer in History.' };
	if (!corrected.trim()) return { ok: false, message: 'There is no text to paste.' };
	// 0.9.11: pasted, or copied when there is nowhere to paste.
	const delivered = await placeText(corrected, pasteContextFor(recording));
	const notice = deliveryNotice(delivered);
	return {
		ok: delivered.result === 'pasted',
		message: [notice.title, notice.description].filter(Boolean).join(' '),
	};
}

export const recovery = {
	/** Phase F: paste a feedback fix's corrected text into the dictation's app. */
	async pasteCorrected(recordingId: string, corrected: string) {
		const result = await recoveryOnce.run(recordingId, () =>
			pasteCorrectedNow(recordingId, corrected),
		);
		return result ?? { ok: false, message: 'This dictation is busy. Try again in a moment.' };
	},

	/** Retry tidy-up with the style it had (or the default), then paste. */
	retryTidyUp(recordingId: string) {
		return recoveryOnce.run(recordingId, () => retryTidyUpNow(recordingId));
	},

	/** Paste the words as heard (with saved spellings) into the original app. */
	pasteRaw(recordingId: string) {
		return recoveryOnce.run(recordingId, () => pasteRawNow(recordingId));
	},

	/**
	 * 0.9.13: "Use cleaned", after the language guard kept the user's own words:
	 * the tidied text it held back, with saved spellings, goes to the
	 * clipboard and becomes the dictation's text in History. It is copied,
	 * never pasted over the user's words: VoiceFlow can't be sure the field still
	 * holds them, and another field is never overwritten.
	 */
	async useCleaned(recordingId: string): Promise<{ ok: boolean; message: string }> {
		const result = await recoveryOnce.run(recordingId, () => useCleanedNow(recordingId));
		return result ?? { ok: false, message: 'This dictation is busy. Try again in a moment.' };
	},

	/** Try speech-to-text again on the saved audio. */
	retryTranscription(recordingId: string) {
		return recoveryOnce.run(recordingId, () => retryTranscriptionNow(recordingId));
	},

	/** Send a held dictation (spec §4.3); never pasted automatically. */
	sendAnyway: (recordingId: string) => sendHeldRecording(recordingId),

	/** Hide a problem from Home; History still shows the result. */
	async dismiss(recordingId: string) {
		// 0.9.11: its toasts close too, wherever it was dismissed.
		for (const prefix of ['tidy-up-', 'transcribe-', 'paste-'])
			notify.dismiss(`${prefix}${recordingId}`);
		await updateRecordingFields(recordingId, { problemDismissed: true });
	},

	/**
	 * 0.9.12 (F4d): Copy text on a problem card. The words are on the
	 * clipboard, so the dictation counts as copied: off Home, its notices
	 * closed; History keeps what went wrong.
	 */
	async markCopied(recordingId: string) {
		for (const prefix of ['tidy-up-', 'transcribe-', 'paste-'])
			notify.dismiss(`${prefix}${recordingId}`);
		await updateRecordingFields(recordingId, { result: 'copied' });
	},

	/** 0.9.11: Clear all on Home's "Needs you". */
	async dismissAll(recordingIds: readonly string[]) {
		for (const id of recordingIds) await recovery.dismiss(id);
	},

	/**
	 * Re-run tidy-up from History with the current style. The new text is
	 * kept and copied, never pasted: the person is in VoiceFlow, not the app.
	 */
	async rerunTidyUp(
		recordingId: string,
	): Promise<{ ok: boolean; message: string }> {
		const result = await recoveryOnce.run(recordingId, () =>
			rerunTidyUpNow(recordingId),
		);
		return (
			result ?? {
				ok: false,
				message: 'This dictation is already being handled. Try again in a moment.',
			}
		);
	},
};

/** History's re-run, inside the recovery guard. */
async function rerunTidyUpNow(
	recordingId: string,
): Promise<{ ok: boolean; message: string }> {
	const recording = await loadRecording(recordingId);
	if (!recording) return { ok: false, message: 'Dictation not found' };
	const transformationId =
		settings.value['transformations.selectedTransformationId'];
	if (!transformationId)
		return { ok: false, message: 'Pick a default style under Styles first.' };
	const outcome = await runTidyUpWithTimeout({
		recordingId,
		rawText: recording.transcribedText,
		transformationId,
		appId: appIdOf(recording),
	});
	if (!outcome.ok) return { ok: false, message: outcome.reason };
	const spelled = await applySavedSpellings(outcome.output, appIdOf(recording), recordingId);
	const finalText = spelled.text;
	// 0.9.13: the language guard may keep the user's words here too.
	const keptWords = !!outcome.heldBack;
	await updateRecordingFields(recordingId, {
		finalText,
		styleName: keptWords ? undefined : outcome.styleName,
		heldBackText: keptWords ? outcome.heldBack : undefined,
		heldBackReason: keptWords ? outcome.fallbackReason : undefined,
		heldBackStyle: keptWords ? outcome.styleName : undefined,
	});
	if (keptWords) {
		// Feedback must describe this run, not the one before it.
		void noteEvidence(recordingId, {
			styleId: transformationId,
			styleName: outcome.styleName,
			expression: outcome.expression,
			tidyOutput: outcome.heldBack,
			deliveredText: finalText,
			corrections: spelled.changes,
			outcome: 'copied',
			pastedInto: undefined,
			models: { tidyUp: outcome.model },
			tidyConfig: await outcome.config.catch(() => undefined),
		});
		await text.copyToClipboard.execute({ text: finalText });
		return {
			ok: true,
			message: `${driftReasonText(outcome.fallbackReason)}, so your own words were kept and copied. Use cleaned copies the tidied text.`,
		};
	}
	void noteEvidence(recordingId, {
		styleId: transformationId,
		styleName: outcome.styleName,
		expression: outcome.expression,
		tidyOutput: outcome.output,
		deliveredText: finalText,
		corrections: spelled.changes,
		outcome: 'copied',
		pastedInto: undefined,
		models: { tidyUp: outcome.model },
		tidyConfig: await outcome.config.catch(() => undefined),
	});
	await text.copyToClipboard.execute({ text: finalText });
	return { ok: true, message: `Tidied with ${outcome.styleName} and copied` };
}

// ============================================================================
// VoiceFlow A2: the recording bar's overrides, feedback capture and clicks.
// ============================================================================

/**
 * The style a dictation is tidied with: the one frozen at Stop on the bar,
 * else the default. Null means no tidy-up (Raw).
 */
function styleIdFor(overrides: FrozenOverrides | null | undefined): string | null {
	if (overrides) return overrides.styleId === RAW_STYLE_ID ? null : overrides.styleId;
	return settings.value['transformations.selectedTransformationId'];
}

/**
 * A feedback recording (the feedback hotkey, or "Use this recording as
 * feedback"): transcribed only, through `captureFeedback`, whose
 * dependencies can't paste, copy, tidy or save to History. The vocabulary
 * prompt comes from the word lists pinned at record start.
 */
async function captureVoiceFeedback({
	blob,
	recordingId,
	authorization,
	overrides,
}: {
	blob: Blob;
	recordingId: string;
	authorization: TargetAuthorization | null;
	overrides: FrozenOverrides;
}) {
	const snapshot = authorization?.profile?.snapshot ?? null;
	await captureFeedback(
		{
			blob,
			recordingId,
			// 0.9.11: only a refusal at the key keeps it from being sent.
			allowed: authorization?.decision.action !== 'refuse',
			prompt: snapshot
				? buildPrompt(snapshot, null).prompt
				: settings.value['transcription.prompt'],
			overrides,
		},
		{
			transcribe: transcribeAudioOnly,
			removeAudio: removeFeedbackAudio,
			hide: (id) => bar.hide(id),
			payload: (subject, transcript) => bar.feedbackPayload(subject, transcript),
			open: (payload) => bar.openFeedbackWindow(payload),
		},
	);
}

/** "Feedback" on a delivery notice: the feedback window, to type it. */
async function openFeedbackFor(recordingId: string) {
	const payload = await bar.feedbackPayload(bar.subjectFor(recordingId), {
		text: '',
		problem: null,
		recordingId: null,
	});
	await bar.openFeedbackWindow(payload);
}

// ============================================================================
// VoiceFlow: the native dictation hotkeys (src-tauri/src/hotkey.rs)
// ============================================================================
//
// Rust captures the app in front and starts or stops the microphone at the
// key, even while this webview sleeps, then sends an event. Each event is
// handled here once, in order ($lib/hotkeys/native.ts). The privacy decision
// on Rust's snapshot is made here before anything is uploaded: Rust only
// refuses the clear Tier B cases (blocked app, password field) itself.

/** Recordings Rust started that this page's decision then refused. */
const refusedNativeRecordings = new Set<string>();
/** Each native recording's decision, by recording id. */
const nativeAuthorizations = new Map<string, TargetAuthorization>();

type NativeOf<K extends NativeEvent['kind']> = Extract<NativeEvent, { kind: K }>;

/** The app's own start/stop/cancel when Rust runs the recorder. */
async function triggerNative(
	action: 'start' | 'stop' | 'toggle' | 'cancel',
	purpose?: DictationPurpose,
) {
	try {
		await nativeHotkeys.trigger(action, purpose ?? null);
	} catch (error) {
		notify.error.execute({
			title: "Couldn't reach the recorder",
			description: String(error),
		});
	}
}

/** Rust refused at the key: the notice for it, from this page's lists. */
function refusalOf(target: TargetSnapshot, authorization: TargetAuthorization): RecordDecision {
	if (authorization.decision.action === 'refuse') return authorization.decision;
	// Rust also reads the word lists' blocked apps; name the reason it had.
	return {
		...authorization.decision,
		action: 'refuse',
		tier: 'B',
		// 0.9.11: Rust refuses only apps on the block list.
		reason: 'blocked-app',
		sendContext: false,
	};
}

async function deleteNativeAudio(filePath: string | null | undefined) {
	if (!filePath) return;
	try {
		await removeFile(filePath);
	} catch (error) {
		console.warn('[hotkey] could not delete refused audio', error);
	}
}

async function onNativeStarted(event: NativeOf<'started'>, _context: EventContext) {
	const id = event.recordingId;
	dictationTiming.hotkey(Date.now() - event.atMs);
	const authorization = authorizeTarget(event.target);
	dictationTiming.mark('target');
	if (authorization.decision.action === 'refuse') {
		// Rust's gate let it start; this page's lists refuse it. Stop it and
		// delete its audio; nothing is sent.
		refusedNativeRecordings.add(id);
		dictationTiming.discardOpen();
		void nativeHotkeys
			.discard(id)
			.catch((error) => console.warn('[hotkey] discarding a refused recording failed', error));
		reportRefused(authorization.decision);
		bar.refused(authorization.target, recordNotice(authorization.decision));
		playErrorSound();
		return;
	}
	manualStartRefused = false;
	warmUploadConnection(authorization);
	await settings.switchRecordingMode('manual');
	setNativeRecording(id);
	nativeAuthorizations.set(id, authorization);
	manualRecordingTarget = authorization;
	dictation.start(authorization.target);
	dictationTiming.mark('mic-ready');
	bar.begin({
		recordingId: id,
		purpose: event.purpose ?? 'dictation',
		target: authorization.target,
		snapshot: authorization.profile?.snapshot ?? null,
	});
	announceListening(nanoid(), event.device);
	manualRecordingStartTime = event.atMs;
	console.info('Recording started (hotkey)');
	// Rust played the start sound when the microphone opened (sound.rs),
	// even if this page woke only after the key was released.
}

async function onNativeStopped(event: NativeOf<'stopped'>) {
	const id = event.recordingId;
	if (liveRecordingId() === id) setNativeRecording(null);
	if (refusedNativeRecordings.delete(id)) {
		// Refused here after it had already stopped: its audio goes, unsent.
		await deleteNativeAudio(event.recording.filePath);
		return;
	}
	dictationTiming.mark('stop');
	// No decision for it (the page was reloaded meanwhile): the pipeline
	// treats it as unidentified (no app context; 0.9.11: still transcribed).
	let authorization = nativeAuthorizations.get(id) ?? null;
	nativeAuthorizations.delete(id);
	// 0.9.11: the window in front at Stop, read by Rust at the key. Kept even
	// when this page lost the start (it reloaded): the paste still goes only
	// to that window (Codex review).
	if (authorization) authorization.atStop = event.target ?? null;
	else if (event.target && event.purpose !== 'feedback') {
		const unknown = unresolvedTarget('no snapshot for this recording');
		authorization = { target: unknown, decision: decideAtRecordStart(unknown), atStop: event.target };
	}
	if (authorization && manualRecordingTarget === authorization) {
		manualRecordingTarget = null;
		dictation.clear();
	}
	// The style and expression chosen on the bar are frozen now.
	const overrides = bar.stop(id);
	if (!overrides && event.purpose === 'feedback') {
		// A feedback recording whose bar state is gone (the page reloaded):
		// feedback audio is never kept and never becomes a dictation.
		profilePins.release(authorization?.profile);
		await deleteNativeAudio(event.recording.filePath);
		notify.info.execute({
			title: 'Voice feedback not saved',
			description: 'VoiceLnq restarted while you were recording it.',
		});
		return;
	}
	warmUploadConnection(authorization);

	const toastId = nanoid();
	if (routineToasts()) notify.loading.execute({ id: toastId, title: 'Finishing…', description: '' });
	const filePath = event.recording.filePath;
	const read = filePath ? await FsServiceLive.pathToBlob(filePath) : null;
	if (!read || read.error) {
		const title = "Couldn't stop listening";
		notify.error.execute({
			id: toastId,
			title,
			description: read?.error
				? `Unable to read the recording: ${read.error.message}`
				: 'The recording has no audio file.',
		});
		bar.failed(id, 'start', title, null);
		playErrorSound();
		if (overrides?.purpose === 'feedback') void removeFeedbackAudio(id);
		profilePins.release(authorization?.profile);
		return;
	}
	// Not awaited: transcription and delivery run on their own, so the next
	// recording's events are not held behind them.
	void afterStop({ blob: read.data, recordingId: id, toastId, authorization, overrides, native: true }).catch(
		(error) => console.error('[hotkey] processing a recording failed', error),
	);
}

function onNativeCancelled(event: NativeOf<'cancelled'>) {
	const id = event.recordingId;
	if (liveRecordingId() === id) setNativeRecording(null);
	nativeAuthorizations.delete(id);
	if (refusedNativeRecordings.delete(id) || event.discarded) return;
	afterCancel(id, nanoid(), true);
}

function onNativeRefused(event: NativeOf<'refused'>) {
	const authorization = authorizeTarget(event.target);
	profilePins.release(authorization.profile);
	const decision = refusalOf(event.target, authorization);
	reportRefused(decision);
	bar.refused(event.target, recordNotice(decision));
	playErrorSound();
}

function onNativeFailed(event: NativeOf<'failed'>) {
	if (event.step === 'start') {
		notify.error.execute({ title: "Couldn't start listening", description: event.message });
		bar.startFailed();
		playErrorSound();
		return;
	}
	const title =
		event.step === 'stop' ? "Couldn't stop listening" : "Couldn't cancel the dictation";
	const id = event.recordingId;
	const authorization = id ? (nativeAuthorizations.get(id) ?? null) : null;
	// Refused by this page already (the bar shows it, its error cue played).
	// Kept in the set: if a failed discard leaves it recording, its Stopped
	// must still be dropped unsent.
	const refused = id ? refusedNativeRecordings.has(id) : false;
	if (id) {
		nativeAuthorizations.delete(id);
		if (!refused) bar.failed(id, 'start', title, null);
		if (liveRecordingId() === id) setNativeRecording(null);
	}
	if (authorization && manualRecordingTarget === authorization) {
		manualRecordingTarget = null;
		dictation.clear();
	}
	profilePins.release(authorization?.profile);
	if (!refused) playErrorSound();
	notify.error.execute({ title, description: event.message });
}

/**
 * The recording method is not the Rust recorder (or voice activated
 * recording is on): run the page's command. A start is awaited, so a
 * push-to-talk release that arrived with it is not dropped as "busy";
 * stops are not, so transcription does not hold the next event.
 */
async function onNativeKey(event: NativeOf<'key'>) {
	const { commands: registry } = await import('$lib/commands');
	const commandId = Object.entries(NATIVE_ACTIONS).find(
		([, action]) => action === event.action,
	)?.[0];
	const command = registry.find((c) => c.id === commandId);
	if (!command || !(command.on as readonly string[]).includes(event.state)) return;
	const starts =
		(event.action === 'pushToTalk' && event.state === 'Pressed') || event.action === 'start';
	if (starts) {
		await startManualRecording.execute(undefined);
		return;
	}
	command.callback(event.state);
}

async function handleNativeEvent(event: NativeEvent, context: EventContext) {
	switch (event.kind) {
		case 'started':
			return onNativeStarted(event, context);
		case 'stopped':
			return onNativeStopped(event);
		case 'cancelled':
			return onNativeCancelled(event);
		case 'refused':
			return onNativeRefused(event);
		case 'failed':
			return onNativeFailed(event);
		case 'key':
			return onNativeKey(event);
	}
}

if (typeof window !== 'undefined' && window.__TAURI_INTERNALS__) {
	const handlers = {
		stop: (recordingId: string) => {
			if (liveRecordingId() === recordingId)
				return stopManualRecording.execute(undefined);
		},
		cancel: (recordingId: string) => {
			if (liveRecordingId() === recordingId)
				return commands.cancelManualRecording.execute(undefined);
		},
		// 0.9.12 (F5): "Nothing heard" retries speech-to-text too.
		retry: (recordingId: string, kind: string | null) =>
			kind === 'transcription' || kind === 'empty'
				? recovery.retryTranscription(recordingId)
				: recovery.retryTidyUp(recordingId),
		pasteRaw: (recordingId: string) => recovery.pasteRaw(recordingId),
		// 0.9.11: closing a problem on the bar dismisses it everywhere.
		dismiss: (recordingId: string, kind: string | null) =>
			kind === 'tidy-up' || kind === 'transcription' || kind === 'paste'
				? recovery.dismiss(recordingId)
				: undefined,
		feedback: (recordingId: string) => openFeedbackFor(recordingId),
		// 0.9.13: the tidy-up the language guard held back, to the clipboard.
		useCleaned: (recordingId: string) => recovery.useCleaned(recordingId),
	};
	// Only the main window runs the engine.
	void import('@tauri-apps/api/webviewWindow').then(({ getCurrentWebviewWindow }) => {
		if (getCurrentWebviewWindow().label !== 'main') return;
		initNativeSound();
		void nativeHotkeys
			.init({ handle: handleNativeEvent })
			.catch((error) => console.error('[hotkey] native hotkeys did not start', error));
		void bar.init(handlers);
		// 0.9.13: Use cleaned from a window notice (with the bar off).
		onUseCleaned((recordingId) => recovery.useCleaned(recordingId));
		// VoiceFlow 0.9.12 (F7): 0.9.10's "Empty input" records become Nothing heard, once.
		void cleanUpEmptyInputRecords().catch((error) =>
			console.warn('[history] empty-input clean-up failed', error),
		);
		// VoiceFlow 0.9.9: the built-in styles, added once (never again once handled).
		// 0.9.11: then built-ins nobody edited get the current prompts.
		// 0.9.22: a provisioning file first (its default style must be in place
		// before the seeding decides whether this is a new install).
		void import('$lib/provision/run')
			.then(({ importProvisionFileAtLaunch }) => importProvisionFileAtLaunch())
			.catch((error) => console.warn('[provision] not imported', error))
			.then(() => import('$lib/vf/builtin-styles'))
			.then(async ({ seedBuiltInStylesOnThisPC, refreshBuiltInStylesOnThisPC }) => {
				const result = await seedBuiltInStylesOnThisPC();
				if (result.stopped) console.warn('[styles] built-in styles not added:', result.stopped);
				const refresh = await refreshBuiltInStylesOnThisPC();
				if (refresh.refreshed.length)
					console.info('[styles] refreshed built-in styles:', refresh.refreshed.join(', '));
				if (result.added.length || refresh.refreshed.length) void bar.reloadStyles();
			})
			.catch((error) => console.warn('[styles] built-in styles not added', error));
		// VoiceFlow phase F: feedback rounds run here (History and the feedback window).
		void import('$lib/feedback/service.svelte').then(({ feedbackService }) =>
			feedbackService.init(),
		);
		void import('$lib/bar/session-keys').then(({ syncDictationKeys }) =>
			bar.onListeningChange((listening) => void syncDictationKeys(listening)),
		);
	});
}

/** Set once 0.9.10's "Empty input" records were cleaned up (F7). */
const EMPTY_INPUT_CLEANUP_KEY = 'voiceflow.cleanup.empty-input-0912';

/**
 * 0.9.12 (F7): a dictation 0.9.10 heard nothing in was tidied anyway and
 * failed with "Empty input", so it shows as a problem. It becomes what it
 * is: Nothing heard (no text, no problem). Once per PC; only those records.
 */
async function cleanUpEmptyInputRecords() {
	try {
		if (localStorage.getItem(EMPTY_INPUT_CLEANUP_KEY) === 'done') return;
	} catch {
		// No storage: the clean-up is safe to run again.
	}
	const { data, error } = await services.db.recordings.getAll();
	if (error || !data) return;
	const leftovers = emptyInputLeftovers(data);
	for (const r of leftovers)
		await updateRecordingFields(r.id, {
			result: 'no-text',
			problem: undefined,
			problemKind: undefined,
			problemDismissed: undefined,
		});
	if (leftovers.length) console.info(`[history] ${leftovers.length} empty dictations marked Nothing heard`);
	try {
		localStorage.setItem(EMPTY_INPUT_CLEANUP_KEY, 'done');
	} catch {
		// As above.
	}
}

/** Length of a WAV recording from its header, or undefined for other formats. */
async function audioDurationMs(blob: Blob): Promise<number | undefined> {
	try {
		if (blob.size < 44) return undefined;
		const header = new DataView(await blob.slice(0, 44).arrayBuffer());
		const riff = String.fromCharCode(
			header.getUint8(0),
			header.getUint8(1),
			header.getUint8(2),
			header.getUint8(3),
		);
		if (riff !== 'RIFF') return undefined;
		const byteRate = header.getUint32(28, true);
		if (!byteRate) return undefined;
		return ((blob.size - 44) / byteRate) * 1000;
	} catch {
		return undefined;
	}
}

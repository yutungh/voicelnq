<script lang="ts">
	import { Switch } from '@epicenter/ui/switch';
	import { createMutation, createQuery } from '@tanstack/svelte-query';
	import { listen } from '@tauri-apps/api/event';
	import { commands } from '$lib/commands';
	import { SUPPORTED_LANGUAGES_OPTIONS } from '$lib/constants/languages/supported-languages';
	import { SOURCE_URL } from '$lib/constants/legal';
	import { BLOCKED_APPS } from '$lib/privacy/blocklist';
	import { IS_MACOS, IS_WINDOWS } from '$lib/constants/platform';
	import { desktopRpc, rpc } from '$lib/query';
	import { secretStoreLabel } from '$lib/services/desktop/secrets';
	import { asDeviceIdentifier } from '$lib/services/types';
	import { OPENAI_TRANSCRIPTION_MODELS } from '$lib/services/isomorphic/transcription/cloud/openai';
	import { getSelectedTranscriptionService } from '$lib/settings/transcription-validation';
	import { settings } from '$lib/stores/settings.svelte';
	import { THEME_OPTIONS, theme, type ThemeChoice } from '$lib/theme.svelte';
	import Icon from '$lib/vf/Icon.svelte';
	import StylePicker from '$lib/vf/StylePicker.svelte';
	import Tile from '$lib/vf/Tile.svelte';
	import KeyRow from '$lib/vf/settings/KeyRow.svelte';
	import MicMeter from '$lib/vf/settings/MicMeter.svelte';
	import SoundsCard from '$lib/vf/settings/SoundsCard.svelte';
	import SpeedCard from '$lib/vf/settings/SpeedCard.svelte';
	import WordListsCard from '$lib/vf/settings/WordListsCard.svelte';
	import AppStylesCard from '$lib/vf/settings/AppStylesCard.svelte';
	// VoiceFlow phase F: Settings > Feedback.
	import FeedbackCard from '$lib/vf/settings/FeedbackCard.svelte';
	import { modelOf, styleShape } from '$lib/vf/styles';
	import { profileStyleKey } from '$lib/profile/ownership';
	import { wordLists } from '$lib/profile/service.svelte';
	import { bar } from '$lib/bar/controller';
	import {
		KEEP_AUDIO_LABELS,
		KEEP_AUDIO_OPTIONS,
		type KeepAudio,
	} from '$lib/vf/audio-retention';

	/**
	 * VoiceFlow B3.1 Settings: one page of sections, saved as they change,
	 * with no notice for each change. Upstream's recording methods, FFmpeg,
	 * voice activation and provider pages are gone from view.
	 */

	const command = (id: string) => {
		const found = commands.find((c) => c.id === id);
		if (!found) throw new Error(`Unknown command ${id}`);
		return found;
	};
	const KEY_ROWS = [
		{ id: 'toggleManualRecording', label: 'Start or stop dictation', help: 'Press once to start, again to paste' },
		{ id: 'pushToTalk', label: 'Hold to talk', help: 'Hold while you talk, let go to paste' },
		{ id: 'cancelManualRecording', label: 'Cancel dictation', help: 'Stops without sending anything' },
		{ id: 'openTransformationPicker', label: 'Pick a style for one dictation', help: 'While dictating: next style on the bar' },
		{ id: 'runTransformationOnClipboard', label: 'Tidy up the clipboard', help: 'Uses your default style' },
		// VoiceFlow 0.9.23.
		{ id: 'pasteLastTranscription', label: 'Paste last transcription', help: 'Pastes your latest dictation where your cursor is' },
		// VoiceFlow A2: the recording bar's keys.
		{ id: 'expressionUp', label: 'More expressive', help: 'While dictating; for this dictation only' },
		{ id: 'expressionDown', label: 'Less expressive', help: 'While dictating; for this dictation only' },
		{ id: 'startFeedbackRecording', label: 'Give feedback by voice', help: 'About your last dictation; press again to finish' },
	];
	// 0.9.12: "Show on" picks the monitor; Position the edge, Alignment the
	// side. Both are kept in one setting, `bar.position` ("top-center"...).
	const BAR_MONITORS = [
		{ value: 'primary', label: 'Main monitor' },
		{ value: 'mouse', label: 'The monitor your mouse is on' },
		{ value: 'target', label: "The monitor of the app you're typing in" },
	] as const;
	const BAR_EDGES = [
		{ value: 'bottom', label: 'Bottom' },
		{ value: 'top', label: 'Top' },
	] as const;
	const BAR_SIDES = [
		{ value: 'center', label: 'Centre' },
		{ value: 'left', label: 'Left' },
		{ value: 'right', label: 'Right' },
	] as const;
	type BarPositionValue = (typeof settings.value)['bar.position'];
	const barEdge = $derived(settings.value['bar.position'].startsWith('top') ? 'top' : 'bottom');
	const barSide = $derived(settings.value['bar.position'].split('-')[1] ?? 'center');
	function setBarPlace(edge: string, side: string) {
		settings.updateKey('bar.position', `${edge}-${side}` as BarPositionValue);
	}

	// ---- microphone -----------------------------------------------------------
	const devicesQuery = createQuery(() => rpc.recorder.enumerateDevices.options);
	const method = $derived(settings.value['recording.method']);
	const deviceKey = $derived(`recording.${method}.deviceId` as const);
	let testing = $state(false);
	let heard = $state(false);
	let micError = $state<string | null>(null);
	let testTimer: ReturnType<typeof setTimeout> | undefined;
	function testMic() {
		micError = null;
		heard = false;
		testing = true;
		clearTimeout(testTimer);
		testTimer = setTimeout(() => (testing = false), 8000);
	}

	// ---- transcription ----------------------------------------------------------
	const service = $derived(getSelectedTranscriptionService());
	const isOpenAI = $derived(service?.id === 'OpenAI');
	const hasKey = $derived(!!settings.value['apiKeys.openai']);
	const storeLabel = $derived(
		settings.apiKeyStoreKind === 'loading' ? 'the credential store' : secretStoreLabel(settings.apiKeyStoreKind),
	);
	let replacingKey = $state(false);
	let newKey = $state('');
	let keySaved = $state(false);
	function saveKey(e: SubmitEvent) {
		e.preventDefault();
		if (!newKey.trim()) return;
		settings.updateKey('apiKeys.openai', newKey.trim());
		newKey = '';
		replacingKey = false;
		keySaved = true;
		setTimeout(() => (keySaved = false), 2500);
	}

	// ---- tidy-up ------------------------------------------------------------------
	const stylesQuery = createQuery(() => rpc.db.transformations.getAll.options);
	const defaultStyle = $derived(
		(stylesQuery.data ?? []).find(
			(s) => s.id === settings.value['transformations.selectedTransformationId'],
		),
	);
	/** A style from the word lists (`profile:<id>`), when that is the default. */
	const profileStyle = $derived(
		wordLists.snapshot?.styles.find(
			(s) =>
				profileStyleKey(s.id) ===
				settings.value['transformations.selectedTransformationId'],
		),
	);
	const defaultStyleLabel = $derived(
		profileStyle?.label ?? defaultStyle?.title ?? 'Raw',
	);
	const defaultModel = $derived.by(() => {
		if (profileStyle)
			return (
				profileStyle.model ?? wordLists.snapshot?.defaults.cleanupModel ?? null
			);
		if (!defaultStyle) return null;
		const shape = styleShape(defaultStyle);
		return shape.kind === 'simple' ? modelOf(shape.prompt) : null;
	});

	// ---- history and audio -------------------------------------------------------
	// One control: how long audio is kept. Dictations themselves stay.
	const keepAudio = $derived(settings.value['history.keepAudio']);

	const versionPromise = (async () => {
		if (!window.__TAURI_INTERNALS__) return null;
		const { getVersion } = await import('@tauri-apps/api/app');
		return await getVersion();
	})();

	const THEME_ICONS = { system: 'monitor', light: 'sun', dark: 'moon' } as const;

	// ---- startup (plan v2, A1) ----------------------------------------------------
	const isDesktop = !!window.__TAURI_INTERNALS__;
	const autostartQuery = createQuery(() => ({
		...desktopRpc.autostart.isEnabled.options,
		enabled: isDesktop,
	}));
	const enableAutostartMutation = createMutation(
		() => desktopRpc.autostart.enable.options,
	);
	const disableAutostartMutation = createMutation(
		() => desktopRpc.autostart.disable.options,
	);
	/** The login item's name on each OS; it starts VoiceFlow hidden, in the tray. */
	// VoiceFlow 0.9.22: where the app waits, in each system's words.
	const trayName = IS_MACOS ? 'menu bar' : 'tray';
	let importing = $state(false);
	async function importSettingsFile() {
		importing = true;
		try {
			const { importProvisionFileByHand } = await import('$lib/provision/run');
			await importProvisionFileByHand();
		} catch (error) {
			rpc.notify.error.execute({
				title: "Couldn't import the settings file",
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			importing = false;
		}
	}
	const autostartLabel = IS_WINDOWS
		? 'Start with Windows'
		: IS_MACOS
			? 'Open at login'
			: 'Start at login';
	function setAutostart(checked: boolean) {
		const mutation = checked ? enableAutostartMutation : disableAutostartMutation;
		mutation.mutate(undefined, {
			onError: (error) => rpc.notify.error.execute(error),
		});
	}
	// The same switch is in the tray menu; refresh when it is used there.
	$effect(() => {
		if (!isDesktop) return;
		const unlisten = listen('autostart://changed', () => {
			void autostartQuery.refetch();
		});
		return () => {
			void unlisten.then((stop) => stop());
		};
	});
</script>

<svelte:head>
	<title>Settings - VoiceLnq</title>
</svelte:head>

{#snippet toggle(label: string, help: string, checked: boolean, set: (v: boolean) => void)}
	<div class="srow">
		<div><b>{label}</b>{#if help}<span>{help}</span>{/if}</div>
		<Switch {checked} onCheckedChange={set} aria-label={label} />
	</div>
{/snippet}

<div class="vf page">
	<header class="ph">
		<div>
			<h1>Settings</h1>
			<p>These apply to this PC and save as you change them</p>
		</div>
	</header>

	<div class="setg">
		<div class="col">
			<section class="card sp" id="keys" aria-labelledby="h-keys">
				<div class="c-h"><Tile icon="keyboard" /><h2 id="h-keys">Dictation keys</h2></div>
				{#each KEY_ROWS as row (row.id)}
					<KeyRow command={command(row.id)} label={row.label} help={row.help} />
				{/each}
			</section>

			<section class="card sp" id="bar" aria-labelledby="h-bar">
				<div class="c-h"><Tile icon="waveform" /><h2 id="h-bar">Recording bar</h2></div>
				{@render toggle('Show the recording bar', 'Above every app while you dictate; it never takes your keyboard', settings.value['bar.show'], (v) => { settings.updateKey('bar.show', v); bar.refresh(); })}
				<div class="srow">
					<div><b>Show on</b><span>Chosen when you start dictating; it stays there until it hides</span></div>
					<select
						class="sel"
						aria-label="Monitor the recording bar shows on"
						disabled={!settings.value['bar.show']}
						value={settings.value['bar.monitor']}
						onchange={(e) =>
							settings.updateKey(
								'bar.monitor',
								e.currentTarget.value as (typeof BAR_MONITORS)[number]['value'],
							)}
					>
						{#each BAR_MONITORS as m (m.value)}<option value={m.value}>{m.label}</option>{/each}
					</select>
				</div>
				<div class="srow">
					<div><b>Position</b><span>Bottom or top of the screen, clear of the taskbar</span></div>
					<select
						class="sel"
						aria-label="Recording bar position"
						disabled={!settings.value['bar.show']}
						value={barEdge}
						onchange={(e) => setBarPlace(e.currentTarget.value, barSide)}
					>
						{#each BAR_EDGES as p (p.value)}<option value={p.value}>{p.label}</option>{/each}
					</select>
				</div>
				<div class="srow">
					<div><b>Alignment</b><span>Where along that edge</span></div>
					<select
						class="sel"
						aria-label="Recording bar alignment"
						disabled={!settings.value['bar.show']}
						value={barSide}
						onchange={(e) => setBarPlace(barEdge, e.currentTarget.value)}
					>
						{#each BAR_SIDES as p (p.value)}<option value={p.value}>{p.label}</option>{/each}
					</select>
				</div>
			</section>

			<section class="card sp" id="microphone" aria-labelledby="h-mic">
				<div class="c-h"><Tile icon="microphone" /><h2 id="h-mic">Microphone</h2></div>
				<div class="srow">
					<div>
						<b>Input</b>
						{#if micError}
							<span class="err">{micError}</span>
						{:else if heard}
							<span class="okline"><Icon name="check-circle" weight="fill" class="i sm" />Sounds good</span>
						{:else}
							<span>{testing ? 'Say something: the bars move when VoiceLnq hears you' : 'Test it to see the bars move'}</span>
						{/if}
					</div>
					<select
						class="sel"
						aria-label="Microphone"
						value={settings.value[deviceKey] ?? ''}
						onchange={(e) =>
							settings.updateKey(
								deviceKey,
								e.currentTarget.value ? asDeviceIdentifier(e.currentTarget.value) : null,
							)}
					>
						<option value="">{IS_WINDOWS ? 'Windows default' : 'System default'}</option>
						{#each devicesQuery.data ?? [] as device (device.id)}
							<option value={device.id}>{device.label}</option>
						{/each}
					</select>
				</div>
				<div class="srow">
					<div><b>Level</b><span>Only listens while you test</span></div>
					<MicMeter active={testing} onHeard={() => (heard = true)} onError={(m) => ((micError = m), (testing = false))} />
					<button class="btn sec" type="button" onclick={testMic} disabled={testing}>{testing ? 'Listening…' : 'Test'}</button>
				</div>
			</section>

			<section class="card sp" id="transcription" aria-labelledby="h-tr">
				<div class="c-h"><Tile icon="waveform" /><h2 id="h-tr">Transcription</h2></div>
				{#if !isOpenAI}
					<div class="srow">
						<div><b>Service</b><span>{service?.name ?? 'None chosen'}</span></div>
						<button class="btn sec" type="button" onclick={() => settings.updateKey('transcription.selectedTranscriptionService', 'OpenAI')}>Use OpenAI</button>
					</div>
				{/if}
				{#if isOpenAI && settings.isProfileOwned('transcription.openai.model')}
					<div class="srow">
						<div><b>Model</b><span>Set in your word lists</span></div>
						<span class="sub">{settings.value['transcription.openai.model']}</span>
					</div>
				{:else if isOpenAI}
					<div class="srow">
						<div><b>Model</b><span>Turns your speech into text</span></div>
						<select
							class="sel"
							aria-label="Transcription model"
							value={settings.value['transcription.openai.model']}
							onchange={(e) => settings.updateKey('transcription.openai.model', e.currentTarget.value)}
						>
							{#each OPENAI_TRANSCRIPTION_MODELS as m (m.name)}<option value={m.name}>{m.name}</option>{/each}
						</select>
					</div>
				{/if}
				<div class="srow">
					<div><b>Language</b><span>{settings.isProfileOwned('transcription.outputLanguage') ? 'Set in your word lists' : 'The language you speak'}</span></div>
					<select
						disabled={settings.isProfileOwned('transcription.outputLanguage')}
						class="sel"
						aria-label="Language"
						value={settings.value['transcription.outputLanguage']}
						onchange={(e) => settings.updateKey('transcription.outputLanguage', e.currentTarget.value as typeof settings.value['transcription.outputLanguage'])}
					>
						{#each SUPPORTED_LANGUAGES_OPTIONS as lang (lang.value)}<option value={lang.value}>{lang.label}</option>{/each}
					</select>
				</div>
				<div class="srow">
					<div><b>OpenAI key</b><span>Stored in {storeLabel}</span></div>
					{#if keySaved}
						<span class="chip ok"><Icon name="check-circle" weight="fill" class="i xs" />Saved</span>
					{:else if hasKey}
						<span class="chip ok"><Icon name="check-circle" weight="fill" class="i xs" />Saved</span>
					{:else}
						<span class="chip bad"><Icon name="warning-circle" weight="fill" class="i xs" />Missing</span>
					{/if}
					<button class="btn text" type="button" onclick={() => (replacingKey = !replacingKey)}>{hasKey ? 'Replace' : 'Add'}</button>
				</div>
				{#if replacingKey}
					<form class="keyform" onsubmit={saveKey}>
						<input class="inp" type="password" bind:value={newKey} placeholder="sk-…" aria-label="OpenAI key" autocomplete="off" />
						<button class="btn pri" type="submit">Save key</button>
					</form>
				{/if}
			</section>

			<section class="card sp" id="tidy-up" aria-labelledby="h-tidy">
				<div class="c-h"><Tile icon="magic-wand" /><h2 id="h-tidy">Tidy-up</h2></div>
				<div class="srow">
					<div><b>Default style</b><span>{settings.isProfileOwned('transformations.selectedTransformationId') ? 'Set in your word lists' : 'Used for new dictations'}</span></div>
					<StylePicker label={defaultStyleLabel} triggerClass="btn sec drop sel-like" />
				</div>
				<div class="srow">
					<div><b>Model</b><span>{profileStyle || defaultStyle ? `Set in the ${defaultStyleLabel} style` : 'Raw uses no model'}</span></div>
					<span class="sub">{defaultModel ?? '—'}</span>
					<a class="btn text" href="/styles">Styles</a>
				</div>
				<div class="srow">
					<div><b>Time limit</b><span>Longer than this, nothing is pasted and you can retry</span></div>
					<span class="sub num">10 seconds</span>
				</div>
				<!-- VoiceFlow 0.9.21: the style each app starts in. -->
				<AppStylesCard defaultLabel={defaultStyleLabel} />
			</section>

			<!-- VoiceFlow: Speed (desktop/speed branch). -->
			<section class="card sp" id="speed" aria-labelledby="h-speed" data-slot="speed">
				<div class="c-h"><Tile icon="lightning" /><h2 id="h-speed">Speed</h2></div>
				<SpeedCard />
			</section>
		</div>

		<div class="col">
			<!-- VoiceFlow B + C2: word lists (household + personal profiles). -->
			<section class="card sp" id="word-lists" aria-labelledby="h-words">
				<div class="c-h"><Tile icon="book-open-text" /><h2 id="h-words">Word lists</h2></div>
				<WordListsCard />
			</section>

			<section class="card sp" id="privacy" aria-labelledby="h-privacy">
				<div class="c-h"><Tile icon="shield-check" /><h2 id="h-privacy">Privacy</h2></div>
				<!-- VoiceFlow 0.9.11: start anywhere. The Strict / Best effort choice is
				     gone: it no longer changes anything. -->
				<div class="srow">
					<div>
						<b>Start anywhere</b>
						<span>VoiceLnq records wherever you are, except in a password manager. Your words are pasted where your cursor is when they are ready. When they are not pasted (the desktop, the taskbar, a password box, an app run as administrator, or anything else) they are copied, so Ctrl+V always works.</span>
					</div>
				</div>
				<details class="ldet">
					<summary>Apps VoiceLnq never types into ({BLOCKED_APPS.length})</summary>
					<p class="sub">Password managers, authenticators and sign-in prompts. This list can't be changed yet.</p>
					<ul class="blocked">
						{#each BLOCKED_APPS as app (app.name)}<li>{app.name}</li>{/each}
					</ul>
				</details>
			</section>

			<section class="card sp" id="appearance" aria-labelledby="h-look">
				<div class="c-h"><Tile icon="sun" /><h2 id="h-look">Appearance</h2></div>
				<div class="srow">
					<div><b>Theme</b><span>System follows {IS_MACOS ? 'macOS' : IS_WINDOWS ? 'Windows' : 'the system'}</span></div>
					<span class="seg" role="radiogroup" aria-label="Theme">
						{#each THEME_OPTIONS as option (option.value)}
							<button
								type="button"
								role="radio"
								aria-checked={theme.choice === option.value}
								class:on={theme.choice === option.value}
								onclick={() => theme.set(option.value as ThemeChoice)}
							>
								<Icon name={THEME_ICONS[option.value as ThemeChoice]} weight={theme.choice === option.value ? 'fill' : 'regular'} class="i sm" /><span>{option.label}</span>
							</button>
						{/each}
					</span>
				</div>
			</section>

			<section class="card sp" id="history" aria-labelledby="h-hist">
				<div class="c-h"><Tile icon="clock-counter-clockwise" /><h2 id="h-hist">History and audio</h2></div>
				<div class="srow">
					<div><b>Keep recordings</b><span>The audio, for replay and retry. The text always stays.</span></div>
					<select
						class="sel"
						aria-label="Keep recordings"
						value={keepAudio}
						onchange={(e) => settings.updateKey('history.keepAudio', e.currentTarget.value as KeepAudio)}
					>
						{#each KEEP_AUDIO_OPTIONS as o (o)}<option value={o}>{KEEP_AUDIO_LABELS[o]}</option>{/each}
					</select>
				</div>
				<p class="sub small">
					{keepAudio === 'off'
						? 'Audio is removed as soon as your words are text.'
						: keepAudio === 'forever'
							? 'Audio is never removed.'
							: `Audio older than ${KEEP_AUDIO_LABELS[keepAudio]} is removed once a day.`}
					Audio a dictation still needs (held, or not turned into text yet) is kept up to 30 days.
					Deleted dictations stay in Recently deleted for 30 days.
				</p>
			</section>

			<section class="card sp" id="pasting" aria-labelledby="h-paste">
				<div class="c-h"><Tile icon="cursor-text" /><h2 id="h-paste">Pasting</h2></div>
				{@render toggle('Paste into the app', 'Where your cursor is when the words are ready. When there is nowhere to paste, they are copied to the clipboard instead.', settings.value['transformation.writeToCursorOnSuccess'], (v) => settings.update({ 'transformation.writeToCursorOnSuccess': v, 'transcription.writeToCursorOnSuccess': v }))}
				<!-- VoiceFlow 0.9.23: put the clipboard back after a paste. -->
				{@render toggle('Keep my clipboard after pasting', 'When your words are pasted into a text field, what you had copied comes back. When VoiceLnq is not sure the paste landed, your words stay on the clipboard.', settings.value['paste.keepClipboard'], (v) => settings.updateKey('paste.keepClipboard', v))}
				{@render toggle('Press Enter after pasting', 'Sends chat messages straight away', settings.value['transformation.simulateEnterAfterOutput'], (v) => settings.update({ 'transformation.simulateEnterAfterOutput': v, 'transcription.simulateEnterAfterOutput': v }))}
			</section>

			<!-- VoiceFlow: the app's own sounds (three sets, previews, volume). -->
			<SoundsCard />

			<!-- VoiceFlow phase F: feedback model, retention, delete all. -->
			<FeedbackCard />

			<!-- VoiceFlow: Start with Windows (desktop/v2, phase A1). -->
			<section class="card sp" id="startup" aria-labelledby="h-start" data-slot="start-with-windows">
				<div class="c-h"><Tile icon="power" /><h2 id="h-start">Startup</h2></div>
				{#if isDesktop}
					<div class="srow">
						<div><b>{autostartLabel}</b><span>Starts in the {trayName} when you sign in, ready for your keys. Closing the window keeps it in the {trayName}.</span></div>
						<Switch
							checked={autostartQuery.data ?? false}
							onCheckedChange={setAutostart}
							aria-label={autostartLabel}
							disabled={autostartQuery.isPending ||
								enableAutostartMutation.isPending ||
								disableAutostartMutation.isPending}
						/>
					</div>
				{:else}
					<p class="sub">Starting with Windows is set in the desktop app.</p>
				{/if}
				<!-- VoiceFlow 0.9.22: a provisioning file prepared for this person. -->
				{#if isDesktop}
					<div class="srow">
						<div><b>Import settings file</b><span>Fills in your API key and settings from a file prepared for you. Delete the file afterwards.</span></div>
						<button class="btn sec" type="button" onclick={importSettingsFile} disabled={importing}>{importing ? 'Importing…' : 'Import…'}</button>
					</div>
				{/if}
			</section>

			<section class="about" id="about" aria-label="About">
				<p>
					{#await versionPromise then version}VoiceLnq {version ?? ''}.{/await}
					Based on Whispering by Braden Wong. AGPL-3.0. Icons: Phosphor (MIT). Sounds: VoiceLnq (CC0).
					<a class="lk" href="/settings/about/license">Licence</a>
					<a class="lk" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">Source code</a>
				</p>
			</section>
		</div>
	</div>
</div>

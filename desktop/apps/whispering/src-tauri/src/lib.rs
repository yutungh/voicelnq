use tauri_plugin_log::{Target, TargetKind};

pub mod recorder;
use recorder::commands::{
    cancel_recording, close_recording_session, enumerate_recording_devices,
    get_current_recording_id, init_recording_session, start_recording, stop_recording, AppData,
};

pub mod transcription;
use transcription::{
    transcribe_audio_moonshine, transcribe_audio_parakeet, transcribe_audio_whisper, ModelManager,
};

pub mod windows_path;
use windows_path::fix_windows_path;

pub mod graceful_shutdown;
use graceful_shutdown::send_sigint;

pub mod command;
use command::{execute_command, spawn_command};

pub mod markdown_reader;
use markdown_reader::{bulk_delete_files, count_markdown_files, read_markdown_files};

pub mod secrets;
use secrets::{secret_get, secret_set, secret_store_kind};

pub mod context;
use context::{capture_target, focus_target};

// VoiceFlow 0.9.23: the person's clipboard comes back after a paste.
pub mod clipboard_keep;

// VoiceFlow: close to tray, the native tray menu, start hidden at login (plan v2, A1).
pub mod lifecycle;
pub mod tray;
use tray::{autostart_is_enabled, autostart_set, tray_set_recording, tray_set_theme};
// VoiceFlow (A0): 16 kHz mono recordings and FLAC uploads, no FFmpeg needed.
pub mod speech_audio;
use speech_audio::prepare_upload_audio;
// VoiceFlow (speed): one pooled, pre-warmed connection to the OpenAI API.
pub mod openai_http;
use openai_http::{openai_fetch, openai_warm};
// VoiceFlow C1: icons of the apps dictated into (Home, History).
pub mod app_icon;
use app_icon::app_icon;
// VoiceFlow B + C2: word lists (household + personal profiles) on a shared folder.
pub mod profile;
use profile::{
    profile_edits_changed, profile_gateway_set_token, profile_github_set_token, profile_github_test, profile_list_users, profile_refresh,
    profile_set_busy, profile_set_config,
    profile_state, github_connect_cancel, github_connect_start, github_connect_status, github_links, github_list_repos,
};
// VoiceFlow A2: the floating recording bar and the voice feedback window.
pub mod bar;
// VoiceFlow: dictation hotkeys handled natively, and webviews kept awake
// (plan v2, A-gate).
pub mod dev_hooks;
pub mod hotkey;
// VoiceFlow: the app's own sounds, played natively.
pub mod sound;
pub mod webview_args;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[tokio::main]
pub async fn run() {
    // Set up panic hook to capture crash information before the app exits.
    // The previous hook is preserved so default panic reporting still occurs.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        use std::backtrace::Backtrace;
        let payload = panic_info.payload();
        let location = panic_info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        let thread_name = std::thread::current()
            .name()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "unnamed thread".to_string());

        let message = if let Some(s) = payload.downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "Unknown panic payload".to_string()
        };

        let backtrace = Backtrace::force_capture();

        eprintln!(
            "[panic] thread={} location={} message={}",
            thread_name, location, message
        );
        eprintln!("{}", backtrace);

        // Write crash log to temp directory (works on all platforms)
        {
            use std::fs::OpenOptions;
            use std::io::Write;
            let crash_log_path = std::env::temp_dir().join("voiceflow-crash.log");
            if let Ok(mut file) = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&crash_log_path)
            {
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let _ = writeln!(
                    file,
                    "[{}] thread={} location={} message={}",
                    timestamp, thread_name, location, message
                );
                let _ = writeln!(file, "{}", backtrace);
                let _ = writeln!(file, "-----");
            }
        }

        previous_hook(panic_info);
    }));

    // Fix PATH environment for GUI applications on macOS and Linux
    // This ensures commands like ffmpeg installed via Homebrew are accessible
    let _ = fix_path_env::fix();

    // Fix Windows PATH inheritance bug
    // This ensures child processes can find ffmpeg on Windows
    fix_windows_path();

    // VoiceFlow 0.9.11: `targets` replaces the plugin's default targets
    // (Stdout, and LogDir named after the app, "VoiceFlow.log"). `.target()`
    // added to them, so on Windows' case-insensitive disk "voiceflow.log" and
    // "VoiceFlow.log" were one file written twice: every line appeared twice.
    let log_plugin = tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .level_for("voiceflow::transcription", log::LevelFilter::Debug)
        // VoiceFlow 0.9.11: tao's routine window warnings are noise in the log.
        .level_for("tao", log::LevelFilter::Error)
        .targets(log_targets())
        .build();

    let context = tauri::generate_context!();
    let mut builder = tauri::Builder::default();

    // Single instance must be the first plugin registered. A second launch
    // shows the running window, unless it is the login item (`--hidden`).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !lifecycle::launched_hidden(&args) {
                lifecycle::show_main(app);
            }
        }));
    }

    builder = builder.plugin(log_plugin);
    // VoiceFlow: test settings for a development build only (dev_hooks.rs).
    builder = builder.plugin(dev_hooks::plugin(&context.config().identifier));

    // VoiceFlow: upstream's Aptabase analytics plugin and auto-updater plugin are removed.
    builder = builder
        .plugin(tauri_plugin_macos_permissions::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppData::new())
        .manage(ModelManager::new())
        .manage(tray::TrayReport::default())
        .manage(profile::ProfileService::default())
        .manage(bar::BarState::default())
        .manage(hotkey::NativeHotkeys::default());

    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec![lifecycle::HIDDEN_ARG]),
            ))
            // Closing the main window hides it; Quit is in the tray menu.
            .on_window_event(lifecycle::on_window_event)
            .setup(|app| {
                let handle = app.handle();
                // VoiceFlow: the main window is built here (tauri.conf.json has
                // `create: false`) so it gets the keep-awake WebView2 switches.
                lifecycle::create_main(handle)?;
                tray::create(handle)?;
                // VoiceFlow A2: the recording bar exists from the start, hidden,
                // so it shows instantly. A failure here leaves dictation working.
                if let Err(e) = bar::create(handle) {
                    log::warn!("[bar] could not create the recording bar: {e}");
                }
                tray::refresh_autostart_args(handle);
                // VoiceFlow: the dictation hotkeys' worker and watchdog. The keys
                // themselves are registered when the webview sends its settings.
                hotkey::start(handle);
                // Word lists: from the cache at once, then from the share.
                profile::start(handle);
                // The main window is created hidden (tauri.conf.json) so a
                // login start never flashes it.
                if !lifecycle::launched_hidden(std::env::args()) {
                    lifecycle::show_main(handle);
                }
                Ok(())
            });
    }

    // Register command handlers (same for all platforms now)
    let builder = builder.invoke_handler(tauri::generate_handler![
        write_text,
        simulate_enter_keystroke,
        // Audio recorder commands
        get_current_recording_id,
        enumerate_recording_devices,
        init_recording_session,
        close_recording_session,
        start_recording,
        stop_recording,
        cancel_recording,
        transcribe_audio_whisper,
        transcribe_audio_parakeet,
        transcribe_audio_moonshine,
        send_sigint,
        // Command execution (prevents console window flash on Windows)
        execute_command,
        spawn_command,
        // Filesystem utilities
        read_markdown_files,
        count_markdown_files,
        bulk_delete_files,
        // VoiceFlow: API keys in the OS credential store
        secret_store_kind,
        secret_get,
        secret_set,
        // VoiceFlow: the app being dictated into (spec §4.1, §4.3)
        capture_target,
        focus_target,
        // VoiceFlow: tray and login item (plan v2, A1)
        tray_set_recording,
        tray_set_theme,
        autostart_is_enabled,
        autostart_set,
        // VoiceFlow: the file(s) to upload for a recording
        prepare_upload_audio,
        // VoiceFlow: pooled OpenAI connection (speed)
        openai_warm,
        openai_fetch,
        // VoiceFlow C1: app icons for Home and History
        app_icon,
        // VoiceFlow B + C2: word lists
        profile_state,
        profile_set_config,
        profile_refresh,
        profile_edits_changed,
        profile_set_busy,
        profile_list_users,
        // 0.9.19: word lists in a private GitHub repository
        profile_github_set_token,
        profile_gateway_set_token,
        profile_github_test,
        // 0.9.20: Connect GitHub (the VoiceFlow GitHub App, device flow)
        github_connect_start,
        github_connect_status,
        github_connect_cancel,
        github_list_repos,
        github_links,
        // VoiceFlow A2: the recording bar and the feedback window
        bar::bar_target,
        bar::bar_present,
        bar::bar_hide,
        bar::bar_hit_rects,
        bar::bar_pointer_down,
        bar::bar_restore_focus,
        bar::feedback_window_open,
        bar::feedback_payload_take,
        bar::transform_window_create,
        // VoiceFlow: native dictation hotkeys
        hotkey::runtime::hotkey_configure,
        hotkey::runtime::hotkey_trigger,
        hotkey::runtime::hotkey_discard,
        hotkey::runtime::hotkey_ack,
        hotkey::runtime::hotkey_pending,
        // VoiceFlow: the app's sounds
        sound::sound_configure,
        sound::sound_play,
    ]);

    let app = builder
        .build(context)
        .expect("error while building tauri application");

    app.run(|_app, _event| {
        // macOS: clicking the Dock icon brings the hidden window back.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            lifecycle::show_main(_app);
        }
    });
}

/// The log's targets: the console and one file, `VoiceFlow.log` in the app's
/// log folder. Exactly one file target, so each line is written once.
fn log_targets() -> Vec<Target> {
    vec![
        Target::new(TargetKind::Stdout),
        Target::new(TargetKind::LogDir {
            file_name: Some("VoiceFlow".to_string()),
        }),
    ]
}

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use tauri_plugin_clipboard_manager::ClipboardExt;

/// One delivery at a time: two dictations finishing together must not swap
/// each other's clipboard text between the write and the keystroke.
/// VoiceFlow 0.9.23: a delivery whose clipboard is put back keeps the lock
/// until then, so the next one saves the person's clipboard, not this text.
static PASTE_LOCK: std::sync::LazyLock<std::sync::Arc<tokio::sync::Mutex<()>>> =
    std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Mutex::new(())));

/** How long a delivery keeps the lock after the paste keys (the app reads the clipboard). */
const PASTE_SETTLE_MS: u64 = 150;

/// Puts the text on the clipboard and, with a `binding`, pastes it.
///
/// VoiceFlow 0.9.11: when nothing is pasted (a refusal, keys that couldn't
/// be sent), the text stays on the clipboard so the person can press Ctrl+V.
///
/// VoiceFlow 0.9.23, `restore` (Settings: Keep my clipboard after pasting,
/// for a paste the rule is confident about): the clipboard is saved first
/// (`clipboard_keep`), the text goes on it marked as transient, and after
/// the paste the saved clipboard is put back in the background, once the app
/// has had time to read the text and only if nothing else wrote the
/// clipboard since. `if-editable` is put back only if the field check right
/// before the keystroke still says the field takes text. This never changes
/// the result: a restore that can't happen leaves the text on the clipboard.
/// Without `restore` (an unsure paste, or the setting off), or when the
/// clipboard can't be saved faithfully, the text stays on the clipboard
/// after a paste, as in 0.9.11.
///
/// 0.9.23: the paste keys wait (up to `MODIFIERS_WAIT`) for the person's own
/// Ctrl, Alt, Shift and Win/Cmd keys to come up: "Paste last transcription"
/// is itself a shortcut, and Ctrl+V sent while Alt is still held is
/// Ctrl+Alt+V, which pastes nothing.
///
/// With a `binding` (the window the paste was authorized for), the app in
/// front and its focused field are checked again right before the keystroke;
/// if the window changed or the field is a password field, no key is sent and
/// the reason is returned (the text is still on the clipboard). Without a
/// binding, the text is only copied.
///
/// Never fails after the clipboard write: the result says what happened.
#[tauri::command]
async fn write_text(
    app: tauri::AppHandle,
    text: String,
    binding: Option<context::PasteBinding>,
    shortcut: Option<PasteShortcut>,
    restore: Option<clipboard_keep::RestoreWhen>,
) -> Result<PasteResult, String> {
    let one_at_a_time = PASTE_LOCK.clone().lock_owned().await;

    // 0.9.23: the person's own modifier keys come up before anything else
    // ("Paste last transcription" is itself a shortcut). Still held: no
    // paste, the text is only copied.
    let modifiers_up = match binding {
        Some(_) => tokio::task::spawn_blocking(|| wait_for_modifiers_up(MODIFIERS_WAIT))
            .await
            .unwrap_or(false),
        None => true,
    };

    // 0.9.23: save the clipboard, and write the text marked as transient,
    // only when a confident paste will be tried and the clipboard can be put back.
    let mut kept: Option<(clipboard_keep::Saved, Option<u64>)> = None;
    if restore.is_some() && binding.is_some() && modifiers_up {
        let transcript = text.clone();
        kept = tokio::task::spawn_blocking(move || {
            match clipboard_keep::snapshot() {
                clipboard_keep::Snapshot::Saved(saved) => {
                    match clipboard_keep::write_transient(&transcript) {
                        Ok(seq) => {
                            log::info!("[paste] clipboard saved ({} formats, {} bytes)", saved.formats, saved.bytes);
                            Some((saved, seq))
                        }
                        Err(e) => {
                            log::warn!("[paste] transient write failed ({e}); writing as before");
                            None
                        }
                    }
                }
                other => {
                    log::info!("[paste] clipboard {}; the text will stay on it", other.describe());
                    None
                }
            }
        })
        .await
        .unwrap_or(None);
    }

    if kept.is_none() {
        if let Err(e) = app.clipboard().write_text(&text) {
            log::warn!("[paste] could not write the clipboard: {e}");
            return Ok(PasteResult::failed(false, format!("Couldn't use the clipboard: {e}")));
        }
    }
    // 0.9.23: for a paste whose clipboard comes back, what the clipboard
    // must still be at the keystroke. (Not for the plain write: a clipboard
    // tool that rewrites every copy would then stop every paste.)
    let written = kept.as_ref().and_then(|(_, seq)| *seq);

    // No fixed wait on Windows and macOS. arboard sets the text synchronously
    // there (Windows: OpenClipboard, SetClipboardData with the real data,
    // CloseClipboard before returning; macOS: NSPasteboard writeObjects), so
    // the target reads the new text on Ctrl/Cmd+V. On Linux (X11/Wayland) the
    // selection is served from a background thread, so the upstream 50 ms
    // stays there.
    #[cfg(target_os = "linux")]
    tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

    let Some(binding) = binding else {
        return Ok(PasteResult::copied(None));
    };
    if !modifiers_up {
        log::warn!("[paste] a modifier key was still held; copied instead");
        return Ok(PasteResult::failed(true, "A key was still held down, so VoiceLnq didn't paste.".into()));
    }
    let shortcut = shortcut.unwrap_or_default();
    let window_id = binding.window_id.clone();

    // The window check and the keystroke run in one blocking step, nothing in
    // between, so the paste goes only to the window it was authorized for
    // (spec §4.3).
    let (pressed, field) = tokio::task::spawn_blocking(move || -> (KeyOutcome, Option<context::FocusField>) {
        let (verdict, _password, field) = context::verify_paste_binding(&binding);
        if let Err(reason) = verdict {
            return (KeyOutcome::Refused(reason), field);
        }
        // 0.9.23: checked again right before the keys. A key pressed during
        // the check would change what Ctrl+V does; a copy made during it
        // would paste the wrong text.
        if modifiers_held() {
            return (KeyOutcome::NotSent("A key was held down just before the paste.".into()), field);
        }
        if written.is_some() && clipboard_keep::sequence() != written {
            return (KeyOutcome::NotSent("The clipboard changed just before the paste.".into()), field);
        }
        let mut enigo = match Enigo::new(&Settings::default()) {
            Ok(enigo) => enigo,
            Err(e) => return (KeyOutcome::NotSent(e.to_string()), field),
        };
        (press_paste_keys(&mut enigo, shortcut), field)
    })
    .await
    .unwrap_or_else(|e| (KeyOutcome::NotSent(format!("Paste task failed: {e}")), None));

    let keys_sent = matches!(pressed, KeyOutcome::Sent { .. });
    if keys_sent {
        // Hold the lock a moment so the app reads this text before another
        // delivery can put its own on the clipboard (Codex review).
        tokio::time::sleep(tokio::time::Duration::from_millis(PASTE_SETTLE_MS)).await;
    }

    match kept {
        // 0.9.23: put the clipboard back later, holding the lock until then.
        Some((saved, seq)) if keys_sent => {
            let transcript = text.clone();
            let allowed = restore.is_some_and(|mode| clipboard_keep::restore_allowed(mode, field));
            tauri::async_runtime::spawn(async move {
                let _held = one_at_a_time;
                put_clipboard_back(saved, seq, allowed, window_id, transcript).await;
            });
        }
        // Nothing was pasted: the text stays, as an ordinary clipboard entry.
        Some((_, seq)) => {
            let transcript = text.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                clipboard_keep::keep_transcript(&transcript, seq)
            })
            .await;
            log::info!("[paste] not pasted; the text stays on the clipboard: {outcome:?}");
        }
        None => {}
    }

    Ok(match pressed {
        KeyOutcome::Sent { warning } => {
            if let Some(warning) = &warning {
                log::warn!("[paste] keys sent, but {warning}");
            }
            log::info!("[paste] pasted ({shortcut:?})");
            PasteResult::pasted()
        }
        KeyOutcome::Refused(reason) => PasteResult::copied(Some(reason)),
        KeyOutcome::NotSent(error) => {
            log::warn!("[paste] no keys sent: {error}");
            PasteResult::failed(true, error)
        }
    })
}

/// VoiceFlow 0.9.23: after a paste, waits for the app to answer and for
/// `RESTORE_DELAY`, then puts the saved clipboard back (or, when that isn't
/// safe, leaves the text as an ordinary clipboard entry). Logs what happened,
/// never the contents.
async fn put_clipboard_back(
    saved: clipboard_keep::Saved,
    seq: Option<u64>,
    allowed: bool,
    window_id: Option<String>,
    transcript: String,
) {
    let waited = tokio::time::Duration::from_millis(PASTE_SETTLE_MS);
    let answered = tokio::task::spawn_blocking(move || clipboard_keep::target_answers(window_id.as_deref()))
        .await
        .unwrap_or(false);
    tokio::time::sleep(clipboard_keep::RESTORE_DELAY.saturating_sub(waited)).await;
    let step = clipboard_keep::after_paste(true, allowed, seq, answered);
    let what = match step {
        clipboard_keep::AfterPaste::Restore => "put back".to_string(),
        clipboard_keep::AfterPaste::KeepTranscript(why) => format!("not put back ({why}); the text stays"),
    };
    let saved = std::sync::Arc::new(saved);
    // Another app may hold the clipboard for a moment: try again a few times.
    // Each try checks the sequence again, so a newer copy is never replaced.
    for attempt in 1..=RESTORE_ATTEMPTS {
        let (saved, text) = (saved.clone(), transcript.clone());
        let outcome = tokio::task::spawn_blocking(move || match step {
            clipboard_keep::AfterPaste::Restore => {
                let seq = seq.expect("after_paste restores only with a sequence");
                clipboard_keep::restore(&saved, seq, &text)
            }
            clipboard_keep::AfterPaste::KeepTranscript(_) => clipboard_keep::keep_transcript(&text, seq),
        })
        .await;
        match outcome {
            Ok(clipboard_keep::Restored::NotOpened(why)) if attempt < RESTORE_ATTEMPTS => {
                log::info!("[paste] clipboard {what}: busy ({why}), trying again");
                tokio::time::sleep(tokio::time::Duration::from_millis(400)).await;
            }
            Ok(outcome) => {
                log::info!("[paste] clipboard {what}: {outcome:?}");
                return;
            }
            Err(e) => {
                log::warn!("[paste] clipboard restore task failed: {e}");
                return;
            }
        }
    }
}

/// How many times a busy clipboard is tried when putting it back.
const RESTORE_ATTEMPTS: u32 = 3;

/// How long the paste keys wait for the person's own modifier keys to come up.
const MODIFIERS_WAIT: std::time::Duration = std::time::Duration::from_millis(1000);

/// Waits until no Ctrl, Alt, Shift or Win/Cmd key is held, up to `timeout`.
/// True when they are all up.
fn wait_for_modifiers_up(timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if !modifiers_held() {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(15));
    }
}

#[cfg(target_os = "windows")]
fn modifiers_held() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN]
        .iter()
        .any(|&vk| unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000 != 0)
}

#[cfg(target_os = "macos")]
fn modifiers_held() -> bool {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceFlagsState(state_id: i32) -> u64;
    }
    // kCGEventSourceStateCombinedSessionState; shift, control, option, command.
    const HELD: u64 = 0x0002_0000 | 0x0004_0000 | 0x0008_0000 | 0x0010_0000;
    unsafe { CGEventSourceFlagsState(0) & HELD != 0 }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn modifiers_held() -> bool {
    false
}

/// Which keys paste. Most apps take Ctrl+V; mintty (Git Bash) pastes with
/// Shift+Insert. Only one shortcut is ever sent, never both, so nothing is
/// pasted twice.
#[derive(serde::Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum PasteShortcut {
    #[default]
    CtrlV,
    ShiftInsert,
}

/// What the keystroke step did.
enum KeyOutcome {
    /// The paste key went down (a later key-up error is only a warning: the
    /// app may well have pasted already).
    Sent { warning: Option<String> },
    /// The re-check stopped it; no key was sent.
    Refused(context::PasteRefusal),
    /// No paste key was sent (the keyboard could not be driven).
    NotSent(String),
}

/// Ctrl+V (Cmd+V on macOS) using virtual key codes, so any keyboard layout
/// works, or Shift+Insert. Every key pressed is released, even after an error.
fn press_paste_keys(enigo: &mut Enigo, shortcut: PasteShortcut) -> KeyOutcome {
    #[cfg(target_os = "macos")]
    let (modifier, key) = match shortcut {
        PasteShortcut::CtrlV => (Key::Meta, Key::Other(9)), // V on macOS
        PasteShortcut::ShiftInsert => (Key::Meta, Key::Other(9)),
    };
    #[cfg(target_os = "windows")]
    let (modifier, key) = match shortcut {
        PasteShortcut::CtrlV => (Key::Control, Key::Other(0x56)), // VK_V
        PasteShortcut::ShiftInsert => (Key::Shift, Key::Insert),
    };
    #[cfg(target_os = "linux")]
    let (modifier, key) = match shortcut {
        PasteShortcut::CtrlV => (Key::Control, Key::Unicode('v')),
        PasteShortcut::ShiftInsert => (Key::Shift, Key::Insert),
    };

    if let Err(e) = enigo.key(modifier, Direction::Press) {
        return KeyOutcome::NotSent(format!("Failed to press modifier key: {e}"));
    }
    if let Err(e) = enigo.key(key, Direction::Press) {
        let _ = enigo.key(modifier, Direction::Release);
        return KeyOutcome::NotSent(format!("Failed to press the paste key: {e}"));
    }
    // Release in reverse order.
    let released_key = enigo.key(key, Direction::Release);
    let released_modifier = enigo.key(modifier, Direction::Release);
    let warning = match (released_key, released_modifier) {
        (Ok(()), Ok(())) => None,
        (Err(e), _) | (_, Err(e)) => Some(format!("a key release failed: {e}")),
    };
    KeyOutcome::Sent { warning }
}

/// VoiceFlow: what `write_text` did, as facts. `pasted`: the paste keys were
/// sent. `copied`: the text is on the clipboard. `reason`: the re-check
/// stopped the keystroke. `error`: something failed (no keys were sent).
#[derive(serde::Serialize, Debug)]
#[serde(rename_all = "camelCase")]
struct PasteResult {
    pasted: bool,
    copied: bool,
    reason: Option<context::PasteRefusal>,
    error: Option<String>,
}

impl PasteResult {
    fn pasted() -> Self {
        Self { pasted: true, copied: true, reason: None, error: None }
    }
    fn copied(reason: Option<context::PasteRefusal>) -> Self {
        Self { pasted: false, copied: true, reason, error: None }
    }
    fn failed(copied: bool, error: String) -> Self {
        Self { pasted: false, copied, reason: None, error: Some(error) }
    }
}

#[cfg(test)]
mod paste_tests {
    use super::*;

    #[test]
    fn paste_results_serialize_as_facts() {
        let json = |r: PasteResult| serde_json::to_value(r).unwrap();
        assert_eq!(
            json(PasteResult::pasted()),
            serde_json::json!({ "pasted": true, "copied": true, "reason": null, "error": null })
        );
        assert_eq!(
            json(PasteResult::copied(Some(context::PasteRefusal::TargetChanged))),
            serde_json::json!({ "pasted": false, "copied": true, "reason": "target-changed", "error": null })
        );
        assert_eq!(
            json(PasteResult::failed(true, "no keyboard".into()))["copied"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn paste_shortcut_parses_from_the_frontend() {
        let parse = |s: &str| serde_json::from_str::<PasteShortcut>(s).unwrap();
        assert_eq!(parse("\"ctrl-v\""), PasteShortcut::CtrlV);
        assert_eq!(parse("\"shift-insert\""), PasteShortcut::ShiftInsert);
        assert_eq!(PasteShortcut::default(), PasteShortcut::CtrlV);
    }
}

/// Simulates pressing the Enter/Return key
///
/// This is useful for automatically submitting text in chat applications
/// after transcription has been pasted.
#[tauri::command]
async fn simulate_enter_keystroke() -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default()).map_err(|e| e.to_string())?;

    // Use Direction::Click for a combined press+release action
    enigo
        .key(Key::Return, Direction::Click)
        .map_err(|e| format!("Failed to simulate Enter key: {}", e))?;

    Ok(())
}

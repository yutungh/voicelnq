//! VoiceFlow: which app the user is dictating into (spec §4.1, §4.3).
//!
//! `capture_target` takes a snapshot of the foreground app at the hotkey:
//! Tier A identity (process, exe, bundle id), the window title (kept on this
//! computer only) and the Tier C password-field check. The privacy decision
//! itself is a pure function on the frontend (`src/lib/privacy/policy.ts`);
//! this module only observes. Every failure here removes information (the
//! snapshot comes back unresolved, or the check comes back unknown / timed
//! out); nothing in this module ever reports more than it saw.
//!
//! `focus_target` brings a recording's original window back to the front
//! before a paste started from a VoiceFlow button.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// Identity re-samples when the first one is unresolved (spec §4.1: two
/// re-samples, ≤ 100 ms in total).
const IDENTITY_RESAMPLES: u8 = 2;
const IDENTITY_RESAMPLE_GAP: Duration = Duration::from_millis(45);

/// Tier C budget: past this the check counts as "timed-out".
const PASSWORD_CHECK_TIMEOUT: Duration = Duration::from_millis(100);

/// VoiceFlow 0.9.11: a transient answer (unknown, timed out) gets this many
/// more tries before it counts. An Electron app such as Kite can fail one
/// UI Automation read while it re-renders; in 0.9.10 that refused a paste
/// into the very window the dictation started in ("couldn't check the
/// field"). An unanswered check no longer stops a paste, but a second look
/// still catches a password field that the first read missed.
const PASSWORD_CHECK_RETRIES: u8 = 2;
const PASSWORD_CHECK_RETRY_GAP: Duration = Duration::from_millis(30);

/// Result of the password-field check. The strings are what the frontend
/// counts and stores in history.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PasswordCheck {
    /// Checked: the focused element is not a password field.
    NotPassword,
    /// Checked: the focused element is a password field.
    Password,
    /// The check ran but could not tell (no focused element, call failed).
    Unknown,
    /// The checking service is not available on this computer.
    Unavailable,
    /// This platform has no check.
    Unsupported,
    /// The check did not answer within the budget.
    TimedOut,
    /// Not run: identity unresolved, or the target is VoiceFlow itself.
    NotChecked,
}

/// VoiceFlow 0.9.23: whether the focused element takes text. Read at paste
/// time only, and only where the answer is trusted (`field_check_applies`):
/// explorer.exe on Windows (File Explorer, the desktop) and Finder (which
/// also owns the desktop) on macOS. Elsewhere a control that doesn't look
/// like a text field can still take a paste (a spreadsheet cell, a
/// terminal), so it isn't asked.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FocusField {
    /// A text box, a document, or a writable value.
    Editable,
    /// Checked: the focused element (or nothing) takes no text.
    NotEditable,
    /// The check couldn't tell. Never stops a paste.
    Unknown,
}

/// How long the paste-time field check may take.
const FIELD_CHECK_TIMEOUT: Duration = Duration::from_millis(150);

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TargetSnapshot {
    /// "windows" | "macos" | "other"
    pub platform: String,
    /// Tier A: true when the app's identity was read.
    pub resolved: bool,
    /// The foreground app is VoiceFlow itself.
    pub is_self: bool,
    pub app_name: Option<String>,
    /// Lower-case executable file name, e.g. "1password.exe".
    pub exe_name: Option<String>,
    pub exe_path: Option<String>,
    /// macOS bundle identifier.
    pub bundle_id: Option<String>,
    /// Window title. Local only: stored in history on this computer, never sent.
    pub title: Option<String>,
    /// Windows: the top-level window handle, as a decimal string.
    pub window_id: Option<String>,
    pub pid: Option<u32>,
    /// How many identity samples were taken (1 to 3).
    pub samples: u8,
    pub identity_ms: f64,
    pub password_check: PasswordCheck,
    pub password_check_ms: f64,
    /// What went wrong, if anything (for logs; never decides anything).
    pub error: Option<String>,
    /// The title matches a pattern from the word lists (`privacy.titleDenyRe`),
    /// checked here so a pattern can never stall the app.
    #[serde(default)]
    pub profile_title_denied: bool,
    /// VoiceFlow 0.9.11: the foreground window's class (Windows), so the
    /// paste rule can tell the desktop, the taskbar and the Start menu from
    /// an app window. Never sent anywhere.
    #[serde(default)]
    pub window_class: Option<String>,
    /// VoiceFlow 0.9.11 (Windows): the app runs at a higher integrity level
    /// than VoiceFlow (it runs as administrator), so Windows drops the paste
    /// keys VoiceFlow sends it. None: it could not be read. Elsewhere false.
    #[serde(default)]
    pub higher_integrity: Option<bool>,
    /// VoiceFlow 0.9.23: the paste-time field check (`FocusField`); None
    /// when it wasn't asked.
    #[serde(default)]
    pub focus_field: Option<FocusField>,
}

impl TargetSnapshot {
    fn unresolved(platform: &str) -> Self {
        Self {
            platform: platform.to_string(),
            resolved: false,
            is_self: false,
            app_name: None,
            exe_name: None,
            exe_path: None,
            bundle_id: None,
            title: None,
            window_id: None,
            pid: None,
            samples: 0,
            identity_ms: 0.0,
            password_check: PasswordCheck::NotChecked,
            password_check_ms: 0.0,
            error: None,
            profile_title_denied: false,
            window_class: None,
            higher_integrity: None,
            focus_field: None,
        }
    }
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "other"
    }
}

/// Tier A with the bounded retry: up to two more samples when unresolved.
fn sample_identity() -> TargetSnapshot {
    let started = Instant::now();
    let mut snapshot = platform::identity();
    let mut samples: u8 = 1;
    while !snapshot.resolved && samples <= IDENTITY_RESAMPLES {
        std::thread::sleep(IDENTITY_RESAMPLE_GAP);
        snapshot = platform::identity();
        samples += 1;
    }
    snapshot.samples = samples;
    snapshot.identity_ms = started.elapsed().as_secs_f64() * 1000.0;
    snapshot
}

fn run_password_check(snapshot: &mut TargetSnapshot) {
    if !snapshot.resolved || snapshot.is_self {
        snapshot.password_check = PasswordCheck::NotChecked;
        return;
    }
    let started = Instant::now();
    snapshot.password_check = settled_password_check();
    snapshot.password_check_ms = started.elapsed().as_secs_f64() * 1000.0;
}

/// An answer that may change on a second look: the read failed or was slow.
/// "Unavailable" and "unsupported" are lasting, so they are not retried.
fn is_transient(check: PasswordCheck) -> bool {
    matches!(check, PasswordCheck::Unknown | PasswordCheck::TimedOut)
}

/// Pure retry rule: runs `check` until it gives a lasting answer or the
/// retries run out, pausing between tries. Returns the last answer and how
/// many tries it took.
fn settle_password_check(
    mut check: impl FnMut() -> PasswordCheck,
    retries: u8,
    mut pause: impl FnMut(),
) -> (PasswordCheck, u8) {
    let mut tries: u8 = 1;
    let mut result = check();
    while is_transient(result) && tries <= retries {
        pause();
        result = check();
        tries += 1;
    }
    (result, tries)
}

/// The password-field check with the bounded retry for transient answers.
fn settled_password_check() -> PasswordCheck {
    let (result, tries) = settle_password_check(
        || platform::password_check(PASSWORD_CHECK_TIMEOUT),
        PASSWORD_CHECK_RETRIES,
        || std::thread::sleep(PASSWORD_CHECK_RETRY_GAP),
    );
    if tries > 1 {
        log::info!("[paste] password check answered {result:?} after {tries} tries");
    }
    result
}

/// The snapshot itself, blocking (identity re-samples, the bounded password
/// check). The native hotkey worker calls it directly (`hotkey.rs`), so the
/// app in front is captured at the key even while the webview sleeps.
pub fn capture_now(app: &tauri::AppHandle, check_password: bool) -> TargetSnapshot {
    let mut snapshot = sample_identity();
    if check_password {
        run_password_check(&mut snapshot);
    }
    // VoiceFlow B + C2: title patterns from the word lists, matched here.
    snapshot.profile_title_denied = snapshot
        .title
        .as_deref()
        .is_some_and(|title| crate::profile::title_denied(app, title));
    snapshot
}

/// Pure: whether the paste-time field check is asked for this app. Only
/// where "no text field" is a trustworthy answer: explorer.exe on Windows
/// (File Explorer and the desktop), Finder on macOS.
pub fn field_check_applies(snapshot: &TargetSnapshot) -> bool {
    if !snapshot.resolved || snapshot.is_self {
        return false;
    }
    match snapshot.platform.as_str() {
        "windows" => snapshot.exe_name.as_deref() == Some("explorer.exe"),
        "macos" => snapshot
            .bundle_id
            .as_deref()
            .is_some_and(|b| b.eq_ignore_ascii_case("com.apple.finder")),
        _ => false,
    }
}

/// Snapshot of the app the user is in right now. Call it first thing at the
/// hotkey, before VoiceFlow shows anything, and again at paste time.
///
/// VoiceFlow 0.9.23: `check_field` (paste time only) adds the field check
/// for File Explorer, the desktop and Finder.
#[tauri::command]
pub async fn capture_target(
    app: tauri::AppHandle,
    check_password: Option<bool>,
    check_field: Option<bool>,
) -> TargetSnapshot {
    let check = check_password.unwrap_or(true);
    let field = check_field.unwrap_or(false);
    let result = tokio::task::spawn_blocking(move || {
        let mut snapshot = capture_now(&app, check);
        if field && field_check_applies(&snapshot) {
            let answer = platform::field_check(&snapshot, FIELD_CHECK_TIMEOUT);
            log::info!("[paste] field check: {answer:?}");
            snapshot.focus_field = Some(answer);
        }
        snapshot
    })
    .await;
    match result {
        Ok(snapshot) => snapshot,
        Err(e) => {
            // A failed capture can only remove information: unresolved.
            let mut snapshot = TargetSnapshot::unresolved(platform_name());
            snapshot.error = Some(format!("capture failed: {e}"));
            snapshot
        }
    }
}

/// Brings the recording's original window back to the front. Returns false
/// when the window is gone, belongs to another process now, or would not
/// come forward.
#[tauri::command]
pub async fn focus_target(window_id: Option<String>, pid: Option<u32>) -> bool {
    tokio::task::spawn_blocking(move || platform::focus(window_id.as_deref(), pid))
        .await
        .unwrap_or(false)
}

/// VoiceFlow A2: the same focus step, for the recording bar's focus restore
/// (blocking; call it off the main thread).
pub fn focus_window(window_id: Option<&str>, pid: Option<u32>) -> bool {
    platform::focus(window_id, pid)
}

/// The window a paste was authorized for (spec §4.3; Codex review finding 4).
/// The frontend authorizes the paste on a fresh snapshot; this binds the
/// keystroke to that same window, so a focus change between the decision and
/// the Ctrl+V stops the paste instead of typing into whatever is in front.
///
/// VoiceFlow 0.9.11: there is no strict flag any more. A field check that
/// can't answer (common in Electron apps and terminals) no longer stops the
/// paste; the text stays on the clipboard either way.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PasteBinding {
    /// Windows: the authorized top-level window handle, as a decimal string.
    pub window_id: Option<String>,
    /// The authorized app's process (for a store app, the hosted app).
    pub pid: Option<u32>,
}

/// Why the native paste stopped just before the keystroke.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PasteRefusal {
    /// Another window (or VoiceFlow) is in front now, or it can't be read.
    TargetChanged,
    /// The focused element is a password field now.
    PasswordField,
}

/// Pure decision: may the keystroke go to the app observed right now?
/// Fails closed on identity: a binding with nothing to compare, an unreadable
/// foreground window, or any difference refuses. Only a positive password
/// answer refuses on the field; an unanswered check lets the paste through.
pub fn check_paste_binding(
    binding: &PasteBinding,
    now: &TargetSnapshot,
    password: PasswordCheck,
) -> Result<(), PasteRefusal> {
    if !now.resolved || now.is_self {
        return Err(PasteRefusal::TargetChanged);
    }
    if binding.window_id.is_none() && binding.pid.is_none() {
        return Err(PasteRefusal::TargetChanged);
    }
    if let Some(expected) = &binding.window_id {
        if now.window_id.as_deref() != Some(expected.as_str()) {
            return Err(PasteRefusal::TargetChanged);
        }
    }
    if let Some(expected) = binding.pid {
        if now.pid != Some(expected) {
            return Err(PasteRefusal::TargetChanged);
        }
    }
    match password {
        PasswordCheck::Password => Err(PasteRefusal::PasswordField),
        _ => Ok(()),
    }
}

/// The window must be the bound one both before and after the password
/// check (which can take up to 100 ms), so a switch while it runs is caught
/// and the password answer belongs to the bound window.
pub fn check_paste_binding_around(
    binding: &PasteBinding,
    before: &TargetSnapshot,
    password: PasswordCheck,
    after: &TargetSnapshot,
) -> Result<(), PasteRefusal> {
    check_paste_binding(binding, before, password)?;
    check_paste_binding(binding, after, PasswordCheck::NotPassword)
}

/// Reads the app in front, its focused field, and the app in front again
/// (one identity sample each: this runs between the clipboard write and
/// Ctrl+V) and checks them against the binding. Blocking; the caller sends
/// the keystroke right after, in the same blocking step.
///
/// VoiceFlow 0.9.11: also returns the password-field answer, and logs the
/// exact reason for a refusal (which sample failed, the window and process
/// expected and seen, the password answer; never a title).
pub fn verify_paste_binding(binding: &PasteBinding) -> (Result<(), PasteRefusal>, PasswordCheck) {
    let before = platform::identity();
    if !before.resolved || before.is_self {
        log::warn!(
            "[paste] refused before the keystroke: {}",
            refusal_detail(binding, &before, PasswordCheck::NotChecked, None)
        );
        return (Err(PasteRefusal::TargetChanged), PasswordCheck::NotChecked);
    }
    let password = settled_password_check();
    let after = platform::identity();
    let verdict = check_paste_binding_around(binding, &before, password, &after);
    if verdict.is_err() {
        log::warn!(
            "[paste] refused before the keystroke: {}",
            refusal_detail(binding, &before, password, Some(&after))
        );
    }
    (verdict, password)
}

/// One log line saying why a bound paste was refused. Window handles,
/// process ids, the executable name and the password answer only: never the
/// window title.
pub fn refusal_detail(
    binding: &PasteBinding,
    before: &TargetSnapshot,
    password: PasswordCheck,
    after: Option<&TargetSnapshot>,
) -> String {
    let sample = |s: &TargetSnapshot| {
        format!(
            "window={} pid={} exe={} resolved={} self={}",
            s.window_id.as_deref().unwrap_or("-"),
            s.pid.map_or("-".to_string(), |p| p.to_string()),
            s.exe_name.as_deref().unwrap_or("-"),
            s.resolved,
            s.is_self
        )
    };
    let verdict = match after {
        Some(after) => check_paste_binding_around(binding, before, password, after),
        None => check_paste_binding(binding, before, password),
    };
    let failed = match verdict {
        Ok(()) => "none",
        Err(_) if check_paste_binding(binding, before, PasswordCheck::NotPassword).is_err() => {
            "window before the check"
        }
        Err(PasteRefusal::PasswordField) => "password check",
        Err(PasteRefusal::TargetChanged) => "window after the check",
    };
    format!(
        "reason={:?} failed={failed} expected window={} pid={} | before {} | password={:?} | after {}",
        verdict.err(),
        binding.window_id.as_deref().unwrap_or("-"),
        binding.pid.map_or("-".to_string(), |p| p.to_string()),
        sample(before),
        password,
        after.map_or("-".to_string(), sample),
    )
}

/// Pure (macOS roles, tested everywhere): does an element with this role,
/// subrole and value settability take text?
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
fn ax_field_kind(role: &str, subrole: Option<&str>, value_settable: bool) -> FocusField {
    const TEXT_ROLES: &[&str] = &["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"];
    if TEXT_ROLES.contains(&role) || subrole == Some("AXSearchField") || value_settable {
        FocusField::Editable
    } else {
        FocusField::NotEditable
    }
}

fn file_name_lower(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .to_lowercase()
}

/// "C:\\Program Files\\1Password\\1Password.exe" -> "1Password"
fn display_name_from_path(path: &str) -> String {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
    match file.rsplit_once('.') {
        Some((stem, ext)) if ext.eq_ignore_ascii_case("exe") => stem.to_string(),
        _ => file.to_string(),
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::sync::mpsc;
    use std::sync::{Mutex, OnceLock};
    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindow, SetForegroundWindow, ShowWindow,
        SW_RESTORE,
    };

    fn window_pid(hwnd: HWND) -> u32 {
        let mut pid: u32 = 0;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        pid
    }

    fn exe_path(pid: u32) -> Option<String> {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut buf = vec![0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
            CloseHandle(handle);
            if ok == 0 || len == 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    fn window_title(hwnd: HWND) -> Option<String> {
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return None;
            }
            let mut buf = vec![0u16; len as usize + 1];
            let read = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if read <= 0 {
                return None;
            }
            Some(String::from_utf16_lossy(&buf[..read as usize]))
        }
    }

    fn window_class(hwnd: HWND) -> Option<String> {
        let mut buf = [0u16; 256];
        let read = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
        (read > 0).then(|| String::from_utf16_lossy(&buf[..read as usize]))
    }

    struct ChildSearch {
        host_pid: u32,
        found: u32,
    }

    unsafe extern "system" fn find_hosted_app(child: HWND, lparam: LPARAM) -> BOOL {
        let search = &mut *(lparam as *mut ChildSearch);
        let pid = window_pid(child);
        if pid != 0 && pid != search.host_pid {
            search.found = pid;
            return 0; // stop
        }
        1
    }

    /// Store apps run inside ApplicationFrameHost.exe; the real app owns a
    /// child window.
    fn hosted_app_pid(hwnd: HWND, host_pid: u32) -> Option<u32> {
        let mut search = ChildSearch { host_pid, found: 0 };
        unsafe {
            EnumChildWindows(hwnd, Some(find_hosted_app), &mut search as *mut _ as LPARAM);
        }
        (search.found != 0).then_some(search.found)
    }

    pub fn identity() -> TargetSnapshot {
        let mut snapshot = TargetSnapshot::unresolved("windows");
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() {
            // No foreground window: the secure desktop (UAC), a lock screen,
            // or focus in transition. Unresolved.
            snapshot.error = Some("no foreground window".into());
            return snapshot;
        }
        // Read before anything can fail, so even an unreadable process still
        // says whether the desktop or the taskbar was in front.
        snapshot.window_class = window_class(hwnd);
        let mut pid = window_pid(hwnd);
        if pid == 0 {
            snapshot.error = Some("no process for the foreground window".into());
            return snapshot;
        }
        let mut path = exe_path(pid);
        if let Some(p) = &path {
            if file_name_lower(p) == "applicationframehost.exe" {
                if let Some(inner) = hosted_app_pid(hwnd, pid) {
                    if let Some(inner_path) = exe_path(inner) {
                        pid = inner;
                        path = Some(inner_path);
                    }
                }
            }
        }
        let Some(path) = path else {
            snapshot.error = Some("could not read the app's executable".into());
            return snapshot;
        };
        snapshot.resolved = true;
        snapshot.is_self = pid == std::process::id();
        snapshot.exe_name = Some(file_name_lower(&path));
        snapshot.app_name = Some(display_name_from_path(&path));
        snapshot.exe_path = Some(path);
        snapshot.title = window_title(hwnd);
        snapshot.window_id = Some((hwnd as usize).to_string());
        snapshot.pid = Some(pid);
        snapshot.higher_integrity = match (integrity_level(pid), own_integrity_level()) {
            (Some(theirs), Some(ours)) => Some(theirs > ours),
            _ => None,
        };
        snapshot
    }

    /// The process's mandatory integrity level (the last sub-authority of
    /// its token's integrity SID: 0x2000 medium, 0x3000 high). None when the
    /// token can't be read.
    fn integrity_level(pid: u32) -> Option<u32> {
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::Security::{
            GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation,
            TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY,
        };
        use windows_sys::Win32::System::Threading::OpenProcessToken;
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return None;
            }
            let mut token: HANDLE = std::ptr::null_mut();
            let opened = OpenProcessToken(process, TOKEN_QUERY, &mut token);
            CloseHandle(process);
            if opened == 0 || token.is_null() {
                return None;
            }
            // u64 words keep the buffer aligned for TOKEN_MANDATORY_LABEL.
            let mut buf = [0u64; 16];
            let mut len: u32 = 0;
            let ok = GetTokenInformation(
                token,
                TokenIntegrityLevel,
                buf.as_mut_ptr().cast(),
                std::mem::size_of_val(&buf) as u32,
                &mut len,
            );
            CloseHandle(token);
            if ok == 0 {
                return None;
            }
            let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
            let sid = label.Label.Sid;
            if sid.is_null() {
                return None;
            }
            let count = *GetSidSubAuthorityCount(sid);
            if count == 0 {
                return None;
            }
            Some(*GetSidSubAuthority(sid, u32::from(count) - 1))
        }
    }

    fn own_integrity_level() -> Option<u32> {
        static OWN: OnceLock<Option<u32>> = OnceLock::new();
        *OWN.get_or_init(|| integrity_level(std::process::id()))
    }

    // --- Tier C: UI Automation on one long-lived worker thread -------------

    /// What the worker is asked. 0.9.23: the field check is its own request,
    /// so the password check's 100 ms budget is untouched; it carries a
    /// deadline, and the worker drops it unasked once that has passed.
    enum Request {
        Password(mpsc::Sender<PasswordCheck>),
        Field(mpsc::Sender<FocusField>, Instant),
    }

    fn worker() -> &'static Mutex<mpsc::Sender<Request>> {
        static WORKER: OnceLock<Mutex<mpsc::Sender<Request>>> = OnceLock::new();
        WORKER.get_or_init(|| {
            let (tx, rx) = mpsc::channel::<Request>();
            std::thread::Builder::new()
                .name("voiceflow-uia".into())
                .spawn(move || uia_loop(rx))
                .expect("spawn UI Automation worker");
            Mutex::new(tx)
        })
    }

    fn uia_loop(rx: mpsc::Receiver<Request>) {
        use windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
        };
        use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

        let automation: Option<IUIAutomation> = unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()
        };
        for request in rx {
            let reply = match request {
                Request::Password(reply) => reply,
                Request::Field(reply, deadline) => {
                    if Instant::now() < deadline {
                        let answer = match &automation {
                            None => FocusField::Unknown,
                            Some(automation) => unsafe { focused_field(automation) },
                        };
                        let _ = reply.send(answer);
                    }
                    continue;
                }
            };
            let result = match &automation {
                None => PasswordCheck::Unavailable,
                Some(automation) => unsafe {
                    // VoiceFlow 0.9.11: an unknown answer says why, in the log.
                    match automation.GetFocusedElement() {
                        Ok(element) => match element.CurrentIsPassword() {
                            Ok(is_password) if is_password.as_bool() => PasswordCheck::Password,
                            Ok(_) => PasswordCheck::NotPassword,
                            Err(e) => {
                                log::warn!("[paste] password check: IsPassword failed: {e}");
                                PasswordCheck::Unknown
                            }
                        },
                        Err(e) => {
                            log::warn!("[paste] password check: no focused element: {e}");
                            PasswordCheck::Unknown
                        }
                    }
                },
            };
            // The caller may have stopped waiting (timed out); that is fine.
            let _ = reply.send(result);
        }
    }

    /// VoiceFlow 0.9.23: does the focused element take text? Edit and
    /// Document controls do; so does anything with a writable Value pattern
    /// or a Text pattern. A failed call is "unknown", never "no".
    unsafe fn focused_field(
        automation: &windows::Win32::UI::Accessibility::IUIAutomation,
    ) -> FocusField {
        use windows::core::HRESULT;
        use windows::Win32::UI::Accessibility::{
            IUIAutomationTextPattern, IUIAutomationValuePattern, UIA_DocumentControlTypeId,
            UIA_EditControlTypeId, UIA_TextPatternId, UIA_ValuePatternId,
        };
        let Ok(element) = automation.GetFocusedElement() else {
            return FocusField::Unknown;
        };
        let Ok(control) = element.CurrentControlType() else {
            return FocusField::Unknown;
        };
        if control == UIA_EditControlTypeId || control == UIA_DocumentControlTypeId {
            return FocusField::Editable;
        }
        // An unsupported pattern comes back as a null pointer (an error with
        // S_OK); any other error means the call itself failed.
        let unsupported = |e: &windows::core::Error| e.code() == HRESULT(0);
        match element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) {
            Ok(value) => match value.CurrentIsReadOnly() {
                Ok(read_only) if !read_only.as_bool() => return FocusField::Editable,
                Ok(_) => {}
                Err(_) => return FocusField::Unknown,
            },
            Err(e) if unsupported(&e) => {}
            Err(_) => return FocusField::Unknown,
        }
        match element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) {
            Ok(_) => FocusField::Editable,
            Err(e) if unsupported(&e) => FocusField::NotEditable,
            Err(_) => FocusField::Unknown,
        }
    }

    pub fn field_check(_snapshot: &TargetSnapshot, timeout: Duration) -> FocusField {
        let (tx, rx) = mpsc::channel();
        let deadline = Instant::now() + timeout;
        let sent = worker()
            .lock()
            .map(|sender| sender.send(Request::Field(tx, deadline)).is_ok())
            .unwrap_or(false);
        if !sent {
            return FocusField::Unknown;
        }
        rx.recv_timeout(timeout).unwrap_or(FocusField::Unknown)
    }

    pub fn password_check(timeout: Duration) -> PasswordCheck {
        let (tx, rx) = mpsc::channel();
        let sent = worker()
            .lock()
            .map(|sender| sender.send(Request::Password(tx)).is_ok())
            .unwrap_or(false);
        if !sent {
            return PasswordCheck::Unavailable;
        }
        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => PasswordCheck::TimedOut,
            Err(mpsc::RecvTimeoutError::Disconnected) => PasswordCheck::Unavailable,
        }
    }

    pub fn focus(window_id: Option<&str>, pid: Option<u32>) -> bool {
        let Some(raw) = window_id.and_then(|w| w.parse::<usize>().ok()) else {
            return false;
        };
        let hwnd = raw as HWND;
        unsafe {
            if IsWindow(hwnd) == 0 {
                return false;
            }
            // A reused handle now owned by another process is not our target.
            // (For a store app the stored pid is the hosted app, so compare
            // against either the frame's process or a child's.)
            if let Some(expected) = pid {
                let owner = window_pid(hwnd);
                if owner != expected && hosted_app_pid(hwnd, owner) != Some(expected) {
                    return false;
                }
            }
            if IsIconic(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }
            SetForegroundWindow(hwnd);
        }
        let deadline = Instant::now() + Duration::from_millis(400);
        while Instant::now() < deadline {
            if unsafe { GetForegroundWindow() } == hwnd {
                // Let the app restore its own keyboard focus.
                std::thread::sleep(Duration::from_millis(120));
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        false
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
    use objc2_foundation::NSString;

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn IsSecureEventInputEnabled() -> u8;
    }

    /// The focused window's title through Accessibility, only when VoiceFlow
    /// already has that permission. Never prompts (M1).
    fn ax_window_title(pid: i32) -> Option<String> {
        use accessibility_sys::{
            kAXFocusedWindowAttribute, kAXTitleAttribute, AXIsProcessTrusted,
            AXUIElementCopyAttributeValue, AXUIElementCreateApplication,
            AXUIElementSetMessagingTimeout,
        };
        use core_foundation_sys::base::{CFRelease, CFTypeRef};
        use core_foundation_sys::string::{CFStringGetTypeID, CFStringRef};
        use core_foundation_sys::base::CFGetTypeID;

        unsafe {
            if !AXIsProcessTrusted() {
                return None;
            }
            let app = AXUIElementCreateApplication(pid);
            if app.is_null() {
                return None;
            }
            AXUIElementSetMessagingTimeout(app, 0.02);
            let focused_attr = NSString::from_str(kAXFocusedWindowAttribute);
            let mut window: CFTypeRef = std::ptr::null();
            let err = AXUIElementCopyAttributeValue(
                app,
                objc2::rc::Retained::as_ptr(&focused_attr) as CFStringRef,
                &mut window,
            );
            CFRelease(app as CFTypeRef);
            if err != 0 || window.is_null() {
                return None;
            }
            let title_attr = NSString::from_str(kAXTitleAttribute);
            let mut title: CFTypeRef = std::ptr::null();
            let err = AXUIElementCopyAttributeValue(
                window as _,
                objc2::rc::Retained::as_ptr(&title_attr) as CFStringRef,
                &mut title,
            );
            CFRelease(window);
            if err != 0 || title.is_null() {
                return None;
            }
            let text = if CFGetTypeID(title) == CFStringGetTypeID() {
                let s: &NSString = &*(title as *const NSString);
                Some(s.to_string())
            } else {
                None
            };
            CFRelease(title);
            text.filter(|t| !t.is_empty())
        }
    }

    pub fn identity() -> TargetSnapshot {
        let mut snapshot = TargetSnapshot::unresolved("macos");
        let workspace = NSWorkspace::sharedWorkspace();
        let Some(app) = workspace.frontmostApplication() else {
            snapshot.error = Some("no frontmost application".into());
            return snapshot;
        };
        let bundle_id = app.bundleIdentifier().map(|s| s.to_string());
        let name = app.localizedName().map(|s| s.to_string());
        let path = app
            .executableURL()
            .and_then(|url| url.path())
            .map(|s| s.to_string());
        let pid = app.processIdentifier();
        if bundle_id.is_none() && path.is_none() {
            snapshot.error = Some("the frontmost app has no bundle id or executable".into());
            return snapshot;
        }
        snapshot.resolved = true;
        snapshot.is_self = pid > 0 && pid as u32 == std::process::id();
        snapshot.exe_name = path.as_deref().map(file_name_lower);
        snapshot.app_name = name.or_else(|| path.as_deref().map(display_name_from_path));
        snapshot.exe_path = path;
        snapshot.bundle_id = bundle_id;
        snapshot.higher_integrity = Some(false);
        if pid > 0 {
            snapshot.pid = Some(pid as u32);
            snapshot.title = ax_window_title(pid);
        }
        snapshot
    }

    /// VoiceFlow 0.9.23 (Finder only): the focused element through
    /// Accessibility. A text field, text area, combo box or search field, or
    /// a settable value, takes text; no focused element (the desktop with
    /// nothing being renamed) or any other role doesn't. Without the
    /// Accessibility permission, or on any other error: unknown.
    pub fn field_check(snapshot: &TargetSnapshot, _timeout: Duration) -> FocusField {
        use accessibility_sys::{
            kAXErrorNoValue, kAXFocusedUIElementAttribute, kAXRoleAttribute,
            kAXSubroleAttribute, kAXValueAttribute, AXIsProcessTrusted,
            AXUIElementCopyAttributeValue, AXUIElementCreateApplication,
            AXUIElementIsAttributeSettable, AXUIElementRef, AXUIElementSetMessagingTimeout,
        };
        use core_foundation_sys::base::{CFGetTypeID, CFRelease, CFTypeRef};
        use core_foundation_sys::string::{CFStringGetTypeID, CFStringRef};

        unsafe fn string_attr(element: AXUIElementRef, name: &str) -> Option<String> {
            let attr = NSString::from_str(name);
            let mut value: CFTypeRef = std::ptr::null();
            let err = AXUIElementCopyAttributeValue(
                element,
                objc2::rc::Retained::as_ptr(&attr) as CFStringRef,
                &mut value,
            );
            if err != 0 || value.is_null() {
                return None;
            }
            let text = if CFGetTypeID(value) == CFStringGetTypeID() {
                let s: &NSString = &*(value as *const NSString);
                Some(s.to_string())
            } else {
                None
            };
            CFRelease(value);
            text
        }

        let Some(pid) = snapshot.pid else {
            return FocusField::Unknown;
        };
        unsafe {
            if !AXIsProcessTrusted() {
                return FocusField::Unknown;
            }
            let app = AXUIElementCreateApplication(pid as i32);
            if app.is_null() {
                return FocusField::Unknown;
            }
            AXUIElementSetMessagingTimeout(app, 0.05);
            let focused_attr = NSString::from_str(kAXFocusedUIElementAttribute);
            let mut focused: CFTypeRef = std::ptr::null();
            let err = AXUIElementCopyAttributeValue(
                app,
                objc2::rc::Retained::as_ptr(&focused_attr) as CFStringRef,
                &mut focused,
            );
            CFRelease(app as CFTypeRef);
            if err == kAXErrorNoValue {
                return FocusField::NotEditable;
            }
            if err != 0 || focused.is_null() {
                return FocusField::Unknown;
            }
            let element = focused as AXUIElementRef;
            // The app's timeout doesn't carry over to elements it returns.
            AXUIElementSetMessagingTimeout(element, 0.05);
            let role = string_attr(element, kAXRoleAttribute);
            let subrole = string_attr(element, kAXSubroleAttribute);
            let value_attr = NSString::from_str(kAXValueAttribute);
            let mut settable = false;
            let settable_err = AXUIElementIsAttributeSettable(
                element,
                objc2::rc::Retained::as_ptr(&value_attr) as CFStringRef,
                &mut settable,
            );
            CFRelease(focused);
            let Some(role) = role else {
                return FocusField::Unknown;
            };
            ax_field_kind(&role, subrole.as_deref(), settable_err == 0 && settable)
        }
    }

    pub fn password_check(_timeout: Duration) -> PasswordCheck {
        // Secure event input is on while a secure text field has focus.
        if unsafe { IsSecureEventInputEnabled() } != 0 {
            PasswordCheck::Password
        } else {
            PasswordCheck::NotPassword
        }
    }

    pub fn focus(_window_id: Option<&str>, pid: Option<u32>) -> bool {
        let Some(pid) = pid else { return false };
        let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32)
        else {
            return false;
        };
        if app.isTerminated() {
            return false;
        }
        let ok = app.activateWithOptions(NSApplicationActivationOptions::empty());
        if ok {
            std::thread::sleep(Duration::from_millis(200));
        }
        ok
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod platform {
    use super::*;

    pub fn identity() -> TargetSnapshot {
        let mut snapshot = TargetSnapshot::unresolved("other");
        snapshot.error = Some("app identity is not supported on this platform".into());
        snapshot
    }

    pub fn password_check(_timeout: Duration) -> PasswordCheck {
        PasswordCheck::Unsupported
    }

    pub fn field_check(_snapshot: &TargetSnapshot, _timeout: Duration) -> FocusField {
        FocusField::Unknown
    }

    pub fn focus(_window_id: Option<&str>, _pid: Option<u32>) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_from_paths() {
        assert_eq!(
            file_name_lower(r"C:\Program Files\1Password\1Password.exe"),
            "1password.exe"
        );
        assert_eq!(
            display_name_from_path(r"C:\Program Files\1Password\1Password.exe"),
            "1Password"
        );
        assert_eq!(
            display_name_from_path("/Applications/Bitwarden.app/Contents/MacOS/Bitwarden"),
            "Bitwarden"
        );
    }

    /// Reads the real foreground app; run by hand with `--ignored` on a
    /// desktop session. Prints no title.
    #[test]
    #[ignore]
    fn live_capture_smoke() {
        let mut snapshot = sample_identity();
        run_password_check(&mut snapshot);
        println!(
            "resolved={} self={} samples={} identity_ms={:.2} check={:?} check_ms={:.2} title_present={} class={:?} higher_integrity={:?}",
            snapshot.resolved,
            snapshot.is_self,
            snapshot.samples,
            snapshot.identity_ms,
            snapshot.password_check,
            snapshot.password_check_ms,
            snapshot.title.is_some(),
            snapshot.window_class,
            snapshot.higher_integrity
        );
        // A second check reuses the warm UI Automation worker.
        let mut again = sample_identity();
        run_password_check(&mut again);
        println!("warm check={:?} check_ms={:.2}", again.password_check, again.password_check_ms);
    }

    fn seen(window: Option<&str>, pid: Option<u32>) -> TargetSnapshot {
        let mut s = TargetSnapshot::unresolved("windows");
        s.resolved = true;
        s.window_id = window.map(str::to_string);
        s.pid = pid;
        s
    }

    fn bound(window: Option<&str>, pid: Option<u32>) -> PasteBinding {
        PasteBinding {
            window_id: window.map(str::to_string),
            pid,
        }
    }

    #[test]
    fn paste_binding_allows_the_same_window() {
        let b = bound(Some("4242"), Some(7));
        assert_eq!(
            check_paste_binding(&b, &seen(Some("4242"), Some(7)), PasswordCheck::NotPassword),
            Ok(())
        );
    }

    #[test]
    fn paste_binding_refuses_another_window_or_process() {
        let b = bound(Some("4242"), Some(7));
        let refused = Err(PasteRefusal::TargetChanged);
        // Another window of the same app.
        assert_eq!(check_paste_binding(&b, &seen(Some("99"), Some(7)), PasswordCheck::NotPassword), refused);
        // A reused handle now owned by another process.
        assert_eq!(check_paste_binding(&b, &seen(Some("4242"), Some(8)), PasswordCheck::NotPassword), refused);
        // Nothing readable in front (UAC, lock screen).
        assert_eq!(check_paste_binding(&b, &TargetSnapshot::unresolved("windows"), PasswordCheck::NotPassword), refused);
        // VoiceFlow itself came to the front.
        let mut me = seen(Some("4242"), Some(7));
        me.is_self = true;
        assert_eq!(check_paste_binding(&b, &me, PasswordCheck::NotPassword), refused);
    }

    #[test]
    fn paste_binding_with_nothing_to_compare_fails_closed() {
        let b = bound(None, None);
        assert_eq!(
            check_paste_binding(&b, &seen(Some("1"), Some(1)), PasswordCheck::NotPassword),
            Err(PasteRefusal::TargetChanged)
        );
        // macOS binds by process only (no window handle).
        let mac = bound(None, Some(31));
        assert_eq!(check_paste_binding(&mac, &seen(None, Some(31)), PasswordCheck::NotPassword), Ok(()));
        assert_eq!(
            check_paste_binding(&mac, &seen(None, Some(32)), PasswordCheck::NotPassword),
            Err(PasteRefusal::TargetChanged)
        );
    }

    #[test]
    fn paste_binding_rechecks_the_password_field() {
        let now = seen(Some("5"), Some(5));
        let b = bound(Some("5"), Some(5));
        assert_eq!(
            check_paste_binding(&b, &now, PasswordCheck::Password),
            Err(PasteRefusal::PasswordField)
        );
    }

    /// 0.9.11: the 0.9.10 false "Not pasted" (Kite): the same window, a check
    /// that couldn't answer. That now pastes; the text stays on the clipboard.
    #[test]
    fn paste_binding_lets_an_unanswered_check_through() {
        let now = seen(Some("5"), Some(5));
        let b = bound(Some("5"), Some(5));
        for inconclusive in [
            PasswordCheck::Unknown,
            PasswordCheck::Unavailable,
            PasswordCheck::TimedOut,
            PasswordCheck::Unsupported,
            PasswordCheck::NotChecked,
        ] {
            assert_eq!(check_paste_binding(&b, &now, inconclusive), Ok(()));
            assert_eq!(check_paste_binding_around(&b, &now, inconclusive, &now), Ok(()));
        }
    }

    #[test]
    fn a_transient_check_is_retried_and_a_lasting_one_is_not() {
        // Unknown, then a real answer: two tries, the real answer counts.
        let mut answers = vec![PasswordCheck::Password, PasswordCheck::Unknown];
        let mut pauses = 0;
        let (result, tries) =
            settle_password_check(|| answers.pop().unwrap(), 2, || pauses += 1);
        assert_eq!((result, tries, pauses), (PasswordCheck::Password, 2, 1));
        // Always timed out: one try and two retries, then it counts.
        let (result, tries) = settle_password_check(|| PasswordCheck::TimedOut, 2, || {});
        assert_eq!((result, tries), (PasswordCheck::TimedOut, 3));
        // Unavailable is lasting: no retry.
        let (result, tries) = settle_password_check(|| PasswordCheck::Unavailable, 2, || {});
        assert_eq!((result, tries), (PasswordCheck::Unavailable, 1));
    }

    #[test]
    fn the_refusal_log_line_names_the_failed_step_and_never_the_title() {
        let b = bound(Some("4242"), Some(7));
        let mut editor = seen(Some("4242"), Some(7));
        editor.title = Some("secret plans - Notepad".into());
        editor.exe_name = Some("notepad.exe".into());
        let mut other = seen(Some("99"), Some(9));
        other.title = Some("another title".into());
        let line = refusal_detail(&b, &editor, PasswordCheck::NotPassword, Some(&other));
        assert!(line.contains("failed=window after the check"), "{line}");
        assert!(line.contains("exe=notepad.exe"), "{line}");
        assert!(!line.contains("secret") && !line.contains("another title"), "{line}");
        let line = refusal_detail(&b, &editor, PasswordCheck::Password, Some(&editor));
        assert!(line.contains("failed=password check"), "{line}");
        let line = refusal_detail(&b, &other, PasswordCheck::NotChecked, None);
        assert!(line.contains("failed=window before the check"), "{line}");
    }

    #[test]
    fn paste_binding_catches_a_switch_during_the_password_check() {
        let b = bound(Some("4242"), Some(7));
        let editor = seen(Some("4242"), Some(7));
        let manager = seen(Some("777"), Some(9));
        assert_eq!(
            check_paste_binding_around(&b, &editor, PasswordCheck::NotPassword, &editor),
            Ok(())
        );
        // Switched to another app while the field was being checked.
        assert_eq!(
            check_paste_binding_around(&b, &editor, PasswordCheck::NotPassword, &manager),
            Err(PasteRefusal::TargetChanged)
        );
        // The password answer still counts when the window stayed.
        assert_eq!(
            check_paste_binding_around(&b, &editor, PasswordCheck::Password, &editor),
            Err(PasteRefusal::PasswordField)
        );
        // Nothing readable afterwards (UAC, lock screen): refused.
        assert_eq!(
            check_paste_binding_around(
                &b,
                &editor,
                PasswordCheck::NotPassword,
                &TargetSnapshot::unresolved("windows")
            ),
            Err(PasteRefusal::TargetChanged)
        );
    }

    #[test]
    fn paste_binding_parses_from_the_frontend() {
        let b: PasteBinding =
            serde_json::from_str(r#"{"windowId":"123","pid":9,"strict":true}"#).unwrap();
        // A 0.9.10 page's `strict` is ignored.
        assert_eq!(b.window_id.as_deref(), Some("123"));
        assert_eq!(b.pid, Some(9));
        assert_eq!(
            serde_json::to_string(&PasteRefusal::TargetChanged).unwrap(),
            "\"target-changed\""
        );
    }

    /// Times the paste-time re-check on the real foreground app (read only:
    /// no keystroke, no clipboard). Run by hand with `--ignored`.
    #[test]
    #[ignore]
    fn live_paste_guard_timing() {
        let first = platform::identity();
        let b = PasteBinding {
            window_id: first.window_id.clone(),
            pid: first.pid,
        };
        let _ = verify_paste_binding(&b); // warms the UI Automation worker
        let mut ms: Vec<f64> = (0..30)
            .map(|_| {
                let t = Instant::now();
                let _ = verify_paste_binding(&b);
                t.elapsed().as_secs_f64() * 1000.0
            })
            .collect();
        ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
        println!(
            "paste_guard_ms p50={:.2} p90={:.2} max={:.2} result={:?}",
            ms[15],
            ms[27],
            ms[29],
            verify_paste_binding(&b)
        );
    }

    #[test]
    fn the_field_check_is_asked_only_in_explorer_and_finder() {
        let mut explorer = seen(Some("1"), Some(1));
        explorer.exe_name = Some("explorer.exe".into());
        assert!(field_check_applies(&explorer));
        let mut excel = explorer.clone();
        excel.exe_name = Some("excel.exe".into());
        assert!(!field_check_applies(&excel));
        let mut unresolved = explorer.clone();
        unresolved.resolved = false;
        assert!(!field_check_applies(&unresolved));
        let mut finder = TargetSnapshot::unresolved("macos");
        finder.resolved = true;
        finder.bundle_id = Some("com.apple.finder".into());
        assert!(field_check_applies(&finder));
        finder.bundle_id = Some("com.apple.TextEdit".into());
        assert!(!field_check_applies(&finder));
    }

    #[test]
    fn mac_text_roles_take_text_and_others_do_not() {
        for role in ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"] {
            assert_eq!(ax_field_kind(role, None, false), FocusField::Editable, "{role}");
        }
        assert_eq!(ax_field_kind("AXTextField", Some("AXSearchField"), false), FocusField::Editable);
        assert_eq!(ax_field_kind("AXGroup", None, true), FocusField::Editable);
        for role in ["AXOutline", "AXList", "AXRow", "AXScrollArea", "AXGroup", "AXButton"] {
            assert_eq!(ax_field_kind(role, None, false), FocusField::NotEditable, "{role}");
        }
        assert_eq!(serde_json::to_string(&FocusField::NotEditable).unwrap(), "\"not-editable\"");
    }

    #[test]
    fn password_check_serializes_as_kebab_case() {
        assert_eq!(
            serde_json::to_string(&PasswordCheck::TimedOut).unwrap(),
            "\"timed-out\""
        );
        assert_eq!(
            serde_json::to_string(&PasswordCheck::NotPassword).unwrap(),
            "\"not-password\""
        );
    }
}

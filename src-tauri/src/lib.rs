use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::path::BaseDirectory;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    image::Image, menu::MenuBuilder, AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl,
    RunEvent, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_shell::ShellExt;

const COMMANDS: [&str; 4] = ["daily", "monthly", "session", "blocks"];
const SIDECAR_NAME: &str = "ccusage-runner";
const TRAY_ID: &str = "usage-deck-tray";
const TRAY_PANEL_LABEL: &str = "tray-panel";
const TRAY_SETTINGS_FILE: &str = "tray-indicator-settings.json";
const TRAY_SETTINGS_CHANGED_EVENT: &str = "tray-settings-changed";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageCollection {
    requested_source_mode: String,
    effective_source_mode: String,
    runner_label: String,
    ccusage_version: Option<String>,
    diagnostics: Vec<Diagnostic>,
    reports: Vec<CommandReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic {
    severity: String,
    code: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommandReport {
    command: String,
    ok: bool,
    exit_code: Option<i32>,
    stdout: Option<Value>,
    stderr: String,
    classification: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayIndicatorSummary {
    enabled: bool,
    bars: Vec<TrayIndicatorBar>,
    tooltip: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrayIndicatorBar {
    label: String,
    period: String,
    color: String,
    used_value: f64,
    budget_value: f64,
    budget_type: String,
    ratio: f64,
    budget_source: String,
}

#[derive(Debug)]
struct Runner {
    kind: RunnerKind,
    label: String,
    mode: String,
}

#[derive(Debug)]
struct TrayRuntimeState {
    enabled: Mutex<bool>,
}

impl TrayRuntimeState {
    fn new(enabled: bool) -> Self {
        Self {
            enabled: Mutex::new(enabled),
        }
    }

    fn set_enabled(&self, enabled: bool) {
        if let Ok(mut current) = self.enabled.lock() {
            *current = enabled;
        }
    }

    fn is_enabled(&self) -> bool {
        self.enabled.lock().map(|current| *current).unwrap_or(true)
    }
}

#[derive(Debug)]
enum RunnerKind {
    Sidecar,
    Process {
        program: String,
        prefix_args: Vec<String>,
    },
}

#[tauri::command]
async fn collect_usage(app: AppHandle, source_mode: String) -> UsageCollection {
    let requested = normalize_source_mode(&source_mode);
    let mut diagnostics = Vec::new();
    let runner = resolve_runner(&app, &requested, &mut diagnostics).await;

    let mut reports = Vec::new();
    let version = if let Some(runner) = runner.as_ref() {
        run_version(&app, runner, &mut diagnostics).await
    } else {
        None
    };

    if let Some(runner) = runner {
        for command in COMMANDS {
            reports.push(run_report(&app, &runner, command).await);
        }

        UsageCollection {
            requested_source_mode: requested,
            effective_source_mode: runner.mode,
            runner_label: runner.label,
            ccusage_version: version,
            diagnostics,
            reports,
        }
    } else {
        UsageCollection {
            requested_source_mode: requested,
            effective_source_mode: "unavailable".to_string(),
            runner_label: "No ccusage runner".to_string(),
            ccusage_version: None,
            diagnostics,
            reports,
        }
    }
}

#[tauri::command]
async fn update_tray_indicator(app: AppHandle, summary: TrayIndicatorSummary) -> Result<(), String> {
    set_tray_runtime_enabled(&app, summary.enabled);

    if !summary.enabled {
        close_tray_panel(&app);
        remove_tray_icon(&app)?;
        return Ok(());
    }

    if app.tray_by_id(TRAY_ID).is_none() {
        setup_tray_icon(&app, &summary).map_err(|error| format!("Failed to create tray icon: {error}"))?;
        return Ok(());
    }

    let tooltip = tray_tooltip(&summary);

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let icon = render_tray_icon(&summary);
        tray.set_icon(Some(icon))
            .map_err(|error| format!("Failed to update tray icon: {error}"))?;
        tray.set_tooltip(Some(tooltip.as_str()))
            .map_err(|error| format!("Failed to update tray tooltip: {error}"))?;
    }

    Ok(())
}

#[tauri::command]
fn load_tray_settings(app: AppHandle) -> Result<Option<Value>, String> {
    let path = tray_settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&path).map_err(|error| format!("Failed to read tray settings: {error}"))?;
    let settings = serde_json::from_str(&raw).map_err(|error| format!("Failed to parse tray settings: {error}"))?;
    Ok(Some(settings))
}

#[tauri::command]
fn save_tray_settings(app: AppHandle, settings: Value) -> Result<(), String> {
    if let Some(enabled) = settings.get("enabled").and_then(Value::as_bool) {
        set_tray_runtime_enabled(&app, enabled);
        if enabled {
            if app.tray_by_id(TRAY_ID).is_none() {
                let summary = default_tray_summary();
                setup_tray_icon(&app, &summary).map_err(|error| format!("Failed to create tray icon: {error}"))?;
            }
        } else {
            close_tray_panel(&app);
            remove_tray_icon(&app)?;
        }
    }

    let path = tray_settings_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Failed to create tray settings directory: {error}"))?;
    }

    let raw = serde_json::to_string_pretty(&settings).map_err(|error| format!("Failed to serialize tray settings: {error}"))?;
    let temporary_path = path.with_file_name(format!("{TRAY_SETTINGS_FILE}.tmp"));
    fs::write(&temporary_path, raw).map_err(|error| format!("Failed to write tray settings: {error}"))?;
    fs::rename(&temporary_path, &path).map_err(|error| format!("Failed to store tray settings: {error}"))?;
    app.emit(TRAY_SETTINGS_CHANGED_EVENT, settings)
        .map_err(|error| format!("Failed to notify tray settings change: {error}"))?;
    Ok(())
}

fn tray_settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve(TRAY_SETTINGS_FILE, BaseDirectory::AppConfig)
        .map_err(|error| format!("Failed to resolve tray settings path: {error}"))
}

fn remove_tray_icon(app: &AppHandle) -> Result<(), String> {
    let _removed_tray = app.remove_tray_by_id(TRAY_ID);
    Ok(())
}

fn close_tray_panel(app: &AppHandle) {
    if let Some(panel) = app.get_webview_window(TRAY_PANEL_LABEL) {
        let _ = panel.close();
    }
}

fn cleanup_tray_before_exit(app: &AppHandle) {
    close_tray_panel(app);
    set_tray_runtime_enabled(app, false);
    let _ = remove_tray_icon(app);
}

fn request_app_exit(app: &AppHandle, code: i32) {
    cleanup_tray_before_exit(app);
    app.exit(code);
}

#[tauri::command]
async fn show_dashboard(app: AppHandle) -> Result<(), String> {
    show_dashboard_window(&app)
}

fn show_dashboard_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }

    if let Some(panel) = app.get_webview_window(TRAY_PANEL_LABEL) {
        let _ = panel.hide();
    }

    Ok(())
}

#[tauri::command]
async fn hide_tray_panel(app: AppHandle) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window(TRAY_PANEL_LABEL) {
        panel.hide().map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn normalize_source_mode(source_mode: &str) -> String {
    match source_mode {
        "system" => "system".to_string(),
        "mock" => "mock".to_string(),
        _ => "bundled".to_string(),
    }
}

async fn resolve_runner(app: &AppHandle, mode: &str, diagnostics: &mut Vec<Diagnostic>) -> Option<Runner> {
    if mode == "system" {
        return Some(Runner {
            kind: RunnerKind::Process {
                program: "ccusage".to_string(),
                prefix_args: Vec::new(),
            },
            label: "System ccusage from PATH".to_string(),
            mode: "system".to_string(),
        });
    }

    if mode == "mock" {
        diagnostics.push(Diagnostic {
            severity: "info".to_string(),
            code: "mock-selected".to_string(),
            message: "Mock mode is handled in the UI without invoking ccusage.".to_string(),
        });
        return None;
    }

    if let Ok(explicit) = std::env::var("USAGE_DECK_CCUSAGE_RUNNER") {
        if !explicit.trim().is_empty() {
            return Some(Runner {
                kind: RunnerKind::Process {
                    program: explicit,
                    prefix_args: Vec::new(),
                },
                label: "Bundled ccusage sidecar from USAGE_DECK_CCUSAGE_RUNNER".to_string(),
                mode: "bundled".to_string(),
            });
        }
    }

    let sidecar = Runner {
        kind: RunnerKind::Sidecar,
        label: "Bundled ccusage sidecar".to_string(),
        mode: "bundled".to_string(),
    };
    match run_process(app, &sidecar, &["--version".to_string()]).await {
        Ok((_, _, Some(0))) => return Some(sidecar),
        Ok((stdout, stderr, status)) => diagnostics.push(Diagnostic {
            severity: "warning".to_string(),
            code: "sidecar-version-check-failed".to_string(),
            message: format!(
                "Bundled ccusage sidecar did not pass version check with exit {:?}: {}{}",
                status, stdout, stderr
            ),
        }),
        Err(message) => diagnostics.push(Diagnostic {
            severity: "warning".to_string(),
            code: "sidecar-unavailable".to_string(),
            message,
        }),
    }

    if let Some(program) = find_packaged_sidecar_runner(app) {
        let runner = Runner {
            kind: RunnerKind::Process {
                program: program.to_string_lossy().to_string(),
                prefix_args: Vec::new(),
            },
            label: "Bundled ccusage sidecar from packaged app path".to_string(),
            mode: "bundled".to_string(),
        };

        match run_process(app, &runner, &["--version".to_string()]).await {
            Ok((_, _, Some(0))) => return Some(runner),
            Ok((stdout, stderr, status)) => diagnostics.push(Diagnostic {
                severity: "warning".to_string(),
                code: "packaged-sidecar-version-check-failed".to_string(),
                message: format!(
                    "Packaged ccusage sidecar did not pass version check with exit {:?}: {}{}",
                    status, stdout, stderr
                ),
            }),
            Err(message) => diagnostics.push(Diagnostic {
                severity: "warning".to_string(),
                code: "packaged-sidecar-unavailable".to_string(),
                message,
            }),
        }
    }

    if let Some(script) = find_internal_node_runner(app) {
        return Some(Runner {
            kind: RunnerKind::Process {
                program: "node".to_string(),
                prefix_args: vec![script.to_string_lossy().to_string()],
            },
            label: "Pinned ccusage 20.0.11 via internal Node runner".to_string(),
            mode: "bundled".to_string(),
        });
    }

    diagnostics.push(Diagnostic {
        severity: "error".to_string(),
        code: "bundled-runner-missing".to_string(),
        message: "Bundled ccusage runner was not found. Use mock mode or rebuild the platform sidecar.".to_string(),
    });
    None
}

fn find_packaged_sidecar_runner(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join(SIDECAR_NAME));
        }
    }

    if let Ok(appdir) = std::env::var("APPDIR") {
        let appdir = PathBuf::from(appdir);
        candidates.push(appdir.join("usr/bin").join(SIDECAR_NAME));
    }

    if let Ok(resource_dir) = app.path().resolve("", BaseDirectory::Resource) {
        candidates.push(resource_dir.join(SIDECAR_NAME));
        candidates.push(resource_dir.join("_up_").join(SIDECAR_NAME));
        if let Some(usr_dir) = resource_dir.parent().and_then(|lib_dir| lib_dir.parent()) {
            candidates.push(usr_dir.join("bin").join(SIDECAR_NAME));
        }
    }

    #[cfg(target_os = "linux")]
    candidates.push(PathBuf::from("/usr/bin").join(SIDECAR_NAME));

    candidates.into_iter().find(|path| path.is_file())
}

fn find_internal_node_runner(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resolve("", BaseDirectory::Resource) {
        candidates.push(resource_dir.join("resources/ccusage-runner/run-ccusage.mjs"));
        candidates.push(resource_dir.join("ccusage-runner/run-ccusage.mjs"));
        candidates.push(resource_dir.join("_up_/resources/ccusage-runner/run-ccusage.mjs"));
    }

    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../resources/ccusage-runner/run-ccusage.mjs"));

    candidates.into_iter().find(|path| path.is_file())
}

async fn run_version(app: &AppHandle, runner: &Runner, diagnostics: &mut Vec<Diagnostic>) -> Option<String> {
    let output = run_process(app, runner, &["--version".to_string()]).await;
    match output {
        Ok((stdout, _stderr, status)) if status == Some(0) => {
            let version = stdout.trim();
            if version.is_empty() {
                None
            } else {
                Some(version.to_string())
            }
        }
        Ok((stdout, stderr, status)) => {
            diagnostics.push(Diagnostic {
                severity: "warning".to_string(),
                code: "version-check-failed".to_string(),
                message: format!(
                    "ccusage version check failed with exit {:?}: {}{}",
                    status, stdout, stderr
                ),
            });
            None
        }
        Err(message) => {
            diagnostics.push(Diagnostic {
                severity: "error".to_string(),
                code: classify_error(&message).to_string(),
                message,
            });
            None
        }
    }
}

async fn run_report(app: &AppHandle, runner: &Runner, command: &str) -> CommandReport {
    let args = vec![command.to_string(), "--json".to_string()];

    match run_process(app, runner, &args).await {
        Ok((stdout, stderr, status)) => {
            if status != Some(0) {
                let classification = classify_failure_text(&stdout, &stderr).to_string();
                return CommandReport {
                    command: command.to_string(),
                    ok: false,
                    exit_code: status,
                    stdout: None,
                    stderr,
                    classification: Some(classification),
                };
            }

            match serde_json::from_str::<Value>(&stdout) {
                Ok(value) => CommandReport {
                    command: command.to_string(),
                    ok: true,
                    exit_code: status,
                    stdout: Some(value),
                    stderr,
                    classification: None,
                },
                Err(error) => CommandReport {
                    command: command.to_string(),
                    ok: false,
                    exit_code: status,
                    stdout: None,
                    stderr: format!("JSON parse failed: {error}. Raw output: {stdout}\n{stderr}"),
                    classification: Some("json-parse-failed".to_string()),
                },
            }
        }
        Err(message) => CommandReport {
            command: command.to_string(),
            ok: false,
            exit_code: None,
            stdout: None,
            stderr: message.clone(),
            classification: Some(classify_error(&message).to_string()),
        },
    }
}

async fn run_process(app: &AppHandle, runner: &Runner, args: &[String]) -> Result<(String, String, Option<i32>), String> {
    match &runner.kind {
        RunnerKind::Sidecar => {
            let output = app
                .shell()
                .sidecar(SIDECAR_NAME)
                .map_err(|error| format!("Failed to resolve bundled ccusage sidecar: {error}"))?
                .args(args)
                .env("FORCE_COLOR", "0")
                .env("NO_COLOR", "1")
                .output()
                .await
                .map_err(|error| format!("Failed to execute {}: {error}", runner.label))?;

            Ok((
                String::from_utf8_lossy(&output.stdout).to_string(),
                String::from_utf8_lossy(&output.stderr).to_string(),
                output.status.code(),
            ))
        }
        RunnerKind::Process {
            program,
            prefix_args,
        } => {
            let mut command = Command::new(program);
            command
                .args(prefix_args)
                .args(args)
                .env("FORCE_COLOR", "0")
                .env("NO_COLOR", "1");
            #[cfg(target_os = "windows")]
            command.creation_flags(CREATE_NO_WINDOW);

            let output = command
                .output()
                .map_err(|error| format!("Failed to execute {}: {error}", runner.label))?;

            Ok((
                String::from_utf8_lossy(&output.stdout).to_string(),
                String::from_utf8_lossy(&output.stderr).to_string(),
                output.status.code(),
            ))
        }
    }
}

fn classify_error(message: &str) -> &'static str {
    let lower = message.to_lowercase();
    if lower.contains("not found") || lower.contains("no such file") || lower.contains("failed to execute") {
        "runner-execution-failed"
    } else {
        "runner-error"
    }
}

fn classify_failure_text(stdout: &str, stderr: &str) -> &'static str {
    let text = format!("{stdout}\n{stderr}").to_lowercase();
    if text.contains("no usage") || text.contains("no data") || text.contains("not found") {
        "usage-data-not-found"
    } else {
        "ccusage-command-failed"
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_dashboard_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            apply_main_window_icon(app);
            setup_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }

            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if tray_enabled(&app) {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    api.prevent_close();
                    request_app_exit(&app, 0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            collect_usage,
            update_tray_indicator,
            load_tray_settings,
            save_tray_settings,
            show_dashboard,
            hide_tray_panel
        ])
        .build(tauri::generate_context!())
        .expect("error while building Usage Deck")
        .run(|app, event| match event {
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                cleanup_tray_before_exit(app);
            }
            _ => {}
        });
}

fn apply_main_window_icon(app: &mut tauri::App) {
    let icon = app.default_window_icon().cloned();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if let Some(icon) = icon {
        let _ = window.set_icon(icon);
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let _ = window.set_skip_taskbar(false);
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let enabled = stored_tray_enabled(app).unwrap_or(true);
    app.manage(TrayRuntimeState::new(enabled));

    if !enabled {
        return Ok(());
    }

    setup_tray_icon(app, &default_tray_summary())
}

fn stored_tray_enabled(app: &tauri::App) -> Option<bool> {
    stored_tray_enabled_from_handle(app.handle())
}

fn stored_tray_enabled_from_handle(app: &AppHandle) -> Option<bool> {
    let path = tray_settings_path(app).ok()?;
    let raw = fs::read_to_string(path).ok()?;
    let settings = serde_json::from_str::<Value>(&raw).ok()?;
    settings.get("enabled").and_then(Value::as_bool)
}

fn tray_enabled(app: &AppHandle) -> bool {
    let runtime_enabled = app
        .try_state::<TrayRuntimeState>()
        .map(|state| state.is_enabled())
        .unwrap_or_else(|| stored_tray_enabled_from_handle(app).unwrap_or(true));
    runtime_enabled && app.tray_by_id(TRAY_ID).is_some()
}

fn set_tray_runtime_enabled(app: &AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<TrayRuntimeState>() {
        state.set_enabled(enabled);
    }
}

fn setup_tray_icon<M: Manager<tauri::Wry>>(manager: &M, summary: &TrayIndicatorSummary) -> tauri::Result<()> {
    let menu = MenuBuilder::new(manager)
        .text("quick_panel", "Quick Panel")
        .text("open_dashboard", "Open Dashboard")
        .separator()
        .text("quit", "Quit")
        .build()?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(render_tray_icon(summary))
        .icon_as_template(false)
        .tooltip(tray_tooltip(summary))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quick_panel" => {
                let _ = toggle_tray_panel(app);
            }
            "open_dashboard" => {
                let _ = show_dashboard_window(app);
            }
            "quit" => {
                request_app_exit(app, 0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let _ = toggle_tray_panel(app);
            }
        })
        .build(manager)?;

    Ok(())
}

fn toggle_tray_panel(app: &AppHandle) -> tauri::Result<()> {
    if let Some(panel) = app.get_webview_window(TRAY_PANEL_LABEL) {
        if panel.is_visible()? {
            panel.hide()?;
        } else {
            panel.show()?;
            panel.set_focus()?;
        }
        return Ok(());
    }

    let panel = WebviewWindowBuilder::new(
        app,
        TRAY_PANEL_LABEL,
        WebviewUrl::App("index.html?panel=tray".into()),
    )
    .title("Usage Deck")
    .inner_size(360.0, 360.0)
    .min_inner_size(320.0, 300.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(true)
    .visible(false)
    .build()?;

    position_tray_panel(&panel)?;
    panel.show()?;
    panel.set_focus()?;

    Ok(())
}

fn position_tray_panel(panel: &WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = panel.current_monitor()?.or(panel.primary_monitor()?) else {
        return Ok(());
    };
    let work_area = monitor.work_area();
    let panel_size = panel.outer_size()?;
    let margin = (18.0 * monitor.scale_factor()).round() as i32;
    let x = work_area.position.x + work_area.size.width as i32 - panel_size.width as i32 - margin;
    let y = work_area.position.y + work_area.size.height as i32 - panel_size.height as i32 - margin;

    panel.set_position(PhysicalPosition::new(x.max(work_area.position.x), y.max(work_area.position.y)))?;
    Ok(())
}

fn default_tray_summary() -> TrayIndicatorSummary {
    TrayIndicatorSummary {
        enabled: true,
        tooltip: "Usage Deck".to_string(),
        bars: vec![TrayIndicatorBar {
            label: "Usage".to_string(),
            period: "week".to_string(),
            color: "#8AB4FF".to_string(),
            used_value: 0.0,
            budget_value: 0.0,
            budget_type: "tokens".to_string(),
            ratio: 0.0,
            budget_source: "relative".to_string(),
        }],
    }
}

fn render_tray_icon(summary: &TrayIndicatorSummary) -> Image<'static> {
    const WIDTH: u32 = 64;
    const HEIGHT: u32 = 64;

    let mut rgba = vec![0; (WIDTH * HEIGHT * 4) as usize];
    let bars = active_tray_bars(summary);

    #[cfg(target_os = "macos")]
    render_macos_tray_icon(&mut rgba, WIDTH, HEIGHT, &bars);

    #[cfg(all(unix, not(target_os = "macos")))]
    render_linux_tray_icon(&mut rgba, WIDTH, HEIGHT, &bars);

    #[cfg(not(any(target_os = "macos", all(unix, not(target_os = "macos")))))]
    render_windows_tray_icon(&mut rgba, WIDTH, HEIGHT, &bars);

    Image::new_owned(rgba, WIDTH, HEIGHT)
}

fn active_tray_bars(summary: &TrayIndicatorSummary) -> Vec<&TrayIndicatorBar> {
    if summary.enabled {
        summary.bars.iter().take(2).collect()
    } else {
        Vec::new()
    }
}

#[cfg(not(any(target_os = "macos", all(unix, not(target_os = "macos")))))]
fn render_windows_tray_icon(rgba: &mut [u8], width: u32, height: u32, bars: &[&TrayIndicatorBar]) {
    draw_rounded_rect(rgba, width, height, 4, 9, 56, 46, 8, [13, 17, 21, 255]);
    draw_rounded_rect(rgba, width, height, 5, 10, 54, 44, 7, [52, 60, 69, 255]);
    draw_rounded_rect(rgba, width, height, 7, 12, 50, 40, 6, [20, 25, 31, 255]);

    if bars.is_empty() {
        draw_rounded_rect(rgba, width, height, 14, 29, 36, 6, 3, [62, 72, 82, 255]);
        return;
    }

    if bars.len() == 1 {
        draw_bar(rgba, width, height, 10, 24, 44, 16, bars[0]);
    } else {
        draw_bar(rgba, width, height, 10, 17, 44, 12, bars[0]);
        draw_bar(rgba, width, height, 10, 35, 44, 12, bars[1]);
    }
}

#[cfg(target_os = "macos")]
fn render_macos_tray_icon(rgba: &mut [u8], width: u32, height: u32, bars: &[&TrayIndicatorBar]) {
    if bars.is_empty() {
        draw_rounded_rect(rgba, width, height, 8, 28, 48, 8, 4, [126, 136, 148, 190]);
        return;
    }

    if bars.len() == 1 {
        draw_bar(rgba, width, height, 3, 18, 58, 28, bars[0]);
    } else {
        draw_bar(rgba, width, height, 3, 9, 58, 20, bars[0]);
        draw_bar(rgba, width, height, 3, 35, 58, 20, bars[1]);
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn render_linux_tray_icon(rgba: &mut [u8], width: u32, height: u32, bars: &[&TrayIndicatorBar]) {
    draw_rounded_rect(rgba, width, height, 6, 12, 52, 40, 10, [13, 17, 21, 230]);
    draw_rounded_rect(rgba, width, height, 7, 13, 50, 38, 9, [57, 65, 74, 180]);
    draw_rounded_rect(rgba, width, height, 9, 15, 46, 34, 8, [19, 24, 30, 235]);

    if bars.is_empty() {
        draw_rounded_rect(rgba, width, height, 14, 29, 36, 6, 3, [89, 98, 109, 220]);
        return;
    }

    if bars.len() == 1 {
        draw_bar(rgba, width, height, 10, 24, 44, 16, bars[0]);
    } else {
        draw_bar(rgba, width, height, 10, 17, 44, 12, bars[0]);
        draw_bar(rgba, width, height, 10, 35, 44, 12, bars[1]);
    }
}

fn tray_tooltip(summary: &TrayIndicatorSummary) -> String {
    if !summary.tooltip.trim().is_empty() {
        return summary.tooltip.clone();
    }

    if !summary.enabled || summary.bars.is_empty() {
        return "Usage Deck".to_string();
    }

    let mut lines = vec!["Usage Deck".to_string()];
    for bar in summary.bars.iter().take(2) {
        let budget = if bar.budget_source == "relative" {
            relative_budget_label(&bar.budget_type)
        } else if bar.budget_value > 0.0 {
            short_budget_value(bar.budget_value, &bar.budget_type)
        } else {
            "-".to_string()
        };
        lines.push(format!(
            "{} {}: {} / {}",
            bar.label,
            bar.period,
            short_budget_value(bar.used_value, &bar.budget_type),
            budget
        ));
    }
    lines.join("\n")
}

fn draw_bar(
    rgba: &mut [u8],
    width: u32,
    height: u32,
    x: u32,
    y: u32,
    bar_width: u32,
    bar_height: u32,
    bar: &TrayIndicatorBar,
) {
    draw_rounded_rect(rgba, width, height, x, y, bar_width, bar_height, bar_height / 2, [255, 255, 255, 230]);

    let inset = if bar_height >= 18 { 4 } else { 3 };
    let inner_width = bar_width.saturating_sub(inset * 2);
    let inner_height = bar_height.saturating_sub(inset * 2);
    if inner_width == 0 || inner_height == 0 {
        return;
    }

    let ratio = bar.ratio.clamp(0.0, 1.0);
    if ratio <= 0.0 {
        return;
    }

    let fill_width = ((inner_width as f64) * ratio).round().max(2.0) as u32;
    let color = parse_hex_color(&bar.color).unwrap_or([111, 183, 168, 255]);
    draw_rounded_rect(
        rgba,
        width,
        height,
        x + inset,
        y + inset,
        fill_width.min(inner_width),
        inner_height,
        inner_height / 2,
        color,
    );
}

fn draw_rounded_rect(
    rgba: &mut [u8],
    image_width: u32,
    image_height: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    radius: u32,
    color: [u8; 4],
) {
    if width == 0 || height == 0 {
        return;
    }

    let right = (x + width).min(image_width);
    let bottom = (y + height).min(image_height);
    let radius = radius.min(width / 2).min(height / 2);

    for py in y..bottom {
        for px in x..right {
            let dx = if px < x + radius {
                x + radius - px
            } else if px >= right.saturating_sub(radius) {
                px - (right - radius - 1)
            } else {
                0
            };
            let dy = if py < y + radius {
                y + radius - py
            } else if py >= bottom.saturating_sub(radius) {
                py - (bottom - radius - 1)
            } else {
                0
            };

            if dx > 0 && dy > 0 && dx * dx + dy * dy > radius * radius {
                continue;
            }

            let offset = ((py * image_width + px) * 4) as usize;
            rgba[offset..offset + 4].copy_from_slice(&color);
        }
    }
}

fn parse_hex_color(value: &str) -> Option<[u8; 4]> {
    let value = value.strip_prefix('#')?;
    if value.len() != 6 {
        return None;
    }

    let red = u8::from_str_radix(&value[0..2], 16).ok()?;
    let green = u8::from_str_radix(&value[2..4], 16).ok()?;
    let blue = u8::from_str_radix(&value[4..6], 16).ok()?;
    Some([red, green, blue, 255])
}

fn short_tokens(value: f64) -> String {
    if value >= 1_000_000.0 {
        format!("{:.1}M", value / 1_000_000.0)
    } else if value >= 1_000.0 {
        format!("{:.0}K", value / 1_000.0)
    } else {
        format!("{:.0}", value)
    }
}

fn short_budget_value(value: f64, budget_type: &str) -> String {
    if budget_type == "cost" {
        short_usd(value)
    } else {
        format!("{} tokens", short_tokens(value))
    }
}

fn short_usd(value: f64) -> String {
    if value >= 1_000.0 {
        format!("${:.1}K", value / 1_000.0)
    } else if value >= 100.0 {
        format!("${:.0}", value)
    } else {
        format!("${:.2}", value)
    }
}

fn relative_budget_label(budget_type: &str) -> String {
    if budget_type == "cost" {
        "relative cost scale".to_string()
    } else {
        "relative token scale".to_string()
    }
}

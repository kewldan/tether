//! `am start` / `am broadcast` / `am startservice`, `input text` and
//! `input keyevent`: argument building with safe quoting and output
//! parsing.

use serde::{Deserialize, Serialize};

use crate::adb::server::AdbServer;
use crate::adb::shell_v2::{self, CommandOutput, join_args};
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentKind {
    Activity,
    Broadcast,
    Service,
    ForegroundService,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtraType {
    String,
    Int,
    Long,
    Float,
    Double,
    Boolean,
    Uri,
    Component,
    StringArray,
    IntArray,
    LongArray,
    FloatArray,
    Null,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Extra {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: ExtraType,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IntentSpec {
    pub action: String,
    pub data: String,
    pub categories: Vec<String>,
    pub component: String,
    pub mime_type: String,
    /// Flag names without the `FLAG_ACTIVITY_` / `FLAG_` prefix
    /// (`NEW_TASK`, `CLEAR_TOP`, …).
    pub flags: Vec<String>,
    pub extras: Vec<Extra>,
}

/// Intent flags offered in the UI, with their values from
/// `android.content.Intent`.
pub const FLAGS: &[(&str, u32)] = &[
    ("NEW_TASK", 0x1000_0000),
    ("CLEAR_TOP", 0x0400_0000),
    ("SINGLE_TOP", 0x2000_0000),
    ("CLEAR_TASK", 0x0000_8000),
    ("NO_HISTORY", 0x4000_0000),
    ("EXCLUDE_FROM_RECENTS", 0x0080_0000),
    ("MULTIPLE_TASK", 0x0800_0000),
    ("NO_ANIMATION", 0x0001_0000),
    ("REORDER_TO_FRONT", 0x0002_0000),
    ("GRANT_READ_URI_PERMISSION", 0x0000_0001),
    ("INCLUDE_STOPPED_PACKAGES", 0x0000_0020),
];

fn flag_value(name: &str) -> AppResult<u32> {
    FLAGS
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, v)| *v)
        .ok_or_else(|| AppError::InvalidInput(format!("unknown intent flag {name}")))
}

fn non_blank(s: &str) -> Option<&str> {
    let s = s.trim();
    (!s.is_empty()).then_some(s)
}

fn check_token(what: &str, value: &str) -> AppResult<()> {
    if value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(AppError::InvalidInput(format!(
            "{what} must not contain spaces: {value:?}"
        )));
    }
    Ok(())
}

/// Elements of a numeric list extra (`1, 2,3`).
fn array_items(value: &str) -> impl Iterator<Item = &str> {
    value.split(',').map(str::trim).filter(|s| !s.is_empty())
}

fn extra_args(extra: &Extra, args: &mut Vec<String>) -> AppResult<()> {
    let key = extra.key.trim();
    if key.is_empty() {
        return Err(AppError::InvalidInput("extra key is empty".into()));
    }
    check_token("extra key", key)?;
    let value = extra.value.trim();
    let invalid = |kind: &str| {
        Err(AppError::InvalidInput(format!(
            "extra {key}: {value:?} is not a valid {kind}"
        )))
    };
    let (flag, value) = match extra.kind {
        ExtraType::String => ("--es", extra.value.clone()),
        ExtraType::Int => match value.parse::<i32>() {
            Ok(_) => ("--ei", value.to_owned()),
            Err(_) => return invalid("int"),
        },
        ExtraType::Long => match value.parse::<i64>() {
            Ok(_) => ("--el", value.to_owned()),
            Err(_) => return invalid("long"),
        },
        ExtraType::Float => match value.parse::<f32>() {
            Ok(v) if v.is_finite() => ("--ef", value.to_owned()),
            _ => return invalid("float"),
        },
        ExtraType::Double => match value.parse::<f64>() {
            Ok(v) if v.is_finite() => ("--ed", value.to_owned()),
            _ => return invalid("double"),
        },
        ExtraType::Boolean => match value.to_ascii_lowercase().as_str() {
            "true" | "1" => ("--ez", "true".to_owned()),
            "false" | "0" => ("--ez", "false".to_owned()),
            _ => return invalid("boolean"),
        },
        ExtraType::Uri => ("--eu", value.to_owned()),
        ExtraType::Component => {
            if !value.contains('/') {
                return invalid("component (package/class)");
            }
            ("--ecn", value.to_owned())
        }
        ExtraType::StringArray => ("--esa", extra.value.clone()),
        ExtraType::IntArray => {
            if array_items(value).any(|v| v.parse::<i32>().is_err()) {
                return invalid("int list");
            }
            ("--eia", array_items(value).collect::<Vec<_>>().join(","))
        }
        ExtraType::LongArray => {
            if array_items(value).any(|v| v.parse::<i64>().is_err()) {
                return invalid("long list");
            }
            ("--ela", array_items(value).collect::<Vec<_>>().join(","))
        }
        ExtraType::FloatArray => {
            if array_items(value).any(|v| v.parse::<f32>().is_err()) {
                return invalid("float list");
            }
            ("--efa", array_items(value).collect::<Vec<_>>().join(","))
        }
        ExtraType::Null => {
            args.extend(["--esn".to_owned(), key.to_owned()]);
            return Ok(());
        }
    };
    args.extend([flag.to_owned(), key.to_owned(), value]);
    Ok(())
}

/// Builds `am …` arguments (unquoted). `wait` adds `-W` for activities so
/// `am` reports the launched activity and its start time.
pub fn build_am_args(kind: IntentKind, spec: &IntentSpec, wait: bool) -> AppResult<Vec<String>> {
    if [&spec.action, &spec.data, &spec.component]
        .iter()
        .all(|s| s.trim().is_empty())
    {
        return Err(AppError::InvalidInput(
            "set at least an action, data URI or component".into(),
        ));
    }
    let mut args: Vec<String> = vec!["am".into()];
    args.push(
        match kind {
            IntentKind::Activity => "start",
            IntentKind::Broadcast => "broadcast",
            IntentKind::Service => "startservice",
            IntentKind::ForegroundService => "start-foreground-service",
        }
        .into(),
    );
    if wait && kind == IntentKind::Activity {
        args.push("-W".into());
    }
    if let Some(action) = non_blank(&spec.action) {
        check_token("action", action)?;
        args.extend(["-a".into(), action.into()]);
    }
    if let Some(data) = non_blank(&spec.data) {
        args.extend(["-d".into(), data.into()]);
    }
    if let Some(mime) = non_blank(&spec.mime_type) {
        check_token("MIME type", mime)?;
        args.extend(["-t".into(), mime.into()]);
    }
    for category in spec.categories.iter().filter_map(|c| non_blank(c)) {
        check_token("category", category)?;
        args.extend(["-c".into(), category.into()]);
    }
    if let Some(component) = non_blank(&spec.component) {
        check_token("component", component)?;
        if !component.contains('/') {
            return Err(AppError::InvalidInput(format!(
                "component must be package/class: {component:?}"
            )));
        }
        args.extend(["-n".into(), component.into()]);
    }
    for extra in &spec.extras {
        extra_args(extra, &mut args)?;
    }
    let mut flags = 0u32;
    for name in &spec.flags {
        flags |= flag_value(name)?;
    }
    if flags != 0 {
        args.extend(["-f".into(), format!("0x{flags:08x}")]);
    }
    Ok(args)
}

/// `am` command line for the device shell, plus the same command wrapped
/// for pasting into a POSIX terminal (`adb -s … shell "…"`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentCommand {
    pub device: String,
    pub adb: String,
}

pub fn command(
    kind: IntentKind,
    spec: &IntentSpec,
    serial: Option<&str>,
) -> AppResult<IntentCommand> {
    let device = join_args(&build_am_args(kind, spec, false)?);
    let escaped: String = device
        .chars()
        .flat_map(|c| match c {
            '"' | '\\' | '$' | '`' => vec!['\\', c],
            c => vec![c],
        })
        .collect();
    let target = serial
        .map(|s| format!("-s {} ", shell_v2::quote(s)))
        .unwrap_or_default();
    Ok(IntentCommand {
        adb: format!("adb {target}shell \"{escaped}\""),
        device,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Ok,
    /// Delivered, but `am` printed a warning (e.g. brought to front).
    Warning,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentResult {
    pub outcome: Outcome,
    /// `unresolved`, `not_found`, `security`, `exception`, `failed`.
    pub error_kind: Option<String>,
    /// Short message from `am` (first error or warning line).
    pub message: Option<String>,
    /// Launched activity (`-W`), e.g. `com.android.chrome/.Main`.
    pub activity: Option<String>,
    pub total_time_ms: Option<u32>,
    pub launch_state: Option<String>,
    /// `Broadcast completed: result=<n>`.
    pub broadcast_result: Option<i32>,
    pub exit_code: Option<u8>,
    /// Full stdout + stderr for the "Details" disclosure.
    pub raw: String,
}

/// Interprets `am` output. `am` exits 0 even for some failures, so the
/// text decides; the exit code is only a fallback.
pub fn parse_am_output(output: &CommandOutput) -> IntentResult {
    let raw = [output.stdout.trim_end(), output.stderr.trim_end()]
        .iter()
        .filter(|s| !s.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("\n");

    let mut result = IntentResult {
        outcome: Outcome::Ok,
        error_kind: None,
        message: None,
        activity: None,
        total_time_ms: None,
        launch_state: None,
        broadcast_result: None,
        exit_code: output.exit_code,
        raw: raw.clone(),
    };

    let lines: Vec<&str> = raw.lines().map(str::trim).collect();
    for (i, line) in lines.iter().enumerate() {
        if let Some(v) = line.strip_prefix("Activity: ") {
            result.activity = Some(v.to_owned());
        } else if let Some(v) = line.strip_prefix("TotalTime: ") {
            result.total_time_ms = v.parse().ok();
        } else if let Some(v) = line.strip_prefix("LaunchState: ") {
            result.launch_state = Some(v.to_owned());
        } else if let Some(v) = line.strip_prefix("Broadcast completed: result=") {
            result.broadcast_result = v.split_whitespace().next().and_then(|n| n.parse().ok());
        } else if let Some(v) = line.strip_prefix("Warning: ") {
            if result.outcome == Outcome::Ok {
                result.outcome = Outcome::Warning;
                result.message = Some(v.to_owned());
            }
        } else if let Some(v) = line.strip_prefix("Error: ") {
            result.outcome = Outcome::Error;
            result.message = Some(v.to_owned());
            result.error_kind = Some(
                if v.contains("unable to resolve Intent") {
                    "unresolved"
                } else if v.contains("Not found") || v.contains("does not exist") {
                    "not_found"
                } else if v.contains("Permission Denial") || v.contains("SecurityException") {
                    "security"
                } else {
                    "failed"
                }
                .to_owned(),
            );
            break;
        } else if line.starts_with("Exception occurred") || line.starts_with("java.lang.") {
            // The useful line is the exception itself:
            // `java.lang.IllegalArgumentException: Invalid boolean value: maybe`
            let exception = lines[i..]
                .iter()
                .find(|l| l.starts_with("java.") || l.starts_with("android."))
                .copied()
                .unwrap_or(line);
            let message = exception
                .split_once(": ")
                .map(|(_, m)| m)
                .unwrap_or(exception);
            result.outcome = Outcome::Error;
            result.error_kind = Some(
                if exception.contains("SecurityException") {
                    "security"
                } else {
                    "exception"
                }
                .to_owned(),
            );
            result.message = Some(message.to_owned());
            break;
        } else if line.starts_with("Status: ") && *line != "Status: ok" {
            result.outcome = Outcome::Error;
            result.error_kind = Some("failed".into());
            result.message = Some(line.to_string());
        }
    }

    if result.outcome == Outcome::Ok
        && output.exit_code.is_some_and(|c| c != 0)
        && result.activity.is_none()
        && result.broadcast_result.is_none()
    {
        result.outcome = Outcome::Error;
        result.error_kind = Some("failed".into());
        result.message = lines.last().map(|l| l.to_string());
    }
    result
}

pub async fn send(
    server: &AdbServer,
    serial: &str,
    kind: IntentKind,
    spec: &IntentSpec,
) -> AppResult<IntentResult> {
    let command = join_args(&build_am_args(kind, spec, true)?);
    let output = shell_v2::run(server, serial, &command).await?;
    Ok(parse_am_output(&output))
}

/// Encodes text for `input text`: it maps `%s` to a space and cannot type
/// characters outside the device key map (non-ASCII), so we reject those.
pub fn input_text_arg(text: &str) -> AppResult<String> {
    if text.is_empty() {
        return Err(AppError::InvalidInput("text is empty".into()));
    }
    if let Some(c) = text.chars().find(|c| !c.is_ascii() || c.is_ascii_control()) {
        return Err(AppError::InvalidInput(format!(
            "`input text` can only type printable ASCII, not {c:?}"
        )));
    }
    Ok(text.replace(' ', "%s"))
}

pub fn input_text_command(text: &str) -> AppResult<String> {
    Ok(join_args(&["input", "text", &input_text_arg(text)?]))
}

/// `input keyevent` accepts numeric codes or `KEYCODE_*` names.
pub fn keyevent_command(key: &str) -> AppResult<String> {
    let key = key.trim();
    let valid = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if !valid {
        return Err(AppError::InvalidInput(format!("bad key code {key:?}")));
    }
    let name = if key.chars().all(|c| c.is_ascii_digit()) || key.starts_with("KEYCODE_") {
        key.to_owned()
    } else {
        format!("KEYCODE_{key}")
    };
    Ok(join_args(&["input", "keyevent", &name]))
}

fn input_result(output: CommandOutput) -> AppResult<()> {
    let text = format!("{}{}", output.stdout, output.stderr);
    let failed = output.exit_code.is_some_and(|c| c != 0)
        || text.contains("Exception")
        || text.contains("Error:");
    if failed {
        let message = text
            .lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("input failed")
            .trim()
            .to_owned();
        return Err(AppError::Device(message));
    }
    Ok(())
}

pub async fn input_text(server: &AdbServer, serial: &str, text: &str) -> AppResult<()> {
    let output = shell_v2::run(server, serial, &input_text_command(text)?).await?;
    input_result(output)
}

pub async fn input_key(server: &AdbServer, serial: &str, key: &str) -> AppResult<()> {
    let output = shell_v2::run(server, serial, &keyevent_command(key)?).await?;
    input_result(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board_spec() -> IntentSpec {
        IntentSpec {
            action: "android.intent.action.VIEW".into(),
            data: "exampleshop://product/4410".into(),
            categories: vec!["android.intent.category.BROWSABLE".into()],
            component: "com.example.shop/.deeplink.DeepLinkActivity".into(),
            mime_type: String::new(),
            flags: vec!["NEW_TASK".into(), "CLEAR_TOP".into()],
            extras: vec![
                Extra {
                    key: "promo".into(),
                    kind: ExtraType::String,
                    value: "BLACKFRIDAY".into(),
                },
                Extra {
                    key: "qty".into(),
                    kind: ExtraType::Int,
                    value: "2".into(),
                },
                Extra {
                    key: "debug_skip_onboarding".into(),
                    kind: ExtraType::Boolean,
                    value: "true".into(),
                },
            ],
        }
    }

    #[test]
    fn builds_the_board_command() {
        let cmd = command(IntentKind::Activity, &board_spec(), None).unwrap();
        assert_eq!(
            cmd.device,
            "am start -a android.intent.action.VIEW -d exampleshop://product/4410 \
             -c android.intent.category.BROWSABLE -n com.example.shop/.deeplink.DeepLinkActivity \
             --es promo BLACKFRIDAY --ei qty 2 --ez debug_skip_onboarding true -f 0x14000000"
        );
    }

    #[test]
    fn quotes_uris_and_string_extras() {
        let spec = IntentSpec {
            data: "exampleshop://cart?promo=BLACK FRIDAY&utm_source=qa".into(),
            extras: vec![Extra {
                key: "note".into(),
                kind: ExtraType::String,
                value: "it's $5; `x`".into(),
            }],
            ..Default::default()
        };
        let cmd = command(IntentKind::Activity, &spec, Some("emulator-5554")).unwrap();
        assert_eq!(
            cmd.device,
            r"am start -d 'exampleshop://cart?promo=BLACK FRIDAY&utm_source=qa' --es note 'it'\''s $5; `x`'"
        );
        assert_eq!(
            cmd.adb,
            r#"adb -s emulator-5554 shell "am start -d 'exampleshop://cart?promo=BLACK FRIDAY&utm_source=qa' --es note 'it'\\''s \$5; \`x\`'""#
        );
    }

    #[test]
    fn wait_only_for_activities() {
        let spec = IntentSpec {
            action: "com.example.shop.DEBUG_RESET_CART".into(),
            ..Default::default()
        };
        assert_eq!(
            build_am_args(IntentKind::Broadcast, &spec, true).unwrap(),
            vec!["am", "broadcast", "-a", "com.example.shop.DEBUG_RESET_CART"]
        );
        assert_eq!(
            build_am_args(IntentKind::Activity, &spec, true).unwrap()[2],
            "-W"
        );
        assert_eq!(
            build_am_args(IntentKind::ForegroundService, &spec, false).unwrap()[1],
            "start-foreground-service"
        );
    }

    #[test]
    fn validates_typed_extras() {
        let with = |kind, value: &str| IntentSpec {
            action: "a.b".into(),
            extras: vec![Extra {
                key: "k".into(),
                kind,
                value: value.into(),
            }],
            ..Default::default()
        };
        let args = |kind, value| build_am_args(IntentKind::Broadcast, &with(kind, value), false);
        assert!(args(ExtraType::Int, "2.5").is_err());
        assert!(args(ExtraType::Boolean, "maybe").is_err());
        assert_eq!(args(ExtraType::Boolean, "1").unwrap()[6], "true");
        assert_eq!(args(ExtraType::Long, "9000000000").unwrap()[4], "--el");
        assert_eq!(args(ExtraType::IntArray, "1, 2,3").unwrap()[6], "1,2,3");
        assert!(args(ExtraType::IntArray, "1,x").is_err());
        assert_eq!(args(ExtraType::StringArray, "a,b").unwrap()[4], "--esa");
        assert_eq!(args(ExtraType::Null, "").unwrap()[4..], ["--esn", "k"]);
        assert!(args(ExtraType::Component, "nope").is_err());
        assert!(
            build_am_args(
                IntentKind::Activity,
                &IntentSpec {
                    action: "bad action".into(),
                    ..Default::default()
                },
                false
            )
            .is_err()
        );
        assert!(build_am_args(IntentKind::Activity, &IntentSpec::default(), false).is_err());
        assert!(
            build_am_args(
                IntentKind::Activity,
                &IntentSpec {
                    action: "a".into(),
                    flags: vec!["BOGUS".into()],
                    ..Default::default()
                },
                false
            )
            .is_err()
        );
    }

    fn out(stdout: &str, exit: u8) -> CommandOutput {
        CommandOutput {
            stdout: stdout.into(),
            stderr: String::new(),
            exit_code: Some(exit),
        }
    }

    // Captured from an Android 16 emulator.
    #[test]
    fn parses_started_activity() {
        let r = parse_am_output(&out(
            "Starting: Intent { act=android.intent.action.VIEW dat=https://example.com/... flg=0x10000000 }\n\
             Status: ok\nLaunchState: COLD\n\
             Activity: com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity\n\
             TotalTime: 506\nWaitTime: 508\nComplete\n",
            0,
        ));
        assert_eq!(r.outcome, Outcome::Ok);
        assert_eq!(r.total_time_ms, Some(506));
        assert_eq!(r.launch_state.as_deref(), Some("COLD"));
        assert_eq!(
            r.activity.as_deref(),
            Some("com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity")
        );
    }

    #[test]
    fn parses_unresolved_intent() {
        let r = parse_am_output(&out(
            "Starting: Intent { act=android.intent.action.VIEW dat=tetherx://nothing/... }\n\
             Error: Activity not started, unable to resolve Intent { act=android.intent.action.VIEW dat=tetherx://nothing/... flg=0x10000000 xflg=0x4 }\n",
            1,
        ));
        assert_eq!(r.outcome, Outcome::Error);
        assert_eq!(r.error_kind.as_deref(), Some("unresolved"));
    }

    #[test]
    fn parses_broadcast_and_service_errors() {
        let r = parse_am_output(&out(
            "Broadcasting: Intent { act=com.tether.TEST flg=0x400000 (has extras) }\nBroadcast completed: result=0\n",
            0,
        ));
        assert_eq!(r.outcome, Outcome::Ok);
        assert_eq!(r.broadcast_result, Some(0));

        let r = parse_am_output(&out(
            "Starting service: Intent { cmp=com.none/.Svc }\nError: Not found; no service started.\n",
            255,
        ));
        assert_eq!(r.error_kind.as_deref(), Some("not_found"));
        assert_eq!(r.message.as_deref(), Some("Not found; no service started."));
    }

    #[test]
    fn parses_exceptions_and_warnings() {
        let r = parse_am_output(&CommandOutput {
            stdout: String::new(),
            stderr: "\nException occurred while executing 'start':\n\
                java.lang.IllegalArgumentException: Invalid boolean value: maybe\n\
                \tat android.content.Intent.parseCommandArgs(Intent.java:8991)\n"
                .into(),
            exit_code: Some(255),
        });
        assert_eq!(r.outcome, Outcome::Error);
        assert_eq!(r.error_kind.as_deref(), Some("exception"));
        assert_eq!(r.message.as_deref(), Some("Invalid boolean value: maybe"));

        let r = parse_am_output(&out(
            "Starting: Intent { cmp=com.android.settings/.Settings }\n\
             Warning: Activity not started, its current task has been brought to the front\n",
            0,
        ));
        assert_eq!(r.outcome, Outcome::Warning);
    }

    #[test]
    fn escapes_input_text() {
        assert_eq!(
            input_text_command("qa+test42@example.shop").unwrap(),
            "input text qa+test42@example.shop"
        );
        assert_eq!(
            input_text_command("hello world & 'you'").unwrap(),
            r"input text 'hello%sworld%s&%s'\''you'\'''"
        );
        assert!(input_text_command("привет").is_err());
        assert!(input_text_command("").is_err());
        assert!(input_text_command("a\nb").is_err());
    }

    #[test]
    fn builds_keyevents() {
        assert_eq!(
            keyevent_command("ENTER").unwrap(),
            "input keyevent KEYCODE_ENTER"
        );
        assert_eq!(
            keyevent_command("KEYCODE_TAB").unwrap(),
            "input keyevent KEYCODE_TAB"
        );
        assert_eq!(keyevent_command("66").unwrap(), "input keyevent 66");
        assert!(keyevent_command("enter; reboot").is_err());
    }
}

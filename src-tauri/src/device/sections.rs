//! Runs several small shell commands in one `exec:` round trip.
//!
//! Each command's output is preceded by a marker line, so one connection
//! (and one `sh` on the device) collects everything a screen needs:
//!
//! ```text
//! @@tether:meminfo@@
//! MemTotal: 4010748 kB
//! @@tether:uptime@@
//! 1041.03 3289.90
//! ```

use std::collections::HashMap;

use crate::adb::server::AdbServer;
use crate::error::AppResult;

const MARKER_PREFIX: &str = "@@tether:";
const MARKER_SUFFIX: &str = "@@";

/// Builds a script that prints a marker before each command. Errors of one
/// command (missing binary, permission denied) are swallowed so the rest
/// still run; such a section is simply empty.
pub fn script(sections: &[(&str, &str)]) -> String {
    sections
        .iter()
        .map(|(name, command)| {
            format!("echo '{MARKER_PREFIX}{name}{MARKER_SUFFIX}'; {{ {command} ; }} 2>/dev/null")
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Splits the script output back into `name → output`.
pub fn parse(output: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut current: Option<(String, String)> = None;
    for line in output.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if let Some(name) = trimmed
            .strip_prefix(MARKER_PREFIX)
            .and_then(|rest| rest.strip_suffix(MARKER_SUFFIX))
        {
            if let Some((name, body)) = current.take() {
                map.insert(name, body);
            }
            current = Some((name.to_owned(), String::new()));
        } else if let Some((_, body)) = current.as_mut() {
            body.push_str(line);
        }
    }
    if let Some((name, body)) = current {
        map.insert(name, body);
    }
    map
}

/// Runs the sections on the device and returns their outputs by name.
pub async fn run(
    server: &AdbServer,
    serial: &str,
    sections: &[(&str, &str)],
) -> AppResult<HashMap<String, String>> {
    let output = server.exec_text(serial, &script(sections)).await?;
    Ok(parse(&output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn script_marks_every_command() {
        let s = script(&[("a", "cat /proc/uptime"), ("b", "id -u")]);
        assert_eq!(
            s,
            "echo '@@tether:a@@'; { cat /proc/uptime ; } 2>/dev/null; \
             echo '@@tether:b@@'; { id -u ; } 2>/dev/null"
        );
    }

    #[test]
    fn parses_sections_including_empty_ones() {
        let out = "@@tether:uptime@@\n1041.03 3289.90\n@@tether:su@@\n@@tether:id@@\r\n2000\r\n";
        let map = parse(out);
        assert_eq!(map["uptime"], "1041.03 3289.90\n");
        assert_eq!(map["su"], "");
        assert_eq!(map["id"], "2000\r\n");
    }

    #[test]
    fn ignores_text_before_first_marker() {
        let map = parse("noise\n@@tether:a@@\nx\n");
        assert_eq!(map.len(), 1);
        assert_eq!(map["a"], "x\n");
    }
}

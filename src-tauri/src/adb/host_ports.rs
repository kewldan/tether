//! Who uses a TCP port on this computer: how many connections a forwarded
//! port carries, and which process holds a port adb could not bind.
//!
//! - Linux: `/proc/net/tcp{,6}`, owners via `/proc/<pid>/fd` socket inodes.
//! - macOS: `lsof -F` (always installed; there is no procfs).
//! - Windows: `GetExtendedTcpTable` (iphlpapi).
//!
//! Everything is best effort: a port we cannot inspect simply reports no
//! connections and no owner.

use std::collections::HashMap;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortOwner {
    pub pid: u32,
    /// Process name; `None` when it belongs to another user and cannot be read.
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostPortUsage {
    pub port: u16,
    /// Established connections accepted on this port.
    pub connections: u32,
    /// Process listening on the port.
    pub listener: Option<PortOwner>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TcpState {
    Listen,
    Established,
    Other,
}

/// One TCP socket on this computer, as the OS reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Socket {
    pub local_port: u16,
    pub state: TcpState,
    pub pid: Option<u32>,
}

/// Counts connections and finds listeners for `ports`.
pub fn summarize(
    sockets: &[Socket],
    ports: &[u16],
    names: &HashMap<u32, String>,
) -> Vec<HostPortUsage> {
    ports
        .iter()
        .map(|&port| {
            let on_port = || sockets.iter().filter(move |s| s.local_port == port);
            let connections = on_port()
                .filter(|s| s.state == TcpState::Established)
                .count() as u32;
            let listener = on_port()
                .filter(|s| s.state == TcpState::Listen)
                .find_map(|s| s.pid)
                .map(|pid| PortOwner {
                    pid,
                    name: names.get(&pid).cloned(),
                });
            HostPortUsage {
                port,
                connections,
                listener,
            }
        })
        .collect()
}

/// Port of an address like `127.0.0.1:9222`, `[::1]:9222` or `*:9222`.
fn port_of(addr: &str) -> Option<u16> {
    addr.rsplit_once(':')?.1.parse().ok()
}

/// Parses `lsof -nP -iTCP:<ports> -FpcnT` output (macOS).
pub fn parse_lsof(output: &str) -> (Vec<Socket>, HashMap<u32, String>) {
    let mut sockets = Vec::new();
    let mut names = HashMap::new();
    let mut pid = None;
    let mut pending: Option<u16> = None;
    let mut push = |port: Option<u16>, state: TcpState, pid: Option<u32>| {
        if let Some(local_port) = port {
            sockets.push(Socket {
                local_port,
                state,
                pid,
            });
        }
    };
    for line in output.lines() {
        let Some(tag) = line.chars().next() else {
            continue;
        };
        let value = &line[tag.len_utf8()..];
        match tag {
            'p' => {
                push(pending.take(), TcpState::Other, pid);
                pid = value.parse().ok();
            }
            'c' => {
                if let Some(pid) = pid {
                    names.insert(pid, value.to_owned());
                }
            }
            'f' => push(pending.take(), TcpState::Other, pid),
            'n' => {
                let local = value.split("->").next().unwrap_or(value);
                pending = port_of(local);
            }
            'T' => {
                if let Some(state) = value.strip_prefix("ST=") {
                    let state = match state {
                        "LISTEN" => TcpState::Listen,
                        "ESTABLISHED" => TcpState::Established,
                        _ => TcpState::Other,
                    };
                    push(pending.take(), state, pid);
                }
            }
            _ => {}
        }
    }
    push(pending.take(), TcpState::Other, pid);
    (sockets, names)
}

/// Parses `/proc/net/tcp` or `/proc/net/tcp6` (Linux) into sockets and
/// their inodes, used to find the owning process.
pub fn parse_proc_net_tcp(text: &str) -> Vec<(Socket, u64)> {
    text.lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let local = fields.get(1)?;
            let port = u16::from_str_radix(local.rsplit_once(':')?.1, 16).ok()?;
            let state = match *fields.get(3)? {
                "0A" => TcpState::Listen,
                "01" => TcpState::Established,
                _ => TcpState::Other,
            };
            let inode = fields.get(9)?.parse().ok()?;
            Some((
                Socket {
                    local_port: port,
                    state,
                    pid: None,
                },
                inode,
            ))
        })
        .collect()
}

/// Usage of each port, read from the OS. Blocking: call from a blocking
/// task.
pub fn usage(ports: &[u16]) -> Vec<HostPortUsage> {
    if ports.is_empty() {
        return Vec::new();
    }
    let (sockets, names) = platform::sockets(ports);
    summarize(&sockets, ports, &names)
}

#[cfg(target_os = "linux")]
mod platform {
    use std::collections::HashMap;

    use super::{Socket, TcpState, parse_proc_net_tcp};

    pub fn sockets(ports: &[u16]) -> (Vec<Socket>, HashMap<u32, String>) {
        let mut sockets: Vec<(Socket, u64)> = ["/proc/net/tcp", "/proc/net/tcp6"]
            .iter()
            .filter_map(|p| std::fs::read_to_string(p).ok())
            .flat_map(|t| parse_proc_net_tcp(&t))
            .filter(|(s, _)| ports.contains(&s.local_port))
            .collect();
        // Only listeners need an owner; scanning /proc/*/fd is the slow part.
        let wanted: HashMap<u64, usize> = sockets
            .iter()
            .enumerate()
            .filter(|(_, (s, inode))| s.state == TcpState::Listen && *inode != 0)
            .map(|(i, (_, inode))| (*inode, i))
            .collect();
        let mut names = HashMap::new();
        if !wanted.is_empty() {
            for (inode, pid) in socket_owners(&wanted) {
                if let Some(&i) = wanted.get(&inode) {
                    sockets[i].0.pid = Some(pid);
                    if let Ok(comm) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
                        names.insert(pid, comm.trim().to_owned());
                    }
                }
            }
        }
        (sockets.into_iter().map(|(s, _)| s).collect(), names)
    }

    /// `(inode, pid)` for the wanted socket inodes this user can see.
    fn socket_owners(wanted: &HashMap<u64, usize>) -> Vec<(u64, u32)> {
        let mut out = Vec::new();
        let Ok(procs) = std::fs::read_dir("/proc") else {
            return out;
        };
        for entry in procs.flatten() {
            let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse().ok()) else {
                continue;
            };
            let Ok(fds) = std::fs::read_dir(entry.path().join("fd")) else {
                continue;
            };
            for fd in fds.flatten() {
                let Ok(target) = std::fs::read_link(fd.path()) else {
                    continue;
                };
                let inode = target
                    .to_str()
                    .and_then(|t| t.strip_prefix("socket:["))
                    .and_then(|t| t.strip_suffix(']'))
                    .and_then(|t| t.parse::<u64>().ok());
                if let Some(inode) = inode.filter(|i| wanted.contains_key(i)) {
                    out.push((inode, pid));
                }
            }
            if out.len() == wanted.len() {
                break;
            }
        }
        out
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::collections::HashMap;

    use super::{Socket, parse_lsof};

    pub fn sockets(ports: &[u16]) -> (Vec<Socket>, HashMap<u32, String>) {
        let list = ports
            .iter()
            .map(u16::to_string)
            .collect::<Vec<_>>()
            .join(",");
        // Exit status 1 just means "nothing matched".
        let output = std::process::Command::new("/usr/sbin/lsof")
            .args(["-nP", "-w", &format!("-iTCP:{list}"), "-FpcnT"])
            .output();
        match output {
            Ok(out) => parse_lsof(&String::from_utf8_lossy(&out.stdout)),
            Err(_) => (Vec::new(), HashMap::new()),
        }
    }
}

#[cfg(windows)]
mod platform {
    use std::collections::HashMap;
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCP_STATE_ESTAB, MIB_TCP_STATE_LISTEN, MIB_TCP6TABLE_OWNER_PID,
        MIB_TCPTABLE_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
    };
    use windows_sys::Win32::Networking::WinSock::{AF_INET, AF_INET6};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };

    use super::{Socket, TcpState};

    /// The raw table for one address family, in a `u32`-aligned buffer.
    fn table(family: u16) -> Option<Vec<u32>> {
        let mut size = 0u32;
        // SAFETY: a null buffer asks for the required size.
        unsafe {
            GetExtendedTcpTable(
                std::ptr::null_mut(),
                &mut size,
                0,
                u32::from(family),
                TCP_TABLE_OWNER_PID_ALL,
                0,
            );
        }
        for _ in 0..4 {
            let mut buf = vec![0u32; (size as usize).div_ceil(4) + 1];
            let mut len = (buf.len() * 4) as u32;
            // SAFETY: `buf` is writable for `len` bytes.
            let status = unsafe {
                GetExtendedTcpTable(
                    buf.as_mut_ptr().cast::<c_void>(),
                    &mut len,
                    0,
                    u32::from(family),
                    TCP_TABLE_OWNER_PID_ALL,
                    0,
                )
            };
            if status == NO_ERROR {
                return Some(buf);
            }
            if status != ERROR_INSUFFICIENT_BUFFER {
                return None;
            }
            size = len;
        }
        None
    }

    fn state(raw: u32) -> TcpState {
        match raw as i32 {
            s if s == MIB_TCP_STATE_LISTEN => TcpState::Listen,
            s if s == MIB_TCP_STATE_ESTAB => TcpState::Established,
            _ => TcpState::Other,
        }
    }

    /// Ports are stored in network byte order in the low 16 bits.
    fn port(raw: u32) -> u16 {
        u16::from_be(raw as u16)
    }

    fn process_name(pid: u32) -> Option<String> {
        // SAFETY: plain Win32 calls; the handle is closed below.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok =
                QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
            CloseHandle(handle);
            if ok == 0 {
                return None;
            }
            let path = String::from_utf16_lossy(&buf[..len as usize]);
            let file = path.rsplit(['\\', '/']).next().unwrap_or(&path);
            Some(file.strip_suffix(".exe").unwrap_or(file).to_owned())
        }
    }

    pub fn sockets(ports: &[u16]) -> (Vec<Socket>, HashMap<u32, String>) {
        let mut sockets = Vec::new();
        if let Some(buf) = table(AF_INET) {
            // SAFETY: the API filled `buf` with a MIB_TCPTABLE_OWNER_PID
            // holding `dwNumEntries` rows.
            let rows = unsafe {
                let t = buf.as_ptr().cast::<MIB_TCPTABLE_OWNER_PID>();
                std::slice::from_raw_parts((*t).table.as_ptr(), (*t).dwNumEntries as usize)
            };
            sockets.extend(rows.iter().map(|r| Socket {
                local_port: port(r.dwLocalPort),
                state: state(r.dwState),
                pid: Some(r.dwOwningPid),
            }));
        }
        if let Some(buf) = table(AF_INET6) {
            // SAFETY: as above, for the IPv6 table.
            let rows = unsafe {
                let t = buf.as_ptr().cast::<MIB_TCP6TABLE_OWNER_PID>();
                std::slice::from_raw_parts((*t).table.as_ptr(), (*t).dwNumEntries as usize)
            };
            sockets.extend(rows.iter().map(|r| Socket {
                local_port: port(r.dwLocalPort),
                state: state(r.dwState),
                pid: Some(r.dwOwningPid),
            }));
        }
        sockets.retain(|s| ports.contains(&s.local_port));
        let mut names = HashMap::new();
        for s in &sockets {
            if s.state == TcpState::Listen
                && let Some(pid) = s.pid
                && !names.contains_key(&pid)
                && let Some(name) = process_name(pid)
            {
                names.insert(pid, name);
            }
        }
        (sockets, names)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
mod platform {
    use std::collections::HashMap;

    use super::Socket;

    pub fn sockets(_ports: &[u16]) -> (Vec<Socket>, HashMap<u32, String>) {
        (Vec::new(), HashMap::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // `lsof -nP -w -iTCP:5037,9222 -FpcnT` on macOS: adb listening on 5037
    // with one client, plus Chrome connected to a forwarded 9222.
    const LSOF: &str = "p85118\ncadb\nf14\nn127.0.0.1:5037\nTST=LISTEN\nTQR=0\nTQS=0\n\
f15\nn127.0.0.1:5037->127.0.0.1:62782\nTST=ESTABLISHED\nTQR=0\nTQS=0\n\
f16\nn127.0.0.1:9222\nTST=LISTEN\nTQR=0\nTQS=0\n\
f17\nn127.0.0.1:9222->127.0.0.1:50110\nTST=ESTABLISHED\nTQR=0\nTQS=0\n\
f18\nn127.0.0.1:9222->127.0.0.1:50111\nTST=ESTABLISHED\nTQR=0\nTQS=0\n\
p31877\ncGoogle Chrome\nf40\nn127.0.0.1:50110->127.0.0.1:9222\nTST=ESTABLISHED\n\
f41\nn[::1]:8080\nTST=LISTEN\n";

    #[test]
    fn parses_lsof() {
        let (sockets, names) = parse_lsof(LSOF);
        assert_eq!(names.get(&85118).map(String::as_str), Some("adb"));
        assert_eq!(names.get(&31877).map(String::as_str), Some("Google Chrome"));
        let usage = summarize(&sockets, &[5037, 9222, 8080, 1234], &names);
        assert_eq!(usage[0].connections, 1);
        assert_eq!(
            usage[0].listener,
            Some(PortOwner {
                pid: 85118,
                name: Some("adb".into())
            })
        );
        // Chrome's own socket has 9222 as the remote port: not counted.
        assert_eq!(usage[1].connections, 2);
        assert_eq!(usage[2].listener.as_ref().map(|o| o.pid), Some(31877));
        assert_eq!(usage[2].connections, 0);
        assert_eq!(usage[3].connections, 0);
        assert_eq!(usage[3].listener, None);
    }

    // /proc/net/tcp from Ubuntu 24.04: listener on 8080, one accepted
    // connection on it, one connection to it from a client.
    const PROC_TCP: &str = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 412345 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 0100007F:D2F0 01 00000000:00000000 00:00000000 00000000  1000        0 412399 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:D2F0 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 412398 1 0000000000000000 20 4 30 10 -1
   3: 0100007F:13AD 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1 0000000000000000 100 0 0 10 0
";

    #[test]
    fn parses_proc_net_tcp() {
        let rows = parse_proc_net_tcp(PROC_TCP);
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].0.local_port, 8080);
        assert_eq!(rows[0].0.state, TcpState::Listen);
        assert_eq!(rows[0].1, 412345);
        assert_eq!(rows[2].0.local_port, 0xD2F0);
        let sockets: Vec<Socket> = rows.into_iter().map(|(s, _)| s).collect();
        let usage = summarize(&sockets, &[8080, 5037], &HashMap::new());
        assert_eq!(usage[0].connections, 1);
        assert_eq!(usage[1].connections, 0);
    }

    #[test]
    fn reads_a_real_listener() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let _client = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let (_accepted, _) = listener.accept().unwrap();
        let usage = usage(&[port]);
        assert_eq!(usage.len(), 1);
        if cfg!(any(target_os = "linux", target_os = "macos", windows)) {
            assert_eq!(usage[0].connections, 1);
            let owner = usage[0].listener.as_ref().expect("listener found");
            assert_eq!(owner.pid, std::process::id());
        }
    }
}

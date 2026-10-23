//! VNC support (parity with `server/vnc/*`): config resolution, remote
//! diagnostics/parsing, RFB probing, managed sessions (TigerVNC virtual /
//! x11vnc existing desktop) and the binary `/ws/vnc` tunnel.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use bytes::Bytes;
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::db;
use crate::models::Host;
use crate::ssh;
use crate::state::AppState;

// ---------------------------------------------------------------------------
// Config (server/vnc/config.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SshEndpoint {
    pub host: String,
    pub port: i64,
    pub username: String,
    pub host_row: Host,
}

#[derive(Debug, Clone)]
pub struct ResolvedVncConfig {
    pub transport: String,
    pub ssh: Option<SshEndpoint>,
    pub vnc_host: String,
    pub vnc_port: i64,
    #[allow(dead_code)]
    pub vnc_password: Option<String>,
    pub auto_start: bool,
    pub auto_stop: bool,
    #[allow(dead_code)]
    pub desktop_mode: String,
    pub implementation: String,
    pub display: Option<i64>,
}

pub fn resolve_vnc_config(state: &AppState, host: &Host) -> ResolvedVncConfig {
    let transport = if host.vnc_transport.as_deref() == Some("direct") {
        "direct"
    } else {
        "ssh"
    };
    let mut ssh = None;
    if transport == "ssh" {
        let mut ssh_row = host.clone();
        if let Some(ref_id) = host.vnc_ssh_host_id {
            if let Some(referenced) = state
                .with_db(|conn| db::get_host(conn, ref_id).ok().flatten())
            {
                ssh_row = referenced;
            }
        }
        ssh = Some(SshEndpoint {
            host: ssh_row.host.clone(),
            port: ssh_row.port,
            username: ssh_row.username.clone(),
            host_row: ssh_row,
        });
    }
    let vnc_port = if transport == "ssh" {
        host.vnc_port.unwrap_or(5900)
    } else {
        host.port
    };
    ResolvedVncConfig {
        transport: transport.to_string(),
        ssh,
        vnc_host: if transport == "ssh" {
            "127.0.0.1".to_string()
        } else {
            host.host.clone()
        },
        vnc_port,
        vnc_password: host.vnc_password.clone(),
        auto_start: host.vnc_auto_start,
        auto_stop: host.vnc_auto_stop,
        desktop_mode: host.vnc_desktop_mode.clone().unwrap_or_else(|| "auto".into()),
        implementation: host.vnc_implementation.clone().unwrap_or_else(|| "auto".into()),
        display: host.vnc_display,
    }
}

// ---------------------------------------------------------------------------
// Types (shared/types.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VncRequirement {
    #[serde(rename = "type")]
    pub kind: String,
    pub severity: String,
    pub message: String,
    #[serde(rename = "installCommands", skip_serializing_if = "Option::is_none")]
    pub install_commands: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VncDiagnostics {
    pub os: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distribution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub architecture: Option<String>,
    pub vnc: VncDiagVnc,
    pub desktop: VncDiagDesktop,
    pub permissions: VncDiagPermissions,
    pub requirements: Vec<VncRequirement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VncDiagVnc {
    pub installed: bool,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub implementation: Option<String>,
    #[serde(rename = "hasX11vnc")]
    pub has_x11vnc: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VncDiagDesktop {
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub environment: Option<String>,
    #[serde(rename = "displayServer", skip_serializing_if = "Option::is_none")]
    pub display_server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub displays: Option<Vec<i64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VncDiagPermissions {
    #[serde(rename = "canStartVnc")]
    pub can_start_vnc: bool,
    #[serde(rename = "canAccessDisplay")]
    pub can_access_display: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VncStatus {
    pub host_id: i64,
    pub transport: String,
    pub port: i64,
    pub running: bool,
    pub started: bool,
    pub implementation: Option<String>,
    pub display: Option<i64>,
    pub managed: bool,
    pub requirements: Vec<VncRequirement>,
}

// ---------------------------------------------------------------------------
// Requirements (server/vnc/requirements.ts)
// ---------------------------------------------------------------------------

fn package_manager(distribution: Option<&str>) -> Option<&'static str> {
    let name = distribution.unwrap_or("").to_lowercase();
    if name.contains("debian") || name.contains("ubuntu") {
        Some("apt")
    } else if name.contains("fedora")
        || name.contains("rhel")
        || name.contains("centos")
        || name.contains("rocky")
        || name.contains("alma")
    {
        Some("dnf")
    } else if name.contains("arch") || name.contains("manjaro") {
        Some("pacman")
    } else if name.contains("alpine") {
        Some("apk")
    } else if name.contains("suse") || name.contains("opensuse") {
        Some("zypper")
    } else {
        None
    }
}

fn vnc_install_commands(distribution: Option<&str>) -> Vec<String> {
    match package_manager(distribution) {
        Some("apt") => vec!["apt-get update".into(), "apt-get install -y tigervnc-standalone-server".into()],
        Some("dnf") => vec!["dnf install -y tigervnc-server".into()],
        Some("pacman") => vec!["pacman -S --noconfirm tigervnc".into()],
        Some("apk") => vec!["apk add tigervnc".into()],
        Some("zypper") => vec!["zypper install -y tigervnc".into()],
        _ => vec![],
    }
}

fn x11vnc_install_commands(distribution: Option<&str>) -> Vec<String> {
    match package_manager(distribution) {
        Some("apt") => vec!["apt-get update".into(), "apt-get install -y x11vnc".into()],
        Some("dnf") => vec!["dnf install -y x11vnc".into()],
        Some("pacman") => vec!["pacman -S --noconfirm x11vnc".into()],
        Some("apk") => vec!["apk add x11vnc".into()],
        Some("zypper") => vec!["zypper install -y x11vnc".into()],
        _ => vec![],
    }
}

fn desktop_install_commands(distribution: Option<&str>) -> Vec<String> {
    match package_manager(distribution) {
        Some("apt") => vec!["apt-get update".into(), "apt-get install -y xfce4 xfce4-goodies".into()],
        Some("dnf") => vec!["dnf install -y xorg-x11-server-Xorg xfce4".into()],
        Some("pacman") => vec!["pacman -S --noconfirm xfce4 xfce4-goodies".into()],
        Some("apk") => vec!["apk add xfce4".into()],
        Some("zypper") => vec!["zypper install -y xfce4".into()],
        _ => vec![],
    }
}

pub fn resolve_implementation(diagnostics: Option<&VncDiagnostics>, host: &Host) -> String {
    if host.vnc_implementation.as_deref() == Some("tigervnc") {
        return "tigervnc".into();
    }
    if host.vnc_implementation.as_deref() == Some("x11vnc") {
        return "x11vnc".into();
    }
    if host.vnc_desktop_mode.as_deref() == Some("virtual") {
        return "tigervnc".into();
    }
    let Some(diagnostics) = diagnostics else {
        return "tigervnc".into();
    };
    if diagnostics.desktop.display_server.as_deref() == Some("x11")
        && diagnostics.permissions.can_access_display
        && diagnostics.vnc.has_x11vnc
    {
        return "x11vnc".into();
    }
    "tigervnc".into()
}

pub fn get_vnc_requirements(
    diagnostics: Option<&VncDiagnostics>,
    implementation: &str,
) -> Vec<VncRequirement> {
    let Some(diagnostics) = diagnostics else {
        return vec![VncRequirement {
            kind: "unsupported_environment".into(),
            severity: "blocking".into(),
            message: "Remote diagnostics are unavailable for this VNC transport.".into(),
            install_commands: None,
        }];
    };
    if diagnostics.vnc.running {
        return vec![];
    }
    let mut requirements = Vec::new();
    if implementation == "x11vnc" {
        if !diagnostics.vnc.has_x11vnc {
            requirements.push(VncRequirement {
                kind: "x11vnc_missing".into(),
                severity: "blocking".into(),
                message: format!(
                    "x11vnc is not installed on {}.",
                    diagnostics
                        .distribution
                        .as_deref()
                        .unwrap_or(&diagnostics.os)
                ),
                install_commands: Some(x11vnc_install_commands(diagnostics.distribution.as_deref())),
            });
        }
        let displays_empty = diagnostics
            .desktop
            .displays
            .as_ref()
            .map(|d| d.is_empty())
            .unwrap_or(true);
        if diagnostics.desktop.display_server.as_deref() == Some("wayland")
            || displays_empty
            || !diagnostics.permissions.can_access_display
        {
            requirements.push(VncRequirement {
                kind: "display_unavailable".into(),
                severity: "blocking".into(),
                message: if diagnostics.desktop.display_server.as_deref() == Some("wayland") {
                    "The remote session is Wayland-based; x11vnc requires an X11 display.".into()
                } else {
                    "No accessible X11 display was found on the remote host.".into()
                },
                install_commands: None,
            });
        }
        return requirements;
    }

    if !diagnostics.vnc.installed {
        requirements.push(VncRequirement {
            kind: "vnc_server_missing".into(),
            severity: "blocking".into(),
            message: format!(
                "No VNC server is installed on {}.",
                diagnostics.distribution.as_deref().unwrap_or(&diagnostics.os)
            ),
            install_commands: Some(vnc_install_commands(diagnostics.distribution.as_deref())),
        });
    }
    if !diagnostics.desktop.installed {
        requirements.push(VncRequirement {
            kind: "desktop_missing".into(),
            severity: "blocking".into(),
            message: "No desktop environment is installed on the remote host.".into(),
            install_commands: Some(desktop_install_commands(diagnostics.distribution.as_deref())),
        });
    }
    if diagnostics.vnc.installed
        && diagnostics.desktop.installed
        && diagnostics.desktop.display_server.as_deref() == Some("wayland")
    {
        requirements.push(VncRequirement {
            kind: "display_unavailable".into(),
            severity: "blocking".into(),
            message: "The remote session is Wayland-based; an X server display is required for VNC.".into(),
            install_commands: None,
        });
    }
    if diagnostics.vnc.installed && !diagnostics.permissions.can_start_vnc {
        requirements.push(VncRequirement {
            kind: "permission_denied".into(),
            severity: "blocking".into(),
            message: "The connected user does not have permission to start a VNC server.".into(),
            install_commands: None,
        });
    }
    requirements
}

// ---------------------------------------------------------------------------
// Diagnostics (server/vnc/diagnostics.ts)
// ---------------------------------------------------------------------------

const DIAG_SCRIPT: &str = r#"echo "==os=="; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s
echo "==arch=="; uname -m 2>/dev/null
echo "==bins=="; for b in vncserver vncsession xvnc4server Xvnc x11vnc; do command -v "$b" 2>/dev/null; done
echo "==version=="; (vncserver -version 2>&1 || xvnc4server --help 2>&1 | head -1 || x11vnc -version 2>&1 | head -1) | head -2
echo "==listen=="; (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk 'NR>1 {split($4, a, ":"); print a[length(a)]}' | grep -E "^59[0-9][0-9]$" | sort -u
echo "==processes=="; ps -eo args 2>/dev/null | grep -E "Xvnc|tigervnc" | grep -v grep | head -5
echo "==xsessions=="; ls /usr/share/xsessions 2>/dev/null
echo "==sessiontype=="; loginctl show-session "$(loginctl 2>/dev/null | awk 'NR==2 {print $1}')" -p Type 2>/dev/null
echo "==display=="; echo "${DISPLAY:-}"
echo "==xdisplays=="; ls /tmp/.X11-unix 2>/dev/null | sed 's/^X//'
echo "==uid=="; id -u 2>/dev/null"#;

fn section<'a>(output: &'a str, name: &str) -> &'a str {
    let marker = format!("=={name}==");
    let Some(start) = output.find(&marker) else {
        return "";
    };
    let rest = &output[start + marker.len()..];
    match find_next_section(rest) {
        Some(next) => rest[..next].trim(),
        None => rest.trim(),
    }
}

fn find_next_section(rest: &str) -> Option<usize> {
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i + 3 < bytes.len() {
        if bytes[i] == b'\n' && bytes[i + 1] == b'=' && bytes[i + 2] == b'=' {
            let tail = &rest[i + 3..];
            if let Some(close) = tail.find("==") {
                let name = &tail[..close];
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_lowercase()) {
                    return Some(i);
                }
            }
        }
        i += 1;
    }
    None
}

pub fn parse_diagnostics(output: &str, expected_port: i64) -> VncDiagnostics {
    let distro = section(output, "os")
        .lines()
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let architecture = section(output, "arch")
        .lines()
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let bins: Vec<String> = section(output, "bins")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let version_text = section(output, "version");
    let listening_ports: Vec<i64> = section(output, "listen")
        .lines()
        .filter_map(|l| l.trim().parse::<i64>().ok())
        .filter(|n| (5900..=5999).contains(n))
        .collect();
    let processes: Vec<String> = section(output, "processes")
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect();
    let xsessions: Vec<String> = section(output, "xsessions")
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    let session_type = section(output, "sessiontype");
    let xdisplay = section(output, "display")
        .lines()
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let displays: Vec<i64> = section(output, "xdisplays")
        .lines()
        .filter_map(|l| l.trim().parse::<i64>().ok())
        .filter(|n| *n >= 0)
        .collect();
    let uid: i64 = section(output, "uid")
        .lines()
        .next()
        .and_then(|l| l.trim().parse().ok())
        .unwrap_or(-1);

    let bin_names: Vec<String> = bins
        .iter()
        .map(|b| b.rsplit('/').next().unwrap_or(b).to_string())
        .collect();
    let implementation = if version_text.to_lowercase().contains("tigervnc")
        || (bin_names.iter().any(|b| b == "vncserver") && !bin_names.iter().any(|b| b == "x11vnc"))
    {
        Some("tigervnc".to_string())
    } else if version_text.to_lowercase().contains("x11vnc") || bin_names.iter().any(|b| b == "x11vnc") {
        Some("x11vnc".to_string())
    } else {
        None
    };

    let mut display: Option<i64> = None;
    for line in &processes {
        if let Some(idx) = line.find(':') {
            let digits: String = line[idx + 1..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !digits.is_empty() {
                display = digits.parse().ok();
                break;
            }
        }
    }

    let environment = if xsessions.is_empty() {
        None
    } else if xsessions.iter().any(|f| f.starts_with("xfce")) {
        Some("xfce".to_string())
    } else if xsessions.iter().any(|f| f.contains("gnome")) {
        Some("gnome".to_string())
    } else if xsessions.iter().any(|f| f.contains("plasma")) {
        Some("kde".to_string())
    } else if xsessions.iter().any(|f| f.contains("mate")) {
        Some("mate".to_string())
    } else {
        Some("other".to_string())
    };

    let lower_type = session_type.to_lowercase();
    let display_server = if lower_type.contains("type=wayland") {
        "wayland"
    } else if lower_type.contains("type=x11") {
        "x11"
    } else {
        "unknown"
    }
    .to_string();

    let display_number = xdisplay.as_ref().and_then(|d| {
        let trimmed = d.trim_start_matches(':');
        if trimmed.chars().all(|c| c.is_ascii_digit()) && !trimmed.is_empty() {
            trimmed.parse::<i64>().ok()
        } else {
            None
        }
    });
    let can_access_display = !displays.is_empty()
        && (uid == 0 || display_number.map(|n| displays.contains(&n)).unwrap_or(false));

    VncDiagnostics {
        os: distro.clone().unwrap_or_else(|| "unknown".into()),
        distribution: distro,
        architecture,
        vnc: VncDiagVnc {
            installed: !bins.is_empty(),
            running: listening_ports.contains(&expected_port) || !processes.is_empty(),
            implementation,
            has_x11vnc: bin_names.iter().any(|b| b == "x11vnc"),
            port: if listening_ports.contains(&expected_port) {
                Some(expected_port)
            } else {
                listening_ports.first().copied()
            },
            display,
        },
        desktop: VncDiagDesktop {
            installed: !xsessions.is_empty(),
            environment,
            display_server: Some(display_server),
            display: xdisplay,
            displays: Some(displays),
        },
        permissions: VncDiagPermissions {
            can_start_vnc: uid >= 0 && (uid == 0 || !bins.is_empty()),
            can_access_display,
        },
        requirements: vec![],
    }
}

// ---------------------------------------------------------------------------
// SSH exec helper (server/vnc/ssh.ts execRemote)
// ---------------------------------------------------------------------------

pub struct ExecResult {
    pub code: i64,
    pub stdout: String,
    pub stderr: String,
}

pub async fn exec_remote(endpoint: &SshEndpoint, command: &str, timeout_ms: u64) -> Result<ExecResult, String> {
    let auth = ssh::build_auth(&endpoint.host_row)?;
    let (handler, _host_key) = ssh::TermHandler::new();
    let config = Arc::new(russh::client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(15)),
        ..<_>::default()
    });
    let addrs = (endpoint.host.as_str(), endpoint.port as u16);
    let connected = tokio::time::timeout(
        Duration::from_secs(15),
        russh::client::connect(config, addrs, handler),
    )
    .await
    .map_err(|_| "connection timed out".to_string())?
    .map_err(|e| e.to_string())?;
    let mut handle = connected;
    ssh::authenticate(&mut handle, &endpoint.username, auth).await?;

    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .exec(true, command)
        .await
        .map_err(|e| e.to_string())?;

    let collect = async {
        let (mut rd, _wr) = channel.split();
        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut code: i64 = 0;
        while let Some(msg) = rd.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.push_str(&String::from_utf8_lossy(&data)),
                ChannelMsg::ExtendedData { data, .. } => {
                    stderr.push_str(&String::from_utf8_lossy(&data))
                }
                ChannelMsg::ExitStatus { exit_status } => code = exit_status as i64,
                ChannelMsg::Eof | ChannelMsg::Close => break,
                _ => {}
            }
        }
        (stdout, stderr, code)
    };
    let result = tokio::time::timeout(Duration::from_millis(timeout_ms), collect)
        .await
        .map_err(|_| format!("remote command timed out after {timeout_ms}ms"))?;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "", "English")
        .await;
    Ok(ExecResult {
        code: result.2,
        stdout: result.0,
        stderr: result.1,
    })
}

pub async fn diagnose_vnc_environment(state: &AppState, host: &Host) -> Option<VncDiagnostics> {
    let cfg = resolve_vnc_config(state, host);
    let endpoint = cfg.ssh.as_ref()?;
    let result = exec_remote(endpoint, DIAG_SCRIPT, 30_000).await.ok()?;
    Some(parse_diagnostics(&result.stdout, cfg.vnc_port))
}

// ---------------------------------------------------------------------------
// RFB probe (server/vnc/probe.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub running: bool,
    pub version: Option<String>,
    pub reason: Option<String>,
}

fn is_rfb_greeting(buffer: &[u8]) -> bool {
    buffer.len() >= 12 && &buffer[..4] == b"RFB "
}

pub async fn probe_vnc(
    mut open: impl FnMut() -> futures_util::future::BoxFuture<'static, Result<VncStream, String>>,
    timeout_ms: u64,
) -> ProbeResult {
    let mut stream = match open().await {
        Ok(stream) => stream,
        Err(e) => {
            return ProbeResult {
                running: false,
                version: None,
                reason: Some(e),
            }
        }
    };
    let mut chunks: Vec<u8> = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            stream.close().await;
            return ProbeResult {
                running: false,
                version: None,
                reason: Some("timed out waiting for RFB greeting".into()),
            };
        }
        match tokio::time::timeout(remaining, stream.read_chunk()).await {
            Err(_) => {
                stream.close().await;
                return ProbeResult {
                    running: false,
                    version: None,
                    reason: Some("timed out waiting for RFB greeting".into()),
                };
            }
            Ok(Ok(Some(data))) => {
                chunks.extend_from_slice(&data);
                if is_rfb_greeting(&chunks) {
                    let version = String::from_utf8_lossy(&chunks[4..12]).trim().to_string();
                    stream.close().await;
                    return ProbeResult {
                        running: true,
                        version: Some(version),
                        reason: None,
                    };
                }
                if chunks.len() > 64 {
                    let head = &chunks[..chunks.len().min(16)];
                    use base64::Engine;
                    let b64 = base64::engine::general_purpose::STANDARD.encode(head);
                    stream.close().await;
                    return ProbeResult {
                        running: false,
                        version: None,
                        reason: Some(format!("unexpected data: {b64}")),
                    };
                }
            }
            Ok(Ok(None)) => {
                stream.close().await;
                return ProbeResult {
                    running: false,
                    version: None,
                    reason: Some("connection closed before RFB greeting".into()),
                };
            }
            Ok(Err(e)) => {
                stream.close().await;
                return ProbeResult {
                    running: false,
                    version: None,
                    reason: Some(e),
                };
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Streams (server/vnc/transport.ts)
// ---------------------------------------------------------------------------

/// A VNC byte stream: either a raw TCP socket or an SSH direct-tcpip channel.
pub struct VncStream {
    pub inner: VncStreamInner,
    /// Keeps the SSH connection alive for tunneled streams.
    handle: Option<ssh::SshHandle>,
}

pub enum VncStreamInner {
    Tcp(tokio::net::TcpStream),
    Channel(russh::Channel<russh::client::Msg>),
}

impl VncStream {
    pub async fn read_chunk(&mut self) -> Result<Option<Vec<u8>>, String> {
        match &mut self.inner {
            VncStreamInner::Tcp(socket) => {
                use tokio::io::AsyncReadExt;
                let mut buf = vec![0u8; 8192];
                match socket.read(&mut buf).await {
                    Ok(0) => Ok(None),
                    Ok(n) => {
                        buf.truncate(n);
                        Ok(Some(buf))
                    }
                    Err(e) => Err(e.to_string()),
                }
            }
            VncStreamInner::Channel(channel) => match channel.wait().await {
                Some(ChannelMsg::Data { data }) => Ok(Some(data.to_vec())),
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => Ok(None),
                _ => Ok(Some(vec![])),
            },
        }
    }

    pub async fn write(&mut self, data: &[u8]) -> Result<(), String> {
        match &mut self.inner {
            VncStreamInner::Tcp(socket) => {
                use tokio::io::AsyncWriteExt;
                socket.write_all(data).await.map_err(|e| e.to_string())
            }
            VncStreamInner::Channel(channel) => channel
                .data_bytes(Bytes::copy_from_slice(data))
                .await
                .map_err(|e| e.to_string()),
        }
    }

    pub async fn close(&mut self) {
        match &mut self.inner {
            VncStreamInner::Tcp(socket) => {
                use tokio::io::AsyncWriteExt;
                let _ = socket.shutdown().await;
            }
            VncStreamInner::Channel(channel) => {
                let _ = channel.eof().await;
            }
        }
        if let Some(handle) = self.handle.as_mut() {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "English")
                .await;
        }
    }
}

pub async fn connect_net(host: &str, port: i64, timeout_ms: u64) -> Result<tokio::net::TcpStream, String> {
    let addr = format!("{host}:{port}");
    match tokio::time::timeout(Duration::from_millis(timeout_ms), tokio::net::TcpStream::connect(&addr)).await {
        Err(_) => Err(format!("connect to {addr} timed out")),
        Ok(Err(e)) => Err(e.to_string()),
        Ok(Ok(socket)) => Ok(socket),
    }
}

pub async fn open_vnc_stream(
    state: &AppState,
    host: &Host,
    port_override: Option<i64>,
) -> Result<VncStream, String> {
    let cfg = resolve_vnc_config(state, host);
    let port = port_override.unwrap_or(cfg.vnc_port);
    if cfg.transport == "direct" {
        let socket = connect_net(&cfg.vnc_host, port, 10_000).await?;
        return Ok(VncStream {
            inner: VncStreamInner::Tcp(socket),
            handle: None,
        });
    }
    let endpoint = cfg.ssh.as_ref().ok_or("missing SSH endpoint")?;
    let auth = ssh::build_auth(&endpoint.host_row)?;
    let (handler, _host_key) = ssh::TermHandler::new();
    let config = Arc::new(russh::client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(15)),
        ..<_>::default()
    });
    let addrs = (endpoint.host.as_str(), endpoint.port as u16);
    let mut handle = tokio::time::timeout(
        Duration::from_secs(15),
        russh::client::connect(config, addrs, handler),
    )
    .await
    .map_err(|_| "connection timed out".to_string())?
    .map_err(|e| e.to_string())?;
    ssh::authenticate(&mut handle, &endpoint.username, auth).await?;
    let channel = handle
        .channel_open_direct_tcpip("127.0.0.1", port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| e.to_string())?;
    Ok(VncStream {
        inner: VncStreamInner::Channel(channel),
        handle: Some(handle),
    })
}

// ---------------------------------------------------------------------------
// Managed sessions (server/vnc/sessions.ts + lifecycle.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ManagedSession {
    pub host_id: i64,
    pub port: i64,
    pub display: Option<i64>,
    pub pid: Option<i64>,
    pub managed: bool,
    pub implementation: String,
    pub active: u32,
}

struct SessionRegistry {
    sessions: HashMap<i64, ManagedSession>,
    starting: HashMap<i64, ()>,
}

fn registry() -> &'static Mutex<SessionRegistry> {
    static REGISTRY: OnceLock<Mutex<SessionRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        Mutex::new(SessionRegistry {
            sessions: HashMap::new(),
            starting: HashMap::new(),
        })
    })
}

pub async fn get_session(host_id: i64) -> Option<ManagedSession> {
    registry().lock().await.sessions.get(&host_id).cloned()
}

fn find_free_display(reg: &SessionRegistry) -> Result<i64, String> {
    let taken: Vec<Option<i64>> = reg.sessions.values().map(|s| s.display).collect();
    for display in 1..=20 {
        if !taken.contains(&Some(display)) {
            return Ok(display);
        }
    }
    Err("no free VNC display available (tried :1-:20)".into())
}

pub async fn enter_session(host_id: i64) {
    let mut reg = registry().lock().await;
    if let Some(session) = reg.sessions.get_mut(&host_id) {
        session.active += 1;
    }
}

/// Decrements the active count; returns true when it reaches zero.
pub async fn leave_session(host_id: i64) -> bool {
    let mut reg = registry().lock().await;
    match reg.sessions.get_mut(&host_id) {
        Some(session) => {
            session.active = session.active.saturating_sub(1);
            session.active == 0
        }
        None => false,
    }
}

pub struct EnsureResult {
    pub session: Option<ManagedSession>,
    pub requirements: Vec<VncRequirement>,
}

pub async fn ensure_session(
    state: &AppState,
    host_id: i64,
    start: bool,
) -> Result<EnsureResult, String> {
    if let Some(existing) = get_session(host_id).await {
        return Ok(EnsureResult {
            session: Some(existing),
            requirements: vec![],
        });
    }
    {
        let mut reg = registry().lock().await;
        if reg.starting.contains_key(&host_id) {
            drop(reg);
            // Wait for the in-flight start to settle, then return it.
            loop {
                tokio::time::sleep(Duration::from_millis(50)).await;
                if let Some(existing) = get_session(host_id).await {
                    return Ok(EnsureResult {
                        session: Some(existing),
                        requirements: vec![],
                    });
                }
                if !registry().lock().await.starting.contains_key(&host_id) {
                    return Ok(EnsureResult {
                        session: None,
                        requirements: vec![],
                    });
                }
            }
        }
        reg.starting.insert(host_id, ());
    }

    let result = ensure_session_inner(state, host_id, start).await;
    registry().lock().await.starting.remove(&host_id);
    result
}

async fn ensure_session_inner(
    state: &AppState,
    host_id: i64,
    start: bool,
) -> Result<EnsureResult, String> {
    let host = state
        .with_db(|conn| db::get_host(conn, host_id).ok().flatten())
        .ok_or("host not found")?;
    let cfg = resolve_vnc_config(state, &host);

    let probe = probe_vnc(
        {
            let state = state.clone();
            let host = host.clone();
            move || {
                let state = state.clone();
                let host = host.clone();
                Box::pin(async move { open_vnc_stream(&state, &host, None).await })
            }
        },
        4000,
    )
    .await;
    if probe.running {
        let session = ManagedSession {
            host_id,
            port: cfg.vnc_port,
            display: None,
            pid: None,
            managed: false,
            implementation: "tigervnc".into(),
            active: 0,
        };
        registry()
            .lock()
            .await
            .sessions
            .insert(host_id, session.clone());
        return Ok(EnsureResult {
            session: Some(session),
            requirements: vec![],
        });
    }

    let diagnostics = if cfg.ssh.is_some() {
        diagnose_vnc_environment(state, &host).await
    } else {
        None
    };
    let implementation = resolve_implementation(diagnostics.as_ref(), &host);
    let requirements = get_vnc_requirements(diagnostics.as_ref(), &implementation);
    if !host.vnc_auto_start && !start {
        return Ok(EnsureResult {
            session: None,
            requirements,
        });
    }
    if !requirements.is_empty() {
        return Ok(EnsureResult {
            session: None,
            requirements,
        });
    }

    let (started_display, started_pid) = if implementation == "x11vnc" {
        let detected: Option<i64> = diagnostics.as_ref().and_then(|d| {
            d.desktop
                .display
                .as_deref()
                .map(|s| s.trim_start_matches(':'))
                .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
                .and_then(|s| s.parse().ok())
        });
        let display = detected
            .or_else(|| {
                diagnostics.as_ref().and_then(|d| {
                    d.desktop
                        .displays
                        .as_ref()
                        .and_then(|displays| displays.first().copied())
                })
            })
            .unwrap_or(0);
        let pid = start_existing_desktop(state, &host, cfg.vnc_port, display).await?;
        (display, pid)
    } else {
        let display = match host.vnc_display {
            Some(d) => d,
            None => {
                let reg = registry().lock().await;
                find_free_display(&reg)?
            }
        };
        let pid = start_virtual_desktop(state, &host, cfg.vnc_port, display).await?;
        (display, pid)
    };

    let session = ManagedSession {
        host_id,
        port: cfg.vnc_port,
        display: Some(started_display),
        pid: started_pid,
        managed: true,
        implementation: implementation.clone(),
        active: 0,
    };
    registry()
        .lock()
        .await
        .sessions
        .insert(host_id, session.clone());
    let pid_text = started_pid
        .map(|p| p.to_string())
        .unwrap_or_else(|| "unknown".into());
    state.add_audit(
        if implementation == "x11vnc" {
            "vnc.x11vnc.started"
        } else {
            "vnc.started"
        },
        Some(host_id),
        &format!("display :{started_display} pid={pid_text} port={}", cfg.vnc_port),
    );
    Ok(EnsureResult {
        session: Some(session),
        requirements: vec![],
    })
}

async fn start_virtual_desktop(
    state: &AppState,
    host: &Host,
    port: i64,
    display: i64,
) -> Result<Option<i64>, String> {
    let cfg = resolve_vnc_config(state, host);
    let endpoint = cfg.ssh.as_ref().ok_or("virtual desktop startup requires an SSH transport")?;
    let command = format!(
        "vncserver -kill :{display} 2>/dev/null || true; nohup vncserver :{display} -rfbport {port} -localhost -SecurityTypes None -Geometry 1280x800 -Depth 24 >/tmp/termius-free-vnc-{display}.log 2>&1 & echo $!"
    );
    let result = exec_remote(endpoint, &command, 30_000).await?;
    if result.code != 0 {
        return Err(if result.stderr.trim().is_empty() {
            format!("vncserver exited with code {}", result.code)
        } else {
            result.stderr.trim().to_string()
        });
    }
    let pid = result
        .stdout
        .trim()
        .lines()
        .last()
        .and_then(|l| l.trim().parse::<i64>().ok())
        .filter(|p| *p > 0);
    for _ in 0..30 {
        let probe = probe_vnc(
            {
                let state = state.clone();
                let host = host.clone();
                move || {
                    let state = state.clone();
                    let host = host.clone();
                    Box::pin(async move { open_vnc_stream(&state, &host, Some(port)).await })
                }
            },
            1500,
        )
        .await;
        if probe.running {
            return Ok(pid);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(format!(
        "vncserver started on display :{display} but port {port} never began listening"
    ))
}

async fn start_existing_desktop(
    state: &AppState,
    host: &Host,
    port: i64,
    display: i64,
) -> Result<Option<i64>, String> {
    let cfg = resolve_vnc_config(state, host);
    let endpoint = cfg.ssh.as_ref().ok_or("existing desktop startup requires an SSH transport")?;
    let command = format!(
        "pkill -f \"x11vnc.*-rfbport {port}\" 2>/dev/null || true; nohup x11vnc -display :{display} -rfbport {port} -localhost -nopw -forever -shared >/tmp/termius-free-x11vnc-{port}.log 2>&1 & echo $!"
    );
    let result = exec_remote(endpoint, &command, 30_000).await?;
    if result.code != 0 {
        return Err(if result.stderr.trim().is_empty() {
            format!("x11vnc exited with code {}", result.code)
        } else {
            result.stderr.trim().to_string()
        });
    }
    let pid = result
        .stdout
        .trim()
        .lines()
        .last()
        .and_then(|l| l.trim().parse::<i64>().ok())
        .filter(|p| *p > 0);
    for _ in 0..30 {
        let probe = probe_vnc(
            {
                let state = state.clone();
                let host = host.clone();
                move || {
                    let state = state.clone();
                    let host = host.clone();
                    Box::pin(async move { open_vnc_stream(&state, &host, Some(port)).await })
                }
            },
            1500,
        )
        .await;
        if probe.running {
            return Ok(pid);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(format!(
        "x11vnc started on display :{display} but port {port} never began listening"
    ))
}

pub async fn stop_session(state: &AppState, host_id: i64) {
    let session = registry().lock().await.sessions.remove(&host_id);
    let Some(session) = session else {
        return;
    };
    if session.managed {
        if let Some(host) = state
            .with_db(|conn| db::get_host(conn, host_id).ok().flatten())
        {
            if session.implementation == "x11vnc" {
                let _ = stop_existing_desktop(state, &host, session.pid).await;
            } else {
                let _ = stop_virtual_desktop(state, &host, session.display.unwrap_or(0)).await;
            }
        }
        let display = session
            .display
            .map(|d| d.to_string())
            .unwrap_or_else(|| "unknown".into());
        state.add_audit(
            "vnc.stopped",
            Some(host_id),
            &format!("display :{display}"),
        );
    }
}

async fn stop_virtual_desktop(state: &AppState, host: &Host, display: i64) {
    let cfg = resolve_vnc_config(state, host);
    let Some(endpoint) = cfg.ssh.as_ref() else {
        return;
    };
    let _ = exec_remote(endpoint, &format!("vncserver -kill :{display} 2>/dev/null || true"), 15_000).await;
}

async fn stop_existing_desktop(state: &AppState, host: &Host, pid: Option<i64>) {
    let cfg = resolve_vnc_config(state, host);
    let Some(endpoint) = cfg.ssh.as_ref() else {
        return;
    };
    let command = match pid.filter(|p| *p > 0) {
        Some(pid) => format!("kill {pid} 2>/dev/null || true"),
        None => "pkill -f \"x11vnc.*-localhost\" 2>/dev/null || true".to_string(),
    };
    let _ = exec_remote(endpoint, &command, 15_000).await;
}

/// Builds the `VncStatus` for a host (parity with `buildStatus` in routes/vnc.ts).
pub async fn build_status(state: &AppState, host: &Host) -> VncStatus {
    let host_id = host.id;
    let cfg = resolve_vnc_config(state, host);
    if let Some(session) = get_session(host_id).await {
        return VncStatus {
            host_id,
            transport: cfg.transport,
            port: session.port,
            running: true,
            started: session.managed,
            implementation: host.vnc_implementation.clone(),
            display: session.display,
            managed: session.managed,
            requirements: vec![],
        };
    }
    let probe = probe_vnc(
        {
            let state = state.clone();
            let host = host.clone();
            move || {
                let state = state.clone();
                let host = host.clone();
                Box::pin(async move { open_vnc_stream(&state, &host, None).await })
            }
        },
        4000,
    )
    .await;
    if probe.running {
        return VncStatus {
            host_id,
            transport: cfg.transport,
            port: cfg.vnc_port,
            running: true,
            started: false,
            implementation: host.vnc_implementation.clone(),
            display: None,
            managed: false,
            requirements: vec![],
        };
    }
    let diagnostics = if cfg.ssh.is_some() {
        diagnose_vnc_environment(state, host).await
    } else {
        None
    };
    let implementation = resolve_implementation(diagnostics.as_ref(), host);
    VncStatus {
        host_id,
        transport: cfg.transport,
        port: cfg.vnc_port,
        running: false,
        started: false,
        implementation: host.vnc_implementation.clone(),
        display: host.vnc_display,
        managed: false,
        requirements: get_vnc_requirements(diagnostics.as_ref(), &implementation),
    }
}

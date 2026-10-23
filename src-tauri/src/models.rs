use serde::de::Deserializer;
use serde::{Deserialize, Serialize};

/// Serde helper: `None` = field absent, `Some(None)` = JSON null, `Some(Some(v))` = value.
pub fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Host {
    pub id: i64,
    pub group_id: Option<i64>,
    pub name: String,
    pub host: String,
    pub port: i64,
    pub username: String,
    pub connection_type: String,
    pub agent_forward: bool,
    pub auth_method: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub pass_phrase: Option<String>,
    pub remote_command: Option<String>,
    pub keepalive: i64,
    pub color: String,
    pub favorite: bool,
    pub notes: String,
    pub vnc_transport: Option<String>,
    pub vnc_port: Option<i64>,
    pub vnc_password: Option<String>,
    pub vnc_ssh_host_id: Option<i64>,
    pub vnc_display: Option<i64>,
    pub vnc_desktop_mode: Option<String>,
    pub vnc_auto_start: bool,
    pub vnc_auto_stop: bool,
    pub vnc_implementation: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct HostInput {
    pub name: Option<String>,
    pub host: Option<String>,
    pub port: Option<i64>,
    pub username: Option<String>,
    pub connection_type: Option<String>,
    pub agent_forward: Option<bool>,
    pub auth_method: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub password: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub private_key: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub pass_phrase: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub remote_command: Option<Option<String>>,
    pub keepalive: Option<i64>,
    pub color: Option<String>,
    pub favorite: Option<bool>,
    pub notes: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub group_id: Option<Option<i64>>,
    pub vnc_transport: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub vnc_port: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub vnc_password: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub vnc_ssh_host_id: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub vnc_display: Option<Option<i64>>,
    pub vnc_desktop_mode: Option<String>,
    pub vnc_auto_start: Option<bool>,
    pub vnc_auto_stop: Option<bool>,
    pub vnc_implementation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostGroup {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub color: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct GroupInput {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub parent_id: Option<Option<i64>>,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: i64,
    pub name: String,
    pub content: String,
    pub tags: String,
    pub favorite: bool,
    pub group_id: Option<i64>,
    #[serde(rename = "protected")]
    pub protected_: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct SnippetInput {
    pub name: Option<String>,
    pub content: Option<String>,
    pub tags: Option<String>,
    pub favorite: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub group_id: Option<Option<i64>>,
    #[serde(rename = "protected", default)]
    pub protected_: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Theme {
    pub id: i64,
    pub name: String,
    pub colors: serde_json::Map<String, serde_json::Value>,
    pub is_default: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ThemeInput {
    pub name: Option<String>,
    pub colors: Option<serde_json::Map<String, serde_json::Value>>,
    pub is_default: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditLog {
    pub id: i64,
    pub action: String,
    pub host_id: Option<i64>,
    pub detail: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownHost {
    pub id: i64,
    pub host: String,
    pub port: i64,
    pub key_type: String,
    pub fingerprint: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForward {
    pub id: i64,
    pub host_id: i64,
    pub local_port: i64,
    pub remote_host: String,
    pub remote_port: i64,
    pub protocol: String,
    pub auto_start: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PortForwardInput {
    pub host_id: i64,
    pub local_port: i64,
    pub remote_host: Option<String>,
    pub remote_port: i64,
    pub protocol: Option<String>,
    pub auto_start: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppPassword {
    pub id: i64,
    pub name: String,
    pub scope: String,
    pub revoked: bool,
    pub created_at: String,
    pub last_used_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppPasswordCreated {
    #[serde(flatten)]
    pub password: AppPassword,
    pub token: String,
}

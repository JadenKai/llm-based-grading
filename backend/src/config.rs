//! Persistent settings (`~/.config/llm-grading/settings.json`). API keys never leave the
//! backend: `SettingsView` replaces them with a `KeyStatus`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::events::ModelRef;

pub const OLLAMA_LOCAL_ID: &str = "ollama-local";
pub const OLLAMA_CLOUD_ID: &str = "ollama-cloud";

#[derive(Serialize, Deserialize, TS, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ThinkSetting {
    /// Let the model/server decide.
    #[default]
    Default,
    Off,
    On,
    Low,
    Medium,
    High,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug, Default, PartialEq)]
#[serde(default)]
#[ts(export)]
pub struct ModelParams {
    pub temperature: Option<f32>,
    pub top_p: Option<f32>,
    pub top_k: Option<u32>,
    pub num_ctx: Option<u32>,
    pub max_tokens: Option<u32>,
    #[ts(type = "number | null")]
    pub seed: Option<i64>,
    pub think: Option<ThinkSetting>,
}

impl ModelParams {
    /// Field-wise override: values set in `other` win.
    pub fn merged(&self, other: &ModelParams) -> ModelParams {
        ModelParams {
            temperature: other.temperature.or(self.temperature),
            top_p: other.top_p.or(self.top_p),
            top_k: other.top_k.or(self.top_k),
            num_ctx: other.num_ctx.or(self.num_ctx),
            max_tokens: other.max_tokens.or(self.max_tokens),
            seed: other.seed.or(self.seed),
            think: other.think.or(self.think),
        }
    }
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct ModelOverride {
    pub provider_id: String,
    pub model: String,
    pub params: ModelParams,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(default)]
#[ts(export)]
pub struct OllamaLocalConfig {
    pub enabled: bool,
    pub base_url: String,
}

impl Default for OllamaLocalConfig {
    fn default() -> Self {
        Self { enabled: true, base_url: "http://127.0.0.1:11434".into() }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct OllamaCloudConfig {
    pub enabled: bool,
    pub base_url: String,
    pub api_key: Option<String>,
}

impl Default for OllamaCloudConfig {
    fn default() -> Self {
        Self { enabled: true, base_url: "https://ollama.com".into(), api_key: None }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct OpenAiEndpoint {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub api_key: Option<String>,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[serde(default)]
#[ts(export)]
pub struct GradingOptions {
    pub fact_check: bool,
    pub max_fact_checks: u32,
    pub max_lints_per_paragraph: u32,
    pub disabled_lint_kinds: Vec<String>,
    pub dialect: String,
    pub concurrency_local: u32,
    pub concurrency_remote: u32,
}

impl Default for GradingOptions {
    fn default() -> Self {
        Self {
            fact_check: true,
            max_fact_checks: 3,
            max_lints_per_paragraph: 8,
            disabled_lint_kinds: vec![],
            dialect: "American".into(),
            concurrency_local: 1,
            concurrency_remote: 4,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub ollama_local: OllamaLocalConfig,
    pub ollama_cloud: OllamaCloudConfig,
    pub openai_compat: Vec<OpenAiEndpoint>,
    pub defaults: ModelParams,
    pub overrides: Vec<ModelOverride>,
    pub default_model: Option<ModelRef>,
    pub system_prompt: Option<String>,
    pub grading: GradingOptions,
    pub max_agent_iterations: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            ollama_local: Default::default(),
            ollama_cloud: Default::default(),
            openai_compat: vec![],
            defaults: ModelParams { temperature: Some(0.3), num_ctx: Some(16384), ..Default::default() },
            overrides: vec![],
            default_model: None,
            system_prompt: None,
            grading: Default::default(),
            max_agent_iterations: 12,
        }
    }
}

impl Settings {
    /// The Ollama key: `OLLAMA_API_KEY` in the environment wins over the stored one.
    pub fn ollama_key(&self) -> Option<String> {
        std::env::var("OLLAMA_API_KEY")
            .ok()
            .filter(|k| !k.trim().is_empty())
            .or_else(|| self.ollama_cloud.api_key.clone().filter(|k| !k.trim().is_empty()))
    }

    pub fn params_for(&self, model: &ModelRef) -> ModelParams {
        self.overrides
            .iter()
            .find(|o| o.provider_id == model.provider_id && o.model == model.model)
            .map(|o| self.defaults.merged(&o.params))
            .unwrap_or_else(|| self.defaults.clone())
    }

    pub fn load(path: &Path) -> Settings {
        match std::fs::read_to_string(path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
                tracing::warn!("ignoring unreadable settings file {}: {e}", path.display());
                Settings::default()
            }),
            Err(_) => Settings::default(),
        }
    }

    pub fn save(&self, path: &Path) -> anyhow::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    pub fn view(&self) -> SettingsView {
        let env_key = std::env::var("OLLAMA_API_KEY").ok().filter(|k| !k.trim().is_empty());
        SettingsView {
            ollama_local: self.ollama_local.clone(),
            ollama_cloud: OllamaCloudView {
                enabled: self.ollama_cloud.enabled,
                base_url: self.ollama_cloud.base_url.clone(),
                api_key: None,
                key_status: KeyStatus::of(
                    env_key.as_deref().or(self.ollama_cloud.api_key.as_deref()),
                    env_key.is_some(),
                ),
            },
            openai_compat: self
                .openai_compat
                .iter()
                .map(|e| OpenAiEndpointView {
                    id: e.id.clone(),
                    label: e.label.clone(),
                    base_url: e.base_url.clone(),
                    enabled: e.enabled,
                    api_key: None,
                    key_status: KeyStatus::of(e.api_key.as_deref(), false),
                })
                .collect(),
            defaults: self.defaults.clone(),
            overrides: self.overrides.clone(),
            default_model: self.default_model.clone(),
            system_prompt: self.system_prompt.clone(),
            grading: self.grading.clone(),
            max_agent_iterations: self.max_agent_iterations,
        }
    }

    /// Apply an update from the UI. A `None` key keeps the stored key, `""` clears it.
    pub fn apply(&mut self, v: SettingsView) {
        fn merge_key(old: Option<String>, new: Option<String>) -> Option<String> {
            match new {
                None => old,
                Some(k) if k.trim().is_empty() => None,
                Some(k) => Some(k.trim().to_string()),
            }
        }
        self.ollama_local = v.ollama_local;
        self.ollama_cloud = OllamaCloudConfig {
            enabled: v.ollama_cloud.enabled,
            base_url: v.ollama_cloud.base_url,
            api_key: merge_key(self.ollama_cloud.api_key.take(), v.ollama_cloud.api_key),
        };
        let old = std::mem::take(&mut self.openai_compat);
        self.openai_compat = v
            .openai_compat
            .into_iter()
            .map(|e| {
                let prev = old.iter().find(|o| o.id == e.id).and_then(|o| o.api_key.clone());
                OpenAiEndpoint {
                    id: e.id,
                    label: e.label,
                    base_url: e.base_url,
                    enabled: e.enabled,
                    api_key: merge_key(prev, e.api_key),
                }
            })
            .collect();
        self.defaults = v.defaults;
        self.overrides = v.overrides;
        self.default_model = v.default_model;
        self.system_prompt = v.system_prompt.filter(|s| !s.trim().is_empty());
        self.grading = v.grading;
        self.max_agent_iterations = v.max_agent_iterations.clamp(1, 50);
    }
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct KeyStatus {
    pub has_key: bool,
    /// Last four characters, for recognition only.
    pub hint: Option<String>,
    pub from_env: bool,
}

impl KeyStatus {
    fn of(key: Option<&str>, from_env: bool) -> Self {
        let key = key.filter(|k| !k.trim().is_empty());
        KeyStatus {
            has_key: key.is_some(),
            hint: key.map(|k| {
                let chars: Vec<char> = k.chars().collect();
                let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
                format!("…{tail}")
            }),
            from_env,
        }
    }
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct OllamaCloudView {
    pub enabled: bool,
    pub base_url: String,
    /// Write-only: always `null` when read.
    pub api_key: Option<String>,
    #[serde(default = "no_key")]
    pub key_status: KeyStatus,
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct OpenAiEndpointView {
    pub id: String,
    pub label: String,
    pub base_url: String,
    pub enabled: bool,
    /// Write-only: always `null` when read.
    pub api_key: Option<String>,
    #[serde(default = "no_key")]
    pub key_status: KeyStatus,
}

fn no_key() -> KeyStatus {
    KeyStatus { has_key: false, hint: None, from_env: false }
}

#[derive(Serialize, Deserialize, TS, Clone, Debug)]
#[ts(export)]
pub struct SettingsView {
    pub ollama_local: OllamaLocalConfig,
    pub ollama_cloud: OllamaCloudView,
    pub openai_compat: Vec<OpenAiEndpointView>,
    pub defaults: ModelParams,
    pub overrides: Vec<ModelOverride>,
    pub default_model: Option<ModelRef>,
    pub system_prompt: Option<String>,
    pub grading: GradingOptions,
    pub max_agent_iterations: u32,
}

pub struct Paths {
    pub settings: PathBuf,
    pub sessions: PathBuf,
}

impl Paths {
    pub fn resolve() -> Paths {
        let dirs = directories::ProjectDirs::from("", "", "llm-grading");
        let (config, data) = match &dirs {
            Some(d) => (d.config_dir().to_path_buf(), d.data_dir().to_path_buf()),
            None => (PathBuf::from(".llm-grading"), PathBuf::from(".llm-grading")),
        };
        let config = std::env::var("GRADER_CONFIG_DIR").map(PathBuf::from).unwrap_or(config);
        let data = std::env::var("GRADER_DATA_DIR").map(PathBuf::from).unwrap_or(data);
        Paths { settings: config.join("settings.json"), sessions: data.join("sessions") }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn view_never_contains_key() {
        let mut s = Settings::default();
        s.ollama_cloud.api_key = Some("sk-secret-abcd".into());
        let json = serde_json::to_string(&s.view()).unwrap();
        assert!(!json.contains("sk-secret"));
        assert!(json.contains("…abcd"));
    }

    #[test]
    fn apply_keeps_and_clears_keys() {
        let mut s = Settings::default();
        s.ollama_cloud.api_key = Some("k1".into());
        let v = s.view();
        s.apply(v.clone());
        assert_eq!(s.ollama_cloud.api_key.as_deref(), Some("k1"));
        let mut v2 = v;
        v2.ollama_cloud.api_key = Some(String::new());
        s.apply(v2);
        assert_eq!(s.ollama_cloud.api_key, None);
    }
}

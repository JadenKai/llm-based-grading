//! Builds providers from settings and lists their models for the picker.

use serde::Serialize;
use ts_rs::TS;

use super::Provider;
use super::ollama::OllamaProvider;
use super::openai::OpenAiProvider;
use crate::config::{OLLAMA_CLOUD_ID, OLLAMA_LOCAL_ID, Settings};

#[derive(Serialize, TS, Clone, Copy, Debug)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum ProviderKind {
    OllamaLocal,
    OllamaCloud,
    OpenaiCompat,
}

#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct ModelEntry {
    pub id: String,
    pub caps: Vec<String>,
    pub size: Option<String>,
}

#[derive(Serialize, TS, Clone, Debug)]
#[ts(export)]
pub struct ProviderModels {
    pub provider_id: String,
    pub label: String,
    pub kind: ProviderKind,
    pub models: Vec<ModelEntry>,
    pub error: Option<String>,
}

pub fn providers(settings: &Settings, http: &reqwest::Client) -> Vec<(String, String, ProviderKind, Provider)> {
    let mut out = Vec::new();
    if settings.ollama_local.enabled {
        out.push((
            OLLAMA_LOCAL_ID.to_string(),
            "Ollama (local)".to_string(),
            ProviderKind::OllamaLocal,
            Provider::Ollama(OllamaProvider {
                http: http.clone(),
                base_url: settings.ollama_local.base_url.clone(),
                api_key: None,
            }),
        ));
    }
    if settings.ollama_cloud.enabled
        && let Some(key) = settings.ollama_key()
    {
        out.push((
            OLLAMA_CLOUD_ID.to_string(),
            "Ollama Cloud".to_string(),
            ProviderKind::OllamaCloud,
            Provider::Ollama(OllamaProvider {
                http: http.clone(),
                base_url: settings.ollama_cloud.base_url.clone(),
                api_key: Some(key),
            }),
        ));
    }
    for e in settings.openai_compat.iter().filter(|e| e.enabled) {
        out.push((
            e.id.clone(),
            e.label.clone(),
            ProviderKind::OpenaiCompat,
            Provider::OpenAi(OpenAiProvider {
                http: http.clone(),
                base_url: e.base_url.clone(),
                api_key: e.api_key.clone().filter(|k| !k.is_empty()),
            }),
        ));
    }
    out
}

pub fn resolve(settings: &Settings, http: &reqwest::Client, provider_id: &str) -> anyhow::Result<Provider> {
    providers(settings, http).into_iter().find(|(id, ..)| id == provider_id).map(|(.., p)| p).ok_or_else(|| {
        if provider_id == OLLAMA_CLOUD_ID {
            anyhow::anyhow!("Ollama Cloud needs an API key (Settings → Ollama Cloud)")
        } else {
            anyhow::anyhow!("provider '{provider_id}' is not configured or is disabled")
        }
    })
}

/// A readable reason a provider's model list could not be fetched.
fn describe_error(kind: ProviderKind, base_url: &str, e: &anyhow::Error) -> String {
    let unreachable = e.downcast_ref::<reqwest::Error>().is_some_and(|r| r.is_connect() || r.is_timeout());
    match (kind, unreachable) {
        (ProviderKind::OllamaLocal, true) => {
            format!("Ollama isn't running at {base_url}. Start it with `ollama serve`.")
        }
        (_, true) => format!("Can't reach {base_url}."),
        _ => e.to_string(),
    }
}

pub async fn list_all(settings: &Settings, http: &reqwest::Client) -> Vec<ProviderModels> {
    let futs = providers(settings, http).into_iter().map(|(id, label, kind, p)| async move {
        let base_url = match &p {
            Provider::Ollama(o) => o.base_url.clone(),
            Provider::OpenAi(o) => o.base_url.clone(),
        };
        let (models, error) = match p.list_models().await {
            Ok(ms) => (ms.into_iter().map(|m| ModelEntry { id: m.id, caps: m.caps, size: m.size }).collect(), None),
            Err(e) => (vec![], Some(describe_error(kind, &base_url, &e))),
        };
        ProviderModels { provider_id: id, label, kind, models, error }
    });
    let mut out = futures::future::join_all(futs).await;
    // Keep Ollama Cloud visible in the picker even without a key, so it is discoverable.
    if settings.ollama_cloud.enabled && settings.ollama_key().is_none() {
        let at = out.iter().position(|p| !matches!(p.kind, ProviderKind::OllamaLocal)).unwrap_or(out.len());
        out.insert(
            at,
            ProviderModels {
                provider_id: OLLAMA_CLOUD_ID.to_string(),
                label: "Ollama Cloud".to_string(),
                kind: ProviderKind::OllamaCloud,
                models: vec![],
                error: Some("No API key yet. Add one in Settings to use large cloud models.".into()),
            },
        );
    }
    out
}

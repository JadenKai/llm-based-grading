//! Ollama hosted web search / fetch (`https://ollama.com/api/web_search|web_fetch`).

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::llm::send_with_retry;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchResult {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub links: Vec<String>,
}

#[derive(Clone)]
pub struct WebClient {
    pub http: reqwest::Client,
    pub base_url: String,
    pub api_key: String,
}

impl WebClient {
    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.trim_end_matches('/'), path)
    }

    pub async fn search(&self, query: &str, max_results: u32) -> anyhow::Result<Vec<SearchResult>> {
        #[derive(Deserialize)]
        struct Resp {
            results: Vec<SearchResult>,
        }
        let body = json!({"query": query, "max_results": max_results.clamp(1, 10)});
        let url = self.url("/api/web_search");
        let resp = send_with_retry(|| self.http.post(&url).bearer_auth(&self.api_key).json(&body)).await?;
        Ok(resp.json::<Resp>().await?.results)
    }

    pub async fn fetch(&self, url_to_fetch: &str) -> anyhow::Result<FetchResult> {
        let body = json!({"url": url_to_fetch});
        let url = self.url("/api/web_fetch");
        let resp = send_with_retry(|| self.http.post(&url).bearer_auth(&self.api_key).json(&body)).await?;
        Ok(resp.json().await?)
    }
}

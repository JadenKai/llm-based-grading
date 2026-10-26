mod agent;
mod api;
mod config;
mod events;
mod grammar;
mod llm;
mod presets;
mod rubric;
mod session;
mod state;
mod text;
mod web;

use std::sync::Arc;

use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::{Paths, Settings};
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| "essay_grader=info,tower_http=warn".into()),
        )
        .init();

    let paths = Paths::resolve();
    let settings = Settings::load(&paths.settings);
    tracing::info!("settings: {}", paths.settings.display());
    let store = session::Store::open(paths.sessions.clone());

    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .user_agent(concat!("essay-grader/", env!("CARGO_PKG_VERSION")))
        .build()?;

    let state = Arc::new(AppState {
        settings: std::sync::RwLock::new(settings),
        paths,
        http,
        grammar: Arc::new(grammar::Grammar::default()),
        store,
        runs: Default::default(),
    });

    // Warm the Harper dictionary off the request path.
    {
        let g = state.grammar.clone();
        tokio::task::spawn_blocking(move || {
            g.check_blocking(
                &[events::Paragraph { key: "P0".into(), index: 0, text: "Warm up.".into() }],
                harper_core::Dialect::American,
                &[],
                1,
            )
        });
    }

    let cors = CorsLayer::new()
        .allow_origin(["http://localhost:5173".parse().unwrap(), "http://127.0.0.1:5173".parse().unwrap()])
        .allow_methods(tower_http::cors::Any)
        .allow_headers(tower_http::cors::Any);

    let app = api::router(state).layer(cors).layer(TraceLayer::new_for_http());
    let addr = std::env::var("GRADER_ADDR").unwrap_or_else(|_| "127.0.0.1:8080".into());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

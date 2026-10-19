//! Shared application state and the run/event broadcaster. Runs are decoupled from HTTP
//! requests: a client that reloads mid-run re-attaches and gets the backlog replayed.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use dashmap::DashMap;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::config::{Paths, Settings};
use crate::events::{Envelope, Event, RunKind};
use crate::grammar::Grammar;
use crate::session::Store;

pub struct AppState {
    pub settings: std::sync::RwLock<Settings>,
    pub paths: Paths,
    pub http: reqwest::Client,
    pub grammar: Arc<Grammar>,
    pub store: Store,
    pub runs: DashMap<String, Arc<Run>>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub fn settings(&self) -> Settings {
        self.settings.read().unwrap().clone()
    }
}

struct RunLog {
    events: Vec<Envelope>,
    done: bool,
}

pub struct Run {
    pub id: String,
    pub kind: RunKind,
    pub cancel: CancellationToken,
    seq: AtomicU64,
    log: Mutex<RunLog>,
    tx: broadcast::Sender<Envelope>,
}

impl Run {
    pub fn new(kind: RunKind) -> Arc<Run> {
        let (tx, _) = broadcast::channel(8192);
        Arc::new(Run {
            id: format!("run_{}", Uuid::new_v4().simple()),
            kind,
            cancel: CancellationToken::new(),
            seq: AtomicU64::new(0),
            log: Mutex::new(RunLog { events: vec![], done: false }),
            tx,
        })
    }

    pub fn emit(&self, event: Event) {
        let finished = matches!(event, Event::RunFinished { .. });
        let mut log = self.log.lock().unwrap();
        let env = Envelope { seq: self.seq.fetch_add(1, Ordering::SeqCst), run_id: self.id.clone(), event };
        log.events.push(env.clone());
        if finished {
            log.done = true;
        }
        // No receivers is fine: the client may have gone away; the log keeps everything.
        let _ = self.tx.send(env);
    }

    pub fn events(&self) -> Vec<Envelope> {
        self.log.lock().unwrap().events.clone()
    }

    /// Backlog + live receiver, taken atomically so no event is missed or duplicated.
    pub fn subscribe(&self) -> (Vec<Envelope>, Option<broadcast::Receiver<Envelope>>) {
        let log = self.log.lock().unwrap();
        let rx = if log.done { None } else { Some(self.tx.subscribe()) };
        (log.events.clone(), rx)
    }
}

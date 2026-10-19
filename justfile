set shell := ["bash", "-c"]

# Install frontend dependencies
install:
    cd frontend && bun install

# Run backend (:8080) and frontend (:5173) together
dev:
    #!/usr/bin/env bash
    trap 'kill 0' EXIT
    (cd backend && cargo run) &
    (cd frontend && bun run dev) &
    wait

backend:
    cd backend && cargo run

frontend:
    cd frontend && bun run dev

# Regenerate frontend/src/api/gen from the Rust types (ts-rs)
gen-types:
    cd backend && cargo test export_bindings -q

test:
    cd backend && cargo test
    cd frontend && bun run test && bun run typecheck

fmt:
    cd backend && cargo fmt

build:
    cd backend && cargo build --release
    cd frontend && bun run build

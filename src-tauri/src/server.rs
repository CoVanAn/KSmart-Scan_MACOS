use axum::{
    routing::get,
    Router,
};
use tower_http::services::ServeDir;
use std::sync::Arc;
use tokio::signal;

use crate::*;

pub struct AppState {
    pub config: Arc<config::Config>,
    pub creds: credentials::CredentialStore,
    pub scanner: scanner::ScanManager,
    pub streams: stream::StreamManager,
}

pub async fn run_server() -> Result<(), anyhow::Error> {
    let cfg = Arc::new(config::load_config());
    let creds = credentials::CredentialStore::new(cfg.data_dir.clone());
    
    
    let scanner = scanner::ScanManager::new(cfg.clone());
    let streams = stream::StreamManager::new(cfg.clone());
    
    let state = Arc::new(AppState {
        config: cfg.clone(),
        creds,
        scanner,
        streams,
    });
    
    // Serve public directory
    let public_dir = std::env::current_dir()?.parent().unwrap().join("public");
    
    let app = Router::new()
        .merge(api::routes())
        .route("/ws/events", get(websocket::ws_events_handler))
        .route("/ws/stream", get(websocket::ws_stream_handler))
        .layer(tower_http::cors::CorsLayer::permissive())
        .fallback_service(ServeDir::new(public_dir))
        .with_state(state.clone());
        
    let addr = format!("{}:{}", cfg.host, cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    
    println!("\n  find-ip-device (Rust) dang chay: http://{}", addr);
    let ifaces = network::list_interfaces();
    println!("  Interface phat hien duoc:");
    for i in ifaces {
        println!("    - {}  {}  (quet: {})", i.name, i.address, i.scan_cidr);
    }
    
    if cfg.host == "127.0.0.1" {
        println!("  (Chi truy cap tu may nay. Dat HOST=0.0.0.0 neu can mo cho may khac.)\n");
    } else {
        println!("");
    }
    
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(state))
        .await?;
        
    Ok(())
}

async fn shutdown_signal(state: Arc<AppState>) {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        signal::unix::signal(signal::unix::SignalKind::terminate())
            .expect("failed to install signal handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    println!("\nDang dong...");
    state.streams.stop_all().await;
}

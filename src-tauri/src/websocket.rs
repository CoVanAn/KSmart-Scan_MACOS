use axum::{
    extract::{ws::{WebSocket, Message}, State, WebSocketUpgrade, Query},
    response::IntoResponse,
};
use futures_util::{stream::StreamExt, SinkExt};
use serde::Deserialize;
use std::sync::Arc;
use crate::server::AppState;
use crate::stream::StreamEvent;

pub async fn ws_events_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_events_socket(socket, state))
}

async fn handle_events_socket(mut socket: WebSocket, state: Arc<AppState>) {
    let creds = state.creds.list_safe();
    let mut saved_ips = std::collections::HashSet::new();
    for c in &creds {
        saved_ips.insert(c.ip.clone());
    }
    
    let mut devices = state.scanner.list_devices().await;
    for dev in &mut devices {
        dev.has_credentials = saved_ips.contains(&dev.ip);
    }
    
    let scan: Option<crate::scanner::ScanState> = None;
    // We cannot access active_scan_id because it's private in ScanManager, but we can list active scans or add a method.
    // I will add get_active_scan() to ScanManager later.
    
    let streams = state.streams.list().await;
    
    let initial_msg = serde_json::json!({
        "type": "snapshot",
        "devices": devices,
        "scan": scan,
        "streams": streams,
    });
    
    if socket.send(Message::Text(serde_json::to_string(&initial_msg).unwrap().into())).await.is_err() {
        return;
    }

    let mut rx = state.scanner.subscribe();
    
    tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            let payload = serde_json::to_string(&event).unwrap();
            if socket.send(Message::Text(payload.into())).await.is_err() {
                break;
            }
        }
    });
}

#[derive(Deserialize)]
pub struct StreamQuery {
    ip: String,
    channel: Option<u16>,
    stream: Option<String>,
    transcode: Option<String>,
}

pub async fn ws_stream_handler(
    ws: WebSocketUpgrade,
    Query(params): Query<StreamQuery>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_stream_socket(socket, state, params))
}

async fn handle_stream_socket(mut socket: WebSocket, state: Arc<AppState>, params: StreamQuery) {
    let re = regex::Regex::new(r"^\d{1,3}(?:\.\d{1,3}){3}$").unwrap();
    if !re.is_match(&params.ip) || !crate::network::is_private(&params.ip) {
        let _ = socket.send(Message::Text(r#"{"type":"error","error":"IP không hợp lệ"}"#.into())).await;
        let _ = socket.close().await;
        return;
    }
    
    let cred = match state.creds.get(&params.ip) {
        Some(c) => c,
        None => {
            let _ = socket.send(Message::Text(r#"{"type":"error","error":"Chưa có tài khoản cho camera này. Hãy nhập tài khoản trước."}"#.into())).await;
            let _ = socket.close().await;
            return;
        }
    };
    
    let channel = params.channel.unwrap_or(1);
    let stream_type = if params.stream.as_deref() == Some("sub") { "sub" } else { "main" };
    let force_transcode = params.transcode.as_deref() == Some("1");
    
    let rtsp_url = crate::rtsp::build_rtsp_url(&crate::rtsp::RtspUrlOpts {
        ip: &params.ip,
        port: cred.rtsp_port,
        username: Some(&cred.username),
        password: cred.password.as_deref(),
        channel,
        stream: stream_type,
        path: cred.rtsp_path.as_deref(),
        legacy: cred.legacy,
    });
    
    let key = format!("{}:{}/{}/{}{}", params.ip, cred.rtsp_port, channel, stream_type, if force_transcode { "/tc" } else { "" });
    
    let session = match state.streams.acquire(&key, &rtsp_url, force_transcode).await {
        Ok(s) => s,
        Err(e) => {
            let _ = socket.send(Message::Text(format!(r#"{{"type":"error","error":"{}"}}"#, e).into())).await;
            let _ = socket.close().await;
            return;
        }
    };
    
    let meta = {
        let s = session.lock().await;
        s.meta.clone()
    };
    
    let meta_json = serde_json::json!({
        "type": "meta",
        "codec": meta.codec,
        "width": meta.width,
        "height": meta.height,
        "fps": meta.fps,
        "profile": meta.profile,
        "level": meta.level,
        "transcode": meta.transcode,
        "forced": meta.forced,
        "key": key,
    });
    
    if socket.send(Message::Text(serde_json::to_string(&meta_json).unwrap().into())).await.is_err() {
        return;
    }
    
    let mut rx = {
        let s = session.lock().await;
        let init_seg = s.init_segment.try_lock().unwrap().clone();
        if let Some(init) = init_seg {
            if socket.send(Message::Binary(init)).await.is_err() {
                return;
            }
        }
        s.tx.subscribe()
    };
    
    let (mut sender, mut _receiver) = socket.split();
    
    tokio::spawn(async move {
        while let Ok(event) = rx.recv().await {
            match event {
                StreamEvent::Init(buf) => {
                    if sender.send(Message::Binary(buf)).await.is_err() {
                        break;
                    }
                }
                StreamEvent::Segment(buf) => {
                    if sender.send(Message::Binary(buf)).await.is_err() {
                        break;
                    }
                }
                StreamEvent::Error(err) => {
                    let _ = sender.send(Message::Text(format!(r#"{{"type":"error","error":"{}"}}"#, err).into())).await;
                    let _ = sender.close().await;
                    break;
                }
            }
        }
    });
}

use axum::{
    extract::{Path, State, Query, Json},
    response::IntoResponse,
    http::StatusCode,
    routing::{get, post, delete},
    Router,
};
use serde::Deserialize;
use std::sync::Arc;
use crate::server::AppState;
use crate::network;
use crate::hikvision;

pub fn routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/interfaces", get(get_interfaces))
        .route("/api/scan", post(start_scan))
        .route("/api/scan/{id}/cancel", post(cancel_scan))
        .route("/api/scan/{id}", get(get_scan))
        .route("/api/devices", get(get_devices))
        .route("/api/devices/{ip}", get(get_device))
        .route("/api/devices/{ip}/credentials", post(save_credentials))
        .route("/api/devices/{ip}/credentials", delete(delete_credentials))
        .route("/api/devices/{ip}/channels", get(get_channels))
        .route("/api/devices/{ip}/snapshot", get(get_snapshot))
        .route("/api/streams", get(get_streams))
}

fn is_private_ip(ip: &str) -> Result<(), (StatusCode, axum::Json<serde_json::Value>)> {
    let re = regex::Regex::new(r"^\d{1,3}(?:\.\d{1,3}){3}$").unwrap();
    if !re.is_match(ip) {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "IP không hợp lệ" }))));
    }
    if !network::is_private(ip) {
        return Err((StatusCode::FORBIDDEN, Json(serde_json::json!({ "error": "Chỉ hỗ trợ IP trong mạng nội bộ (private)" }))));
    }
    Ok(())
}

async fn get_interfaces(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let interfaces = network::list_interfaces();
    let suggested = interfaces.iter().find(|i| network::is_private(&i.address)).cloned().or_else(|| interfaces.first().cloned());
    
    Json(serde_json::json!({
        "interfaces": interfaces,
        "suggested": suggested,
        "defaultPorts": state.config.scan.ports,
    }))
}

#[derive(Deserialize)]
struct ScanOptions {
    cidr: Option<String>,
    ports: Option<Vec<u16>>,
    iface: Option<String>,
    #[serde(rename = "useArpScan")]
    use_arp_scan: Option<bool>,
}

async fn start_scan(State(state): State<Arc<AppState>>, Json(opts): Json<ScanOptions>) -> Result<impl IntoResponse, (StatusCode, axum::Json<serde_json::Value>)> {
    let target = if let Some(c) = opts.cidr {
        c
    } else {
        let interfaces = network::list_interfaces();
        if let Some(i) = interfaces.iter().find(|i| network::is_private(&i.address)) {
            i.scan_cidr.clone()
        } else {
            return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "Không tìm thấy card mạng phù hợp" }))));
        }
    };
    
    match state.scanner.start(&target, opts.iface, opts.ports, opts.use_arp_scan).await {
        Ok(scan) => Ok(Json(serde_json::json!({ "scan": scan }))),
        Err(e) => {
            let status = if e.to_string() == "SCAN_BUSY" { StatusCode::CONFLICT } else { StatusCode::INTERNAL_SERVER_ERROR };
            Err((status, Json(serde_json::json!({ "error": e.to_string() }))))
        }
    }
}

async fn cancel_scan(Path(id): Path<String>, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let cancelled = state.scanner.cancel(Some(id)).await;
    Json(serde_json::json!({ "cancelled": cancelled }))
}

async fn get_scan(Path(id): Path<String>, State(state): State<Arc<AppState>>) -> impl IntoResponse {
    if let Some(scan) = state.scanner.get_scan(&id).await {
        let mut devs = Vec::new();
        let devices = state.scanner.list_devices().await;
        for ip in &scan.found {
            if let Some(d) = devices.iter().find(|d| d.ip == *ip) {
                devs.push(d.clone());
            }
        }
        
        let mut scan_val = serde_json::to_value(&scan).unwrap();
        if let Some(obj) = scan_val.as_object_mut() {
            obj.remove("found");
            obj.insert("foundCount".to_string(), serde_json::json!(scan.found.len()));
        }
        
        (StatusCode::OK, Json(serde_json::json!({
            "scan": scan_val,
            "devices": devs,
        })))
    } else {
        (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Không tìm thấy phiên quét" })))
    }
}

async fn get_devices(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let creds = state.creds.list_safe();
    let mut saved_ips = std::collections::HashSet::new();
    for c in &creds {
        saved_ips.insert(c.ip.clone());
    }
    
    let mut devices = state.scanner.list_devices().await;
    for dev in &mut devices {
        dev.has_credentials = saved_ips.contains(&dev.ip);
    }
    
    let streams = state.streams.list().await;
    
    Json(serde_json::json!({
        "devices": devices,
        "credentials": creds,
        "streams": streams,
    }))
}

async fn get_device(Path(ip): Path<String>, State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, (StatusCode, axum::Json<serde_json::Value>)> {
    is_private_ip(&ip)?;
    
    let devices = state.scanner.list_devices().await;
    if let Some(mut dev) = devices.into_iter().find(|d| d.ip == ip) {
        dev.has_credentials = state.creds.has(&ip);
        Ok(Json(serde_json::json!({ "device": dev })))
    } else {
        Err((StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "Thiết bị chưa được quét" }))))
    }
}

#[derive(Deserialize)]
struct SaveCredsParams {
    username: Option<String>,
    password: Option<String>,
    #[serde(rename = "httpPort")]
    http_port: Option<u16>,
    #[serde(rename = "rtspPort")]
    rtsp_port: Option<u16>,
    tls: Option<bool>,
    #[serde(rename = "rtspPath")]
    rtsp_path: Option<String>,
    save: Option<bool>,
}

async fn save_credentials(Path(ip): Path<String>, State(state): State<Arc<AppState>>, Json(params): Json<SaveCredsParams>) -> Result<impl IntoResponse, (StatusCode, axum::Json<serde_json::Value>)> {
    is_private_ip(&ip)?;
    
    if params.username.is_none() {
        return Err((StatusCode::BAD_REQUEST, Json(serde_json::json!({ "error": "Thiếu username" }))));
    }
    
    let mut h_port = params.http_port.unwrap_or(80);
    let mut r_port = params.rtsp_port.unwrap_or(554);
    
    let devices = state.scanner.list_devices().await;
    if let Some(dev) = devices.into_iter().find(|d| d.ip == ip) {
        if params.http_port.is_none() { h_port = dev.http_port.unwrap_or(80); }
        if params.rtsp_port.is_none() { r_port = dev.rtsp_port.unwrap_or(554); }
    }
    
    let use_tls = params.tls.unwrap_or(h_port == 443);
    let custom_path = params.rtsp_path.filter(|s| !s.trim().is_empty());
    
    let mut isapi_ok = false;
    let mut isapi_error = None;
    let mut device_info = None;
    
    let username = params.username.as_deref().unwrap();
    let password = params.password.as_deref().unwrap_or("");
    
    let client = reqwest::Client::new();
    match hikvision::get_device_info(&client, &ip, h_port, username, password, use_tls).await {
        Ok((info, _)) => {
            isapi_ok = true;
            device_info = Some(info);
        }
        Err(e) => {
            isapi_error = Some(e.to_string());
        }
    }
    
    let mut rtsp_ok = false;
    let mut rtsp_error = None;
    let mut legacy_path = false;
    let mut rtsp_variant = String::new();
    let mut rtsp_url_template = String::new();
    let mut stream_info = None;
    
    let variants = if let Some(ref p) = custom_path {
        vec![(p.clone(), false, "path tự đặt")]
    } else {
        vec![(String::new(), false, "chuẩn Hikvision"), (String::new(), true, "Hikvision đời cũ")]
    };
    
    for (path, legacy, label) in variants {
        let url = crate::rtsp::build_rtsp_url(&crate::rtsp::RtspUrlOpts {
            ip: &ip,
            port: r_port,
            username: Some(username),
            password: Some(password),
            channel: 1,
            stream: "main",
            path: if path.is_empty() { None } else { Some(&path) },
            legacy,
        });
        
        match crate::stream::probe_stream(&url, state.config.stream.probe_timeout, &state.config.stream.ffprobe).await {
            Ok(info) => {
                rtsp_ok = true;
                legacy_path = legacy;
                rtsp_variant = label.to_string();
                rtsp_url_template = crate::rtsp::mask_url(&url);
                stream_info = Some(info);
                break;
            }
            Err(e) => {
                if rtsp_error.is_none() {
                    rtsp_error = Some(e.to_string());
                }
            }
        }
    }
    
    if !isapi_ok && !rtsp_ok {
        return Err((StatusCode::UNAUTHORIZED, Json(serde_json::json!({
            "error": format!("Không xác thực được. ISAPI: {}. RTSP: {}", isapi_error.unwrap_or_else(|| "lỗi".to_string()), rtsp_error.unwrap_or_else(|| "lỗi".to_string())),
            "code": "AUTH_FAILED"
        }))));
    }
    
    let mut channels = None;
    if isapi_ok {
        channels = Some(hikvision::get_channels(&client, &ip, h_port, username, password, use_tls).await);
    }
    
    let save = params.save.unwrap_or(true);
    if save {
        state.creds.set(&ip, username.to_string(), Some(password.to_string()), h_port, r_port, use_tls, custom_path.clone(), legacy_path);
    }
    
    Ok(Json(serde_json::json!({
        "ok": true,
        "result": {
            "ip": ip,
            "httpPort": h_port,
            "rtspPort": r_port,
            "tls": use_tls,
            "rtspPath": custom_path,
            "isapiOk": isapi_ok,
            "isapiError": isapi_error,
            "rtspOk": rtsp_ok,
            "rtspError": rtsp_error,
            "legacyPath": legacy_path,
            "rtspVariant": rtsp_variant,
            "rtspUrlTemplate": rtsp_url_template,
            "deviceInfo": device_info,
            "stream": stream_info,
            "channels": channels,
        }
    })))
}

async fn delete_credentials(Path(ip): Path<String>, State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, (StatusCode, axum::Json<serde_json::Value>)> {
    is_private_ip(&ip)?;
    let removed = state.creds.remove(&ip);
    Ok(Json(serde_json::json!({ "removed": removed })))
}

async fn get_channels(Path(ip): Path<String>, State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, (StatusCode, axum::Json<serde_json::Value>)> {
    is_private_ip(&ip)?;
    
    let cred = match state.creds.get(&ip) {
        Some(c) => c,
        None => return Err((StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "Chưa lưu tài khoản cho thiết bị này" })))),
    };
    
    let client = reqwest::Client::new();
    let pass = cred.password.as_deref().unwrap_or("");
    let channels = hikvision::get_channels(&client, &ip, cred.http_port, &cred.username, pass, cred.tls).await;
    
    Ok(Json(serde_json::json!({ "channels": channels })))
}

#[derive(Deserialize)]
struct SnapshotParams {
    channel: Option<u16>,
}

async fn get_snapshot(Path(ip): Path<String>, Query(params): Query<SnapshotParams>, State(state): State<Arc<AppState>>) -> Result<impl IntoResponse, (StatusCode, axum::Json<serde_json::Value>)> {
    is_private_ip(&ip)?;
    
    let cred = match state.creds.get(&ip) {
        Some(c) => c,
        None => return Err((StatusCode::UNAUTHORIZED, Json(serde_json::json!({ "error": "Chưa lưu tài khoản cho thiết bị này" })))),
    };
    
    let channel = params.channel.unwrap_or(101);
    
    let client = reqwest::Client::new();
    let pass = cred.password.as_deref().unwrap_or("");
    match hikvision::get_snapshot(&client, &ip, cred.http_port, &cred.username, pass, channel, cred.tls).await {
        Ok((buf, content_type)) => {
            let mut headers = axum::http::HeaderMap::new();
            headers.insert(axum::http::header::CONTENT_TYPE, content_type.parse().unwrap());
            headers.insert(axum::http::header::CACHE_CONTROL, "no-store".parse().unwrap());
            Ok((headers, buf))
        }
        Err(e) => {
            let status = if e.to_string() == "UNAUTHORIZED" { StatusCode::UNAUTHORIZED } else { StatusCode::BAD_GATEWAY };
            Err((status, Json(serde_json::json!({ "error": e.to_string() }))))
        }
    }
}

async fn get_streams(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let streams = state.streams.list().await;
    Json(serde_json::json!({ "streams": streams }))
}

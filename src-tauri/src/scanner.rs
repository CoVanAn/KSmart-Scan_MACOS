use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, broadcast};
use serde::Serialize;
use chrono::Utc;
use rand::{rng, Rng};
use reqwest::Client;

use crate::config::Config;
use crate::network;
use crate::portscan;
use crate::discovery::{discover_hosts, DiscoverOptions, HostHint};
use crate::rtsp::{probe_rtsp, RtspProbeResult};
use crate::oui;
use crate::hikvision::{self, DeviceInfo as HikDeviceInfo, ProbeResult};

pub const DEVICE_TYPE_HIKVISION: &str = "hikvision";
pub const DEVICE_TYPE_CAMERA: &str = "camera";
pub const DEVICE_TYPE_NORMAL: &str = "normal";

#[derive(Debug, Serialize, Clone)]
pub struct Device {
    pub ip: String,
    pub mac: Option<String>,
    pub vendor: Option<String>,
    #[serde(rename = "vendorSource")]
    pub vendor_source: Option<String>,
    #[serde(rename = "openPorts")]
    pub open_ports: Vec<u16>,
    #[serde(rename = "discoveredBy")]
    pub discovered_by: String,
    pub r#type: String,
    pub hostname: Option<String>,
    pub rtsp: Option<RtspProbeResult>,
    #[serde(rename = "rtspPort")]
    pub rtsp_port: Option<u16>,
    pub isapi: Option<ProbeResult>,
    #[serde(rename = "httpPort")]
    pub http_port: Option<u16>,
    #[serde(rename = "deviceInfo")]
    pub device_info: Option<HikDeviceInfo>,
    pub reasons: Vec<String>,
    #[serde(rename = "needsCredentials")]
    pub needs_credentials: bool,
    #[serde(rename = "hasCredentials")]
    pub has_credentials: bool,
    #[serde(rename = "firstSeen")]
    pub first_seen: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ScanSummary {
    pub total: usize,
    pub hikvision: usize,
    pub cameras: usize,
    pub normal: usize,
    #[serde(rename = "durationMs")]
    pub duration_ms: i64,
    pub method: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ScanState {
    pub id: String,
    pub cidr: String,
    pub iface: Option<String>,
    pub ports: Vec<u16>,
    pub status: String,
    pub phase: String,
    pub method: Option<String>,
    pub total: usize,
    pub done: usize,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    #[serde(rename = "finishedAt")]
    pub finished_at: Option<String>,
    pub notes: Vec<String>,
    pub found: Vec<String>,
    pub error: Option<String>,
    pub cancelled: bool,
    pub summary: Option<ScanSummary>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(tag = "type")]
pub enum ScanEvent {
    #[serde(rename = "scan:start")]
    ScanStart { scan_id: String, cidr: String, total: usize, ports: Vec<u16> },
    #[serde(rename = "scan:note")]
    ScanNote { scan_id: String, message: String },
    #[serde(rename = "scan:progress")]
    ScanProgress { scan_id: String, phase: String, done: usize, total: usize, found: usize },
    #[serde(rename = "scan:error")]
    ScanError { scan_id: String, error: String },
    #[serde(rename = "scan:done")]
    ScanDone { scan_id: String, status: String, summary: Option<ScanSummary> },
    #[serde(rename = "device")]
    DeviceUpdate { #[serde(rename = "scanId")] scan_id: Option<String>, device: Device },
}

pub struct ScanManager {
    scans: Arc<Mutex<HashMap<String, ScanState>>>,
    devices: Arc<Mutex<HashMap<String, Device>>>,
    active_scan_id: Arc<Mutex<Option<String>>>,
    tx: broadcast::Sender<ScanEvent>,
    config: Arc<Config>,
    client: Client,
}

impl ScanManager {
    pub fn new(config: Arc<Config>) -> Self {
        let (tx, _) = broadcast::channel(100);
        Self {
            scans: Arc::new(Mutex::new(HashMap::new())),
            devices: Arc::new(Mutex::new(HashMap::new())),
            active_scan_id: Arc::new(Mutex::new(None)),
            tx,
            config,
            client: Client::new(),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ScanEvent> {
        self.tx.subscribe()
    }

    pub async fn get_scan(&self, id: &str) -> Option<ScanState> {
        self.scans.lock().await.get(id).cloned()
    }

    pub async fn list_devices(&self) -> Vec<Device> {
        let mut devs: Vec<Device> = self.devices.lock().await.values().cloned().collect();
        devs.sort_by(|a, b| {
            let ia = network::ip_to_int(&a.ip).unwrap_or(0);
            let ib = network::ip_to_int(&b.ip).unwrap_or(0);
            ia.cmp(&ib)
        });
        devs
    }

    pub async fn start(&self, cidr: &str, iface: Option<String>, override_ports: Option<Vec<u16>>, use_arp_scan: Option<bool>) -> Result<ScanState, anyhow::Error> {
        let mut active_guard = self.active_scan_id.lock().await;
        if let Some(ref id) = *active_guard {
            let scans = self.scans.lock().await;
            if let Some(scan) = scans.get(id) {
                if scan.status == "running" {
                    return Err(anyhow::anyhow!("SCAN_BUSY"));
                }
            }
        }

        let ports = if let Some(p) = override_ports {
            p
        } else {
            self.config.scan.ports.clone()
        };

        let hosts = network::expand_cidr(cidr, Some(self.config.scan.max_hosts))?;

        let mut id_bytes = [0u8; 6];
        rng().fill_bytes(&mut id_bytes);
        let scan_id = hex::encode(id_bytes);

        let parsed_cidr = network::parse_cidr(cidr)?.cidr;

        let scan = ScanState {
            id: scan_id.clone(),
            cidr: parsed_cidr,
            iface: iface.clone(),
            ports: ports.clone(),
            status: "running".to_string(),
            phase: "discovery".to_string(),
            method: None,
            total: hosts.len(),
            done: 0,
            started_at: Utc::now().to_rfc3339(),
            finished_at: None,
            notes: Vec::new(),
            found: Vec::new(),
            error: None,
            cancelled: false,
            summary: None,
        };

        self.scans.lock().await.insert(scan_id.clone(), scan.clone());
        *active_guard = Some(scan_id.clone());
        
        self.devices.lock().await.clear();

        // Clone state for the background task
        let mgr = self.clone_for_task();
        let use_arp = use_arp_scan.unwrap_or(self.config.scan.use_arp_scan);
        let id_clone = scan_id.clone();
        
        tokio::spawn(async move {
            if let Err(e) = mgr.run_scan(&id_clone, hosts, use_arp).await {
                mgr.emit(ScanEvent::ScanError { scan_id: id_clone.clone(), error: e.to_string() });
                let mut scans = mgr.scans.lock().await;
                if let Some(s) = scans.get_mut(&id_clone) {
                    s.status = "error".to_string();
                    s.error = Some(e.to_string());
                    s.finished_at = Some(Utc::now().to_rfc3339());
                }
            }
        });

        Ok(scan)
    }

    pub async fn cancel(&self, id: Option<String>) -> bool {
        let mut active_guard = self.active_scan_id.lock().await;
        let target_id = if let Some(ref tid) = id {
            tid.clone()
        } else if let Some(ref tid) = *active_guard {
            tid.clone()
        } else {
            return false;
        };

        let mut scans = self.scans.lock().await;
        if let Some(scan) = scans.get_mut(&target_id) {
            if scan.status == "running" {
                scan.cancelled = true;
                return true;
            }
        }
        false
    }

    fn clone_for_task(&self) -> Self {
        Self {
            scans: self.scans.clone(),
            devices: self.devices.clone(),
            active_scan_id: self.active_scan_id.clone(),
            tx: self.tx.clone(),
            config: self.config.clone(),
            client: self.client.clone(),
        }
    }

    fn emit(&self, event: ScanEvent) {
        let _ = self.tx.send(event);
    }

    async fn note(&self, scan_id: &str, message: &str) {
        let mut scans = self.scans.lock().await;
        if let Some(s) = scans.get_mut(scan_id) {
            s.notes.push(message.to_string());
            self.emit(ScanEvent::ScanNote { scan_id: scan_id.to_string(), message: message.to_string() });
        }
    }

    async fn progress(&self, scan_id: &str) {
        let scans = self.scans.lock().await;
        if let Some(s) = scans.get(scan_id) {
            self.emit(ScanEvent::ScanProgress {
                scan_id: scan_id.to_string(),
                phase: s.phase.clone(),
                done: s.done,
                total: s.total,
                found: s.found.len(),
            });
        }
    }

    async fn run_scan(&self, scan_id: &str, hosts: Vec<String>, use_arp_scan: bool) -> Result<(), anyhow::Error> {
        let scan = self.get_scan(scan_id).await.unwrap();

        self.emit(ScanEvent::ScanStart {
            scan_id: scan_id.to_string(),
            cidr: scan.cidr.clone(),
            total: scan.total,
            ports: scan.ports.clone(),
        });

        let opts = DiscoverOptions {
            iface: scan.iface.clone(),
            use_nmap: self.config.scan.use_nmap,
            use_arp_scan,
            ping_concurrency: self.config.scan.ping_concurrency,
        };

        let (mut found, method) = discover_hosts(&scan.cidr, &hosts, opts).await;
        
        let cancelled = self.get_scan(scan_id).await.unwrap().cancelled;
        if cancelled {
            return self.finish_scan(scan_id, "cancelled").await;
        }

        {
            let mut scans = self.scans.lock().await;
            if let Some(s) = scans.get_mut(scan_id) {
                s.method = method.clone();
            }
        }
        self.note(scan_id, &format!("Phát hiện {} host đang sống bằng phương pháp {:?}.", found.len(), method)).await;

        let targets = if found.is_empty() {
            hosts
        } else {
            let mut ips: Vec<String> = found.iter().map(|h| h.ip.clone()).collect();
            ips.sort_by(|a, b| {
                network::ip_to_int(a).unwrap_or(0).cmp(&network::ip_to_int(b).unwrap_or(0))
            });
            ips
        };

        let meta_by_ip = Arc::new(found.into_iter().map(|h| (h.ip.clone(), h)).collect::<HashMap<String, HostHint>>());

        {
            let mut scans = self.scans.lock().await;
            if let Some(s) = scans.get_mut(scan_id) {
                s.phase = "portscan".to_string();
                s.total = targets.len();
                s.done = 0;
            }
        }
        self.progress(scan_id).await;

        use futures_util::stream::{self, StreamExt};
        let stream = stream::iter(targets);
        let config = &self.config;
        
        let concurrency = config.scan.host_concurrency;

        let mut results = stream.map(|ip| {
            let meta_by_ip = Arc::clone(&meta_by_ip);
            async move {
                let cancelled = self.get_scan(scan_id).await.unwrap().cancelled;
                if cancelled {
                    return;
                }
                
                let meta = meta_by_ip.get(&ip).cloned();
                let ports = self.get_scan(scan_id).await.unwrap().ports;
                
                match self.inspect_host(&ip, meta, &ports).await {
                    Ok(Some(dev)) => {
                        self.upsert_device(scan_id, dev).await;
                    }
                    Ok(None) => {}
                    Err(e) => {
                        self.note(scan_id, &format!("Lỗi khi kiểm tra {}: {}", ip, e)).await;
                    }
                }
                
                let mut done_count = 0;
                let mut total_count = 0;
                {
                    let mut scans = self.scans.lock().await;
                    if let Some(s) = scans.get_mut(scan_id) {
                        s.done += 1;
                        done_count = s.done;
                        total_count = s.total;
                    }
                }
                
                if done_count % 4 == 0 || done_count == total_count {
                    self.progress(scan_id).await;
                }
            }
        }).buffer_unordered(concurrency);
        
        while let Some(_) = results.next().await {}

        let cancelled = self.get_scan(scan_id).await.unwrap().cancelled;
        self.finish_scan(scan_id, if cancelled { "cancelled" } else { "done" }).await
    }

    async fn upsert_device(&self, scan_id: &str, mut device: Device) {
        let mut devices = self.devices.lock().await;
        
        let first_seen = if let Some(prev) = devices.get(&device.ip) {
            prev.first_seen.clone().unwrap_or_else(|| Utc::now().to_rfc3339())
        } else {
            Utc::now().to_rfc3339()
        };
        
        device.first_seen = Some(first_seen);
        device.updated_at = Some(Utc::now().to_rfc3339());
        
        devices.insert(device.ip.clone(), device.clone());
        
        let mut scans = self.scans.lock().await;
        if let Some(s) = scans.get_mut(scan_id) {
            if !s.found.contains(&device.ip) {
                s.found.push(device.ip.clone());
            }
        }
        
        self.emit(ScanEvent::DeviceUpdate {
            scan_id: Some(scan_id.to_string()),
            device,
        });
    }

    async fn finish_scan(&self, scan_id: &str, status: &str) -> Result<(), anyhow::Error> {
        let mut scans = self.scans.lock().await;
        if let Some(scan) = scans.get_mut(scan_id) {
            scan.status = status.to_string();
            scan.phase = "finished".to_string();
            scan.finished_at = Some(Utc::now().to_rfc3339());
            
            let devices_map = self.devices.lock().await;
            let mut devs = Vec::new();
            for ip in &scan.found {
                if let Some(d) = devices_map.get(ip) {
                    devs.push(d.clone());
                }
            }
            
            let hikvision_count = devs.iter().filter(|d| d.r#type == DEVICE_TYPE_HIKVISION).count();
            let cameras_count = devs.iter().filter(|d| d.r#type == DEVICE_TYPE_CAMERA).count();
            let normal_count = devs.iter().filter(|d| d.r#type == DEVICE_TYPE_NORMAL).count();
            
            let duration = if let (Ok(start), Ok(end)) = (
                chrono::DateTime::parse_from_rfc3339(&scan.started_at), 
                chrono::DateTime::parse_from_rfc3339(scan.finished_at.as_ref().unwrap())
            ) {
                end.timestamp_millis() - start.timestamp_millis()
            } else {
                0
            };

            let summary = ScanSummary {
                total: devs.len(),
                hikvision: hikvision_count,
                cameras: cameras_count,
                normal: normal_count,
                duration_ms: duration,
                method: scan.method.clone(),
            };
            scan.summary = Some(summary.clone());
            
            self.emit(ScanEvent::ScanDone {
                scan_id: scan_id.to_string(),
                status: status.to_string(),
                summary: Some(summary),
            });
        }
        
        let mut active_guard = self.active_scan_id.lock().await;
        if let Some(ref aid) = *active_guard {
            if aid == scan_id {
                *active_guard = None;
            }
        }
        Ok(())
    }

    async fn inspect_host(&self, ip: &str, meta: Option<HostHint>, ports: &[u16]) -> Result<Option<Device>, anyhow::Error> {
        let open_ports = portscan::scan_host_ports(ip, ports, self.config.scan.port_timeout, 16).await;
        
        let is_alive = !open_ports.is_empty() 
            || meta.as_ref().map(|m| m.mac.is_some()).unwrap_or(false)
            || meta.as_ref().map(|m| m.source == "nmap" || m.source == "ping").unwrap_or(false);
            
        if !is_alive {
            return Ok(None);
        }

        let mac = meta.as_ref().and_then(|m| m.mac.clone());
        let vendor_from_oui = mac.as_deref().and_then(oui::lookup_vendor).map(|s| s.to_string());
        let vendor = vendor_from_oui.clone()
            .or_else(|| meta.as_ref().and_then(|m| m.vendor_hint.clone()));
            
        let vendor_source = if vendor_from_oui.is_some() {
            Some("oui".to_string())
        } else if meta.as_ref().and_then(|m| m.vendor_hint.clone()).is_some() {
            Some("scan".to_string())
        } else {
            None
        };

        let mut device = Device {
            ip: ip.to_string(),
            mac: mac.clone(),
            vendor: vendor.clone(),
            vendor_source,
            open_ports: open_ports.clone(),
            discovered_by: meta.as_ref().map(|m| m.source.clone()).unwrap_or_else(|| "portscan".to_string()),
            r#type: DEVICE_TYPE_NORMAL.to_string(),
            hostname: None,
            rtsp: None,
            rtsp_port: None,
            isapi: None,
            http_port: None,
            device_info: None,
            reasons: Vec::new(),
            needs_credentials: false,
            has_credentials: false,
            first_seen: None,
            updated_at: None,
        };

        let rtsp_port = open_ports.iter().find(|&&p| p == 554 || p == 8554).copied();
        let camera_port_open = open_ports.iter().any(|p| self.config.scan.camera_ports.contains(p));

        if let Some(rp) = rtsp_port {
            let res = probe_rtsp(ip, rp, 2500).await;
            device.rtsp = Some(res.clone());
            device.rtsp_port = Some(rp);
            
            if res.rtsp {
                device.r#type = DEVICE_TYPE_CAMERA.to_string();
                device.reasons.push(format!("Cổng {} trả lời giao thức RTSP", rp));
                if let Some(srv) = &res.server {
                    device.reasons.push(format!("RTSP Server: {}", srv));
                    if srv.to_lowercase().contains("hikvision") {
                        device.r#type = DEVICE_TYPE_HIKVISION.to_string();
                    }
                }
                if let Some(r) = &res.realm {
                    if r.to_lowercase().contains("ip camera") || r.to_lowercase().contains("ds-") {
                        device.r#type = DEVICE_TYPE_HIKVISION.to_string();
                    }
                }
            }
        }

        let http_candidates: Vec<u16> = open_ports.iter().filter(|&&p| self.config.scan.http_ports.contains(&p)).copied().collect();
        let is_camera_vendor = oui::is_camera_vendor(vendor.as_deref());

        if camera_port_open || is_camera_vendor {
            let ports_to_try = if http_candidates.is_empty() { vec![80] } else { http_candidates.clone() };
            for p in ports_to_try {
                let tls = p == 443;
                let probe = hikvision::probe_anonymous(&self.client, ip, p, tls).await;
                if probe.isapi || probe.is_hikvision {
                    device.isapi = Some(probe.clone());
                    device.http_port = Some(p);
                    device.reasons.extend(probe.evidence.clone());
                    
                    if probe.is_hikvision {
                        device.r#type = DEVICE_TYPE_HIKVISION.to_string();
                        if device.vendor.is_none() || device.vendor_source.as_deref() != Some("oui") {
                            device.vendor = Some("Hikvision".to_string());
                            device.vendor_source = Some("isapi".to_string());
                        }
                    } else if device.r#type == DEVICE_TYPE_NORMAL {
                        device.r#type = DEVICE_TYPE_CAMERA.to_string();
                    }
                    if let Some(di) = probe.device_info {
                        device.device_info = Some(di);
                    }
                    break;
                }
            }
        }

        if open_ports.contains(&8000) && device.r#type == DEVICE_TYPE_NORMAL {
            device.r#type = DEVICE_TYPE_CAMERA.to_string();
            device.reasons.push("Cổng 8000 (SDK Hikvision) đang mở".to_string());
        }
        if is_camera_vendor && device.r#type == DEVICE_TYPE_NORMAL {
            device.r#type = DEVICE_TYPE_CAMERA.to_string();
            device.reasons.push(format!("MAC thuộc dải của {}", vendor.unwrap_or_default()));
        }
        if device.vendor.as_deref() == Some("Hikvision") && device.r#type == DEVICE_TYPE_CAMERA {
            device.r#type = DEVICE_TYPE_HIKVISION.to_string();
        }

        device.needs_credentials = device.r#type != DEVICE_TYPE_NORMAL && device.device_info.is_none();
        if device.http_port.is_none() {
            device.http_port = Some(http_candidates.first().copied().unwrap_or(80));
        }
        if device.rtsp_port.is_none() {
            device.rtsp_port = Some(if open_ports.contains(&554) { 554 } else { 554 });
        }

        Ok(Some(device))
    }
}

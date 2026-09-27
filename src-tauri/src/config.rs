use std::env;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct ScanConfig {
    pub ports: Vec<u16>,
    pub camera_ports: Vec<u16>,
    pub http_ports: Vec<u16>,
    pub port_timeout: u64,
    pub port_concurrency: usize,
    pub host_concurrency: usize,
    pub ping_concurrency: usize,
    pub max_hosts: usize,
    pub use_nmap: bool,
    pub use_arp_scan: bool,
}

#[derive(Clone, Debug)]
pub struct StreamConfig {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub idle_timeout: u64,
    pub frag_duration: u64,
    pub transcode_bitrate: String,
    pub transcode_preset: String,
    pub max_sessions: usize,
    pub probe_timeout: u64,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub scan: ScanConfig,
    pub stream: StreamConfig,
}

fn num_env<T: std::str::FromStr>(key: &str, default: T) -> T {
    env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn list_env(key: &str, default: &str) -> Vec<u16> {
    let val = env::var(key).unwrap_or_else(|_| default.to_string());
    val.split(',')
        .filter_map(|s| s.trim().parse().ok())
        .filter(|&n| n > 0)
        .collect()
}

pub fn load_config() -> Config {
    let current_dir = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    // Since we run from backend-rust, data is at ../data
    let default_data_dir = current_dir.join("..").join("data");

    Config {
        host: env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
        port: num_env("PORT", 3000),
        data_dir: env::var("DATA_DIR").map(PathBuf::from).unwrap_or(default_data_dir),
        scan: ScanConfig {
            ports: list_env("SCAN_PORTS", "554,8000,80,443,8080,8554,2020,37777"),
            camera_ports: vec![554, 8000, 8554, 37777],
            http_ports: vec![80, 8080, 443],
            port_timeout: num_env("PORT_TIMEOUT", 900),
            port_concurrency: num_env("PORT_CONCURRENCY", 300),
            host_concurrency: num_env("HOST_CONCURRENCY", 64),
            ping_concurrency: num_env("PING_CONCURRENCY", 128),
            max_hosts: num_env("MAX_HOSTS", 4096),
            use_nmap: env::var("USE_NMAP").unwrap_or_default() != "0",
            use_arp_scan: env::var("USE_ARP_SCAN").unwrap_or_default() == "1",
        },
        stream: StreamConfig {
            ffmpeg: env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_string()),
            ffprobe: env::var("FFPROBE_PATH").unwrap_or_else(|_| "ffprobe".to_string()),
            idle_timeout: num_env("STREAM_IDLE_TIMEOUT", 8000),
            frag_duration: num_env("FRAG_DURATION", 400000),
            transcode_bitrate: env::var("TRANSCODE_BITRATE").unwrap_or_else(|_| "2000k".to_string()),
            transcode_preset: env::var("TRANSCODE_PRESET").unwrap_or_else(|_| "ultrafast".to_string()),
            max_sessions: num_env("MAX_STREAM_SESSIONS", 8),
            probe_timeout: num_env("PROBE_TIMEOUT", 12000),
        },
    }
}

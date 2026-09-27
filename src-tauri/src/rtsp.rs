use tokio::net::TcpStream;
use tokio::io::{AsyncWriteExt, AsyncReadExt};
use tokio::time::{timeout, Duration};
use regex::Regex;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RtspProbeResult {
    pub rtsp: bool,
    pub server: Option<String>,
    pub realm: Option<String>,
    pub requires_auth: bool,
    pub public: Option<String>,
}

pub async fn probe_rtsp(host: &str, port: u16, timeout_ms: u64) -> RtspProbeResult {
    let mut result = RtspProbeResult {
        rtsp: false,
        server: None,
        realm: None,
        requires_auth: false,
        public: None,
    };

    let addr = format!("{}:{}", host, port);
    let dur = Duration::from_millis(timeout_ms);
    
    let mut stream = match timeout(dur, TcpStream::connect(&addr)).await {
        Ok(Ok(s)) => s,
        _ => return result,
    };

    let req1 = format!("OPTIONS rtsp://{}:{}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: find-ip-device-rust\r\n\r\n", host, port);
    if stream.write_all(req1.as_bytes()).await.is_err() {
        return result;
    }

    let mut buf = [0u8; 4096];
    let mut response1 = String::new();
    
    loop {
        match timeout(dur, stream.read(&mut buf)).await {
            Ok(Ok(0)) | Err(_) | Ok(Err(_)) => break,
            Ok(Ok(n)) => {
                response1.push_str(&String::from_utf8_lossy(&buf[..n]));
                if response1.contains("\r\n\r\n") {
                    break;
                }
            }
        }
    }

    if response1.is_empty() {
        return result;
    }

    let re_rtsp = Regex::new(r"^RTSP/1\.\d\s+\d+").unwrap();
    if re_rtsp.is_match(&response1) {
        result.rtsp = true;
    }
    
    let re_server = Regex::new(r"(?im)^Server:\s*(.+)$").unwrap();
    if let Some(cap) = re_server.captures(&response1) {
        result.server = Some(cap[1].trim().to_string());
    }
    
    let re_public = Regex::new(r"(?im)^Public:\s*(.+)$").unwrap();
    if let Some(cap) = re_public.captures(&response1) {
        result.public = Some(cap[1].trim().to_string());
    }

    let req2 = format!("DESCRIBE rtsp://{}:{}/Streaming/Channels/101 RTSP/1.0\r\nCSeq: 2\r\nAccept: application/sdp\r\nUser-Agent: find-ip-device-rust\r\n\r\n", host, port);
    if stream.write_all(req2.as_bytes()).await.is_err() {
        return result;
    }

    let mut response2 = String::new();
    loop {
        match timeout(dur, stream.read(&mut buf)).await {
            Ok(Ok(0)) | Err(_) | Ok(Err(_)) => break,
            Ok(Ok(n)) => {
                response2.push_str(&String::from_utf8_lossy(&buf[..n]));
                if response2.contains("\r\n\r\n") {
                    break;
                }
            }
        }
    }

    let re_status = Regex::new(r"^RTSP/1\.\d\s+(\d+)").unwrap();
    if let Some(cap) = re_status.captures(&response2) {
        if let Ok(code) = cap[1].parse::<u16>() {
            if code == 401 {
                result.requires_auth = true;
            }
        }
    }
    
    let re_realm = Regex::new(r#"(?i)realm\s*=\s*"([^"]*)""#).unwrap();
    if let Some(cap) = re_realm.captures(&response2) {
        result.realm = Some(cap[1].to_string());
    }

    result
}

fn auth_part(username: Option<&str>, password: Option<&str>) -> String {
    if let Some(u) = username {
        if !u.is_empty() {
            let encoded_u = utf8_percent_encode(u, NON_ALPHANUMERIC).to_string();
            let p = password.unwrap_or("");
            let encoded_p = utf8_percent_encode(p, NON_ALPHANUMERIC).to_string();
            return format!("{}:{}@", encoded_u, encoded_p);
        }
    }
    String::new()
}

pub struct RtspUrlOpts<'a> {
    pub ip: &'a str,
    pub port: u16,
    pub username: Option<&'a str>,
    pub password: Option<&'a str>,
    pub channel: u16,
    pub stream: &'a str,
    pub path: Option<&'a str>,
    pub legacy: bool,
}

pub fn hik_rtsp_url(opts: &RtspUrlOpts) -> String {
    let stream_id = match opts.stream {
        "sub" => 2,
        "third" => 3,
        _ => 1,
    };
    format!("rtsp://{}{}:{}/Streaming/Channels/{}{}", 
        auth_part(opts.username, opts.password), 
        opts.ip, opts.port, opts.channel, stream_id)
}

pub fn hik_legacy_rtsp_url(opts: &RtspUrlOpts) -> String {
    let stream_id = match opts.stream {
        "sub" => "sub",
        _ => "main",
    };
    format!("rtsp://{}{}:{}/h264/ch{}/{}/av_stream", 
        auth_part(opts.username, opts.password), 
        opts.ip, opts.port, opts.channel, stream_id)
}

pub fn custom_rtsp_url(opts: &RtspUrlOpts) -> String {
    if let Some(p) = opts.path {
        let p_str = if p.starts_with('/') { p.to_string() } else { format!("/{}", p) };
        let stream_id = match opts.stream {
            "sub" => "1",
            _ => "0",
        };
        let resolved = p_str
            .replace("%CH%", &opts.channel.to_string())
            .replace("%ST%", stream_id);
        
        format!("rtsp://{}{}:{}{}", 
            auth_part(opts.username, opts.password), 
            opts.ip, opts.port, resolved)
    } else {
        hik_rtsp_url(opts)
    }
}

pub fn build_rtsp_url(opts: &RtspUrlOpts) -> String {
    if opts.path.is_some() && !opts.path.unwrap().trim().is_empty() {
        custom_rtsp_url(opts)
    } else if opts.legacy {
        hik_legacy_rtsp_url(opts)
    } else {
        hik_rtsp_url(opts)
    }
}

pub fn mask_url(url: &str) -> String {
    let re = Regex::new(r"//([^:/@]+):([^@]*)@").unwrap();
    re.replace(url, "//$1:***@").to_string()
}

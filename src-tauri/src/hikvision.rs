use crate::digest::{self, RequestOpts};
use reqwest::{Client, Method, header};
use regex::Regex;
use bytes::Bytes;
use serde::Serialize;
use std::cmp;

#[derive(Debug, Serialize, Clone)]
pub struct DeviceInfo {
    #[serde(rename = "deviceName")]
    pub device_name: Option<String>,
    #[serde(rename = "deviceId")]
    pub device_id: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "serialNumber")]
    pub serial_number: Option<String>,
    #[serde(rename = "macAddress")]
    pub mac_address: Option<String>,
    #[serde(rename = "firmwareVersion")]
    pub firmware_version: Option<String>,
    #[serde(rename = "firmwareReleasedDate")]
    pub firmware_released_date: Option<String>,
    #[serde(rename = "deviceType")]
    pub device_type: Option<String>,
    #[serde(rename = "encoderVersion")]
    pub encoder_version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProbeResult {
    pub isapi: bool,
    #[serde(rename = "isHikvision")]
    pub is_hikvision: bool,
    #[serde(rename = "anonymousAccess")]
    pub anonymous_access: bool,
    pub realm: Option<String>,
    #[serde(rename = "authScheme")]
    pub auth_scheme: Option<String>,
    pub server: Option<String>,
    pub status: Option<u16>,
    pub evidence: Vec<String>,
    pub error: Option<String>,
    #[serde(rename = "deviceInfo")]
    pub device_info: Option<DeviceInfo>,
}

pub fn xml_value(xml: &str, tag: &str) -> Option<String> {
    let re_str = format!(r"(?i)<{}[^>]*>([^<]*)</{}>", tag, tag);
    let re = Regex::new(&re_str).ok()?;
    re.captures(xml).and_then(|cap| cap.get(1)).map(|m| m.as_str().trim().to_string())
}

pub fn xml_all(xml: &str, tag: &str) -> Vec<String> {
    let re_str = format!(r"(?i)<{}[^>]*>([^<]*)</{}>", tag, tag);
    if let Ok(re) = Regex::new(&re_str) {
        re.captures_iter(xml)
            .filter_map(|cap| cap.get(1).map(|m| m.as_str().trim().to_string()))
            .collect()
    } else {
        Vec::new()
    }
}

pub fn parse_device_info(xml: &str) -> DeviceInfo {
    DeviceInfo {
        device_name: xml_value(xml, "deviceName"),
        device_id: xml_value(xml, "deviceID"),
        model: xml_value(xml, "model"),
        serial_number: xml_value(xml, "serialNumber"),
        mac_address: xml_value(xml, "macAddress"),
        firmware_version: xml_value(xml, "firmwareVersion"),
        firmware_released_date: xml_value(xml, "firmwareReleasedDate"),
        device_type: xml_value(xml, "deviceType"),
        encoder_version: xml_value(xml, "encoderVersion"),
    }
}

pub async fn probe_anonymous(client: &Client, ip: &str, port: u16, tls: bool) -> ProbeResult {
    let mut result = ProbeResult {
        isapi: false,
        is_hikvision: false,
        anonymous_access: false,
        realm: None,
        auth_scheme: None,
        server: None,
        status: None,
        evidence: Vec::new(),
        error: None,
        device_info: None,
    };

    let proto = if tls { "https" } else { "http" };
    let url = format!("{}://{}:{}/ISAPI/System/deviceInfo", proto, ip, port);

    let req = client.request(Method::GET, &url)
        .header(header::USER_AGENT, "find-ip-device/1.0-rust")
        .header(header::ACCEPT, "*/*");

    match req.send().await {
        Ok(res) => {
            let status = res.status();
            result.status = Some(status.as_u16());
            let headers = res.headers().clone();
            
            result.server = headers.get(header::SERVER).and_then(|v| v.to_str().ok()).map(|s| s.to_string());

            let auth_header = headers.get(header::WWW_AUTHENTICATE).and_then(|v| v.to_str().ok());
            if let Some(h) = auth_header {
                if let Some(challenge) = digest::parse_authenticate(h) {
                    result.auth_scheme = Some(challenge.scheme.clone());
                    result.realm = challenge.params.get("realm").cloned();
                }
            }

            if status.as_u16() == 401 || status.as_u16() == 200 {
                result.isapi = true;
                result.evidence.push(format!("ISAPI returned HTTP {}", status.as_u16()));
            }

            if let Ok(body) = res.bytes().await {
                let body_str = String::from_utf8_lossy(&body);
                
                let hay = format!("{} {} {}", 
                    result.realm.as_deref().unwrap_or(""), 
                    result.server.as_deref().unwrap_or(""), 
                    &body_str[..cmp::min(2000, body_str.len())]
                );
                
                let re_hik = Regex::new(r"(?i)hikvision|IP Camera|DS-[0-9A-Z]|App-webs|webs").unwrap();
                if re_hik.is_match(&hay) {
                    result.is_hikvision = true;
                    if let Some(r) = &result.realm {
                        result.evidence.push(format!("realm=\"{}\"", r));
                    }
                    if let Some(s) = &result.server {
                        result.evidence.push(format!("Server: {}", s));
                    }
                }
                
                if status.as_u16() == 200 {
                    let re_device = Regex::new(r"(?i)<DeviceInfo").unwrap();
                    if re_device.is_match(&body_str) {
                        result.is_hikvision = true;
                        result.isapi = true;
                        result.anonymous_access = true;
                        result.device_info = Some(parse_device_info(&body_str));
                    }
                }
            }
        },
        Err(e) => {
            result.error = Some(e.to_string());
        }
    }

    result
}

pub async fn get_device_info(
    client: &Client,
    ip: &str,
    port: u16,
    username: &str,
    password: &str,
    tls: bool
) -> Result<(DeviceInfo, Option<String>), anyhow::Error> {
    let proto = if tls { "https" } else { "http" };
    let path = "/ISAPI/System/deviceInfo";
    let url = format!("{}://{}:{}{}", proto, ip, port, path);

    let res = digest::request(RequestOpts {
        client,
        method: Method::GET,
        url,
        path: path.to_string(),
        username: Some(username),
        password: Some(password),
    }).await?;

    if res.status.as_u16() == 401 {
        return Err(anyhow::anyhow!("UNAUTHORIZED"));
    }
    if res.status.as_u16() == 403 {
        return Err(anyhow::anyhow!("FORBIDDEN"));
    }
    if res.status.as_u16() != 200 {
        return Err(anyhow::anyhow!("BAD_STATUS: {}", res.status.as_u16()));
    }

    let body_str = String::from_utf8_lossy(&res.body);
    Ok((parse_device_info(&body_str), res.auth_scheme))
}

#[derive(Debug, Serialize)]
pub struct Channel {
    pub id: u16,
    pub channel: u16,
    pub stream: String,
    pub name: String,
    pub codec: Option<String>,
    pub resolution: Option<String>,
    #[serde(rename = "frameRate")]
    pub frame_rate: Option<f64>,
    pub enabled: bool,
}

pub async fn get_channels(
    client: &Client,
    ip: &str,
    port: u16,
    username: &str,
    password: &str,
    tls: bool
) -> Vec<Channel> {
    let proto = if tls { "https" } else { "http" };
    let mut channels = Vec::new();

    let path1 = "/ISAPI/Streaming/channels";
    let url1 = format!("{}://{}:{}{}", proto, ip, port, path1);
    
    if let Ok(res) = digest::request(RequestOpts {
        client,
        method: Method::GET,
        url: url1,
        path: path1.to_string(),
        username: Some(username),
        password: Some(password),
    }).await {
        if res.status.as_u16() == 200 {
            let body_str = String::from_utf8_lossy(&res.body);
            let re_block = Regex::new(r"(?i)<StreamingChannel[\s>]").unwrap();
            let blocks: Vec<&str> = re_block.split(&body_str).skip(1).collect();
            
            for b in blocks {
                if let Some(id_str) = xml_value(b, "id") {
                    if let Ok(id_num) = id_str.parse::<u16>() {
                        let ch_num = id_num / 10;
                        let stream_num = id_num % 10;
                        
                        let stream = match stream_num {
                            1 => "main",
                            2 => "sub",
                            _ => "third",
                        };
                        
                        let name = xml_value(b, "channelName").unwrap_or_else(|| format!("Kênh {}", ch_num));
                        let codec = xml_value(b, "videoCodecType");
                        let res_w = xml_value(b, "videoResolutionWidth");
                        let res_h = xml_value(b, "videoResolutionHeight");
                        let resolution = if let (Some(w), Some(h)) = (res_w, res_h) {
                            Some(format!("{}x{}", w, h))
                        } else {
                            None
                        };
                        
                        let frame_rate = xml_value(b, "maxFrameRate")
                            .and_then(|s| s.parse::<f64>().ok())
                            .map(|v| v / 100.0);
                            
                        let enabled = xml_value(b, "enabled").unwrap_or_else(|| "true".to_string()) != "false";
                        
                        channels.push(Channel {
                            id: id_num,
                            channel: ch_num,
                            stream: stream.to_string(),
                            name,
                            codec,
                            resolution,
                            frame_rate,
                            enabled,
                        });
                    }
                }
            }
        }
    }

    if channels.is_empty() {
        let path2 = "/ISAPI/System/Video/inputs/channels";
        let url2 = format!("{}://{}:{}{}", proto, ip, port, path2);
        if let Ok(res) = digest::request(RequestOpts {
            client,
            method: Method::GET,
            url: url2,
            path: path2.to_string(),
            username: Some(username),
            password: Some(password),
        }).await {
            if res.status.as_u16() == 200 {
                let body_str = String::from_utf8_lossy(&res.body);
                let ids = xml_all(&body_str, "id");
                for id_str in ids {
                    if let Ok(ch) = id_str.parse::<u16>() {
                        if ch > 0 {
                            channels.push(Channel {
                                id: ch * 100 + 1, channel: ch, stream: "main".to_string(),
                                name: format!("Kênh {}", ch), codec: None, resolution: None,
                                frame_rate: None, enabled: true,
                            });
                            channels.push(Channel {
                                id: ch * 100 + 2, channel: ch, stream: "sub".to_string(),
                                name: format!("Kênh {}", ch), codec: None, resolution: None,
                                frame_rate: None, enabled: true,
                            });
                        }
                    }
                }
            }
        }
    }

    if channels.is_empty() {
        channels.push(Channel {
            id: 101, channel: 1, stream: "main".to_string(), name: "Kênh 1".to_string(),
            codec: None, resolution: None, frame_rate: None, enabled: true,
        });
        channels.push(Channel {
            id: 102, channel: 1, stream: "sub".to_string(), name: "Kênh 1".to_string(),
            codec: None, resolution: None, frame_rate: None, enabled: true,
        });
    }

    channels.sort_by_key(|c| c.id);
    channels
}

pub async fn get_snapshot(
    client: &Client,
    ip: &str,
    port: u16,
    username: &str,
    password: &str,
    channel: u16,
    tls: bool
) -> Result<(Bytes, String), anyhow::Error> {
    let proto = if tls { "https" } else { "http" };
    let path = format!("/ISAPI/Streaming/channels/{}/picture", channel);
    let url = format!("{}://{}:{}{}", proto, ip, port, path);

    let res = digest::request(RequestOpts {
        client,
        method: Method::GET,
        url,
        path: path.clone(),
        username: Some(username),
        password: Some(password),
    }).await?;

    if res.status.as_u16() != 200 {
        if res.status.as_u16() == 401 {
            return Err(anyhow::anyhow!("UNAUTHORIZED"));
        }
        return Err(anyhow::anyhow!("BAD_STATUS: {}", res.status.as_u16()));
    }

    let content_type = res.headers.get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();

    Ok((res.body, content_type))
}

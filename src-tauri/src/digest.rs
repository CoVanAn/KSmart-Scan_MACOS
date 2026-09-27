use std::collections::HashMap;
use rand::Rng;
use rand::rng;
use reqwest::{Client, Method, header};
use regex::Regex;
use hex::encode;

pub fn md5_hex(input: &str) -> String {
    format!("{:x}", md5::compute(input))
}

#[derive(Debug, Clone)]
pub struct Challenge {
    pub scheme: String,
    pub params: HashMap<String, String>,
}

pub fn parse_authenticate(header_val: &str) -> Option<Challenge> {
    if header_val.is_empty() {
        return None;
    }
    
    let parts: Vec<&str> = header_val.splitn(2, ' ').collect();
    if parts.len() != 2 {
        return None;
    }
    
    let scheme = parts[0].to_lowercase();
    let rest = parts[1].trim();

    let mut params = HashMap::new();
    let re = Regex::new(r#"([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|([^,\s]+))"#).unwrap();
    
    for cap in re.captures_iter(rest) {
        let key = cap[1].to_lowercase();
        let val = if let Some(m) = cap.get(2) {
            m.as_str().to_string()
        } else if let Some(m) = cap.get(3) {
            m.as_str().to_string()
        } else {
            String::new()
        };
        params.insert(key, val);
    }
    
    Some(Challenge { scheme, params })
}

pub struct DigestParams<'a> {
    pub username: &'a str,
    pub password: &'a str,
    pub method: &'a str,
    pub uri: &'a str,
    pub params: &'a HashMap<String, String>,
    pub nc: &'a str,
    pub cnonce: &'a str,
}

pub fn build_digest_header(opts: DigestParams) -> String {
    let realm = opts.params.get("realm").map(|s| s.as_str()).unwrap_or("");
    let nonce = opts.params.get("nonce").map(|s| s.as_str()).unwrap_or("");
    let opaque = opts.params.get("opaque").map(|s| s.as_str());
    let algorithm = opts.params.get("algorithm").map(|s| s.as_str());
    let qop = opts.params.get("qop").map(|s| s.as_str());

    let ha1 = md5_hex(&format!("{}:{}:{}", opts.username, realm, opts.password));
    let ha2 = md5_hex(&format!("{}:{}", opts.method, opts.uri));

    let qop_val = if let Some(q) = qop {
        if q.split(',').map(|s| s.trim()).any(|s| s == "auth") {
            Some("auth")
        } else {
            q.split(',').next().map(|s| s.trim())
        }
    } else {
        None
    };

    let response = if let Some(q) = qop_val {
        md5_hex(&format!("{}:{}:{}:{}:{}:{}", ha1, nonce, opts.nc, opts.cnonce, q, ha2))
    } else {
        md5_hex(&format!("{}:{}:{}", ha1, nonce, ha2))
    };

    let mut bits = vec![
        format!("username=\"{}\"", opts.username),
        format!("realm=\"{}\"", realm),
        format!("nonce=\"{}\"", nonce),
        format!("uri=\"{}\"", opts.uri),
        format!("response=\"{}\"", response),
    ];

    if let Some(a) = algorithm {
        bits.push(format!("algorithm={}", a));
    }
    if let Some(q) = qop_val {
        bits.push(format!("qop={}", q));
        bits.push(format!("nc={}", opts.nc));
        bits.push(format!("cnonce=\"{}\"", opts.cnonce));
    }
    if let Some(o) = opaque {
        bits.push(format!("opaque=\"{}\"", o));
    }

    format!("Digest {}", bits.join(", "))
}

pub struct RequestOpts<'a> {
    pub client: &'a Client,
    pub method: Method,
    pub url: String,
    pub path: String, // URI for digest calculation
    pub username: Option<&'a str>,
    pub password: Option<&'a str>,
}

#[derive(Debug)]
pub struct DigestResponse {
    pub status: reqwest::StatusCode,
    pub headers: reqwest::header::HeaderMap,
    pub body: bytes::Bytes,
    pub auth_scheme: Option<String>,
    pub realm: Option<String>,
}

pub async fn request(opts: RequestOpts<'_>) -> Result<DigestResponse, anyhow::Error> {
    let req = opts.client.request(opts.method.clone(), &opts.url)
        .header(header::USER_AGENT, "find-ip-device/1.0-rust")
        .header(header::ACCEPT, "*/*");

    let first_res = req.try_clone().unwrap().send().await?;
    let status = first_res.status();
    let headers = first_res.headers().clone();
    
    let auth_header = headers.get(header::WWW_AUTHENTICATE)
        .and_then(|v| v.to_str().ok());
    
    let challenge = auth_header.and_then(parse_authenticate);
    
    if status != reqwest::StatusCode::UNAUTHORIZED || opts.username.is_none() {
        let body = first_res.bytes().await?;
        return Ok(DigestResponse {
            status,
            headers,
            body,
            auth_scheme: challenge.as_ref().map(|c| c.scheme.clone()),
            realm: challenge.as_ref().and_then(|c| c.params.get("realm").cloned()),
        });
    }

    let challenge = match challenge {
        Some(c) => c,
        None => {
            let body = first_res.bytes().await?;
            return Ok(DigestResponse {
                status,
                headers,
                body,
                auth_scheme: None,
                realm: None,
            });
        }
    };

    let authorization = if challenge.scheme == "digest" {
        let mut cnonce_bytes = [0u8; 8];
        rng().fill_bytes(&mut cnonce_bytes);
        let cnonce = encode(cnonce_bytes);
        
        build_digest_header(DigestParams {
            username: opts.username.unwrap(),
            password: opts.password.unwrap_or(""),
            method: opts.method.as_str(),
            uri: &opts.path,
            params: &challenge.params,
            nc: "00000001",
            cnonce: &cnonce,
        })
    } else {
        // Basic auth
        let plain = format!("{}:{}", opts.username.unwrap(), opts.password.unwrap_or(""));
        use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
        format!("Basic {}", BASE64.encode(plain))
    };

    let second_res = opts.client.request(opts.method.clone(), &opts.url)
        .header(header::USER_AGENT, "find-ip-device/1.0-rust")
        .header(header::ACCEPT, "*/*")
        .header(header::AUTHORIZATION, authorization)
        .send().await?;

    let status = second_res.status();
    let headers = second_res.headers().clone();
    let body = second_res.bytes().await?;

    Ok(DigestResponse {
        status,
        headers,
        body,
        auth_scheme: Some(challenge.scheme),
        realm: challenge.params.get("realm").cloned(),
    })
}

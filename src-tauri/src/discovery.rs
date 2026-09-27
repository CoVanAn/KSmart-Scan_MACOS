use tokio::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn create_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}
use std::collections::{HashMap, HashSet};
use crate::oui::normalize_mac;
use futures_util::stream::{self, StreamExt};
use regex::Regex;

#[derive(Debug, Clone)]
pub struct HostHint {
    pub ip: String,
    pub mac: Option<String>,
    pub vendor_hint: Option<String>,
    pub source: String,
}

pub async fn has_command(cmd: &str) -> bool {
    create_command("which")
        .arg(cmd)
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub async fn nmap_ping(cidr: &str, timeout_ms: u64) -> Vec<HostHint> {
    let mut hosts = HashMap::new();
    
    let cmd = create_command("nmap")
        .args(&["-sn", "-n", "-T4", "--max-retries", "1", "--host-timeout", "5s", cidr])
        .output();
        
    if let Ok(Ok(output)) = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), cmd).await {
        if let Ok(stdout) = String::from_utf8(output.stdout) {
            let re_ip = Regex::new(r"Nmap scan report for (?:.*\()?(\d{1,3}(?:\.\d{1,3}){3})\)?\s*$").unwrap();
            let re_mac = Regex::new(r"MAC Address:\s*([0-9A-Fa-f:]{17})\s*(?:\((.*)\))?").unwrap();
            
            let mut current_ip: Option<String> = None;
            
            for line in stdout.lines() {
                if let Some(cap) = re_ip.captures(line.trim()) {
                    let ip = cap[1].to_string();
                    current_ip = Some(ip.clone());
                    hosts.insert(ip.clone(), HostHint {
                        ip,
                        mac: None,
                        vendor_hint: None,
                        source: "nmap".to_string(),
                    });
                    continue;
                }
                
                if let (Some(cap), Some(ip)) = (re_mac.captures(line.trim()), &current_ip) {
                    if let Some(host) = hosts.get_mut(ip) {
                        host.mac = normalize_mac(&cap[1]);
                        host.vendor_hint = cap.get(2).map(|m| m.as_str().to_string()).filter(|s| s != "Unknown");
                    }
                }
            }
        }
    }
    
    hosts.into_values().collect()
}

pub async fn ping_sweep(hosts: &[String], concurrency: usize) -> Vec<HostHint> {
    let stream = stream::iter(hosts.iter().cloned());
    
    let results = stream.map(|ip| async move {
        let cmd = create_command("ping")
            .args(&["-n", "-c", "1", "-W", "1", &ip])
            .output();
            
        let ok = match tokio::time::timeout(std::time::Duration::from_millis(2500), cmd).await {
            Ok(Ok(out)) => out.status.success(),
            _ => false,
        };
        
        if ok {
            Some(HostHint {
                ip,
                mac: None,
                vendor_hint: None,
                source: "ping".to_string(),
            })
        } else {
            None
        }
    })
    .buffer_unordered(concurrency)
    .collect::<Vec<Option<HostHint>>>()
    .await;
    
    results.into_iter().flatten().collect()
}

pub async fn read_neighbors() -> HashMap<String, String> {
    let mut out = HashMap::new();
    
    let mut parsed = false;
    if let Ok(Ok(output)) = tokio::time::timeout(
        std::time::Duration::from_millis(5000), 
        create_command("ip").args(&["-4", "neigh", "show"]).output()
    ).await {
        if output.status.success() {
            if let Ok(stdout) = String::from_utf8(output.stdout) {
                let re = Regex::new(r"^(\d{1,3}(?:\.\d{1,3}){3})\s+.*?lladdr\s+([0-9a-fA-F:]{17})").unwrap();
                for line in stdout.lines() {
                    if let Some(cap) = re.captures(line) {
                        if let Some(mac) = normalize_mac(&cap[2]) {
                            if mac != "00:00:00:00:00:00" {
                                out.insert(cap[1].to_string(), mac);
                            }
                        }
                    }
                }
                parsed = true;
            }
        }
    }
    
    if !parsed {
        if let Ok(Ok(output)) = tokio::time::timeout(
            std::time::Duration::from_millis(5000), 
            create_command("arp").arg("-an").output()
        ).await {
            if output.status.success() {
                if let Ok(stdout) = String::from_utf8(output.stdout) {
                    let re = Regex::new(r"\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-fA-F:]{17})").unwrap();
                    for line in stdout.lines() {
                        if let Some(cap) = re.captures(line) {
                            if let Some(mac) = normalize_mac(&cap[2]) {
                                if mac != "00:00:00:00:00:00" {
                                    out.insert(cap[1].to_string(), mac);
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    out
}

pub async fn arp_scan(iface: Option<&str>, timeout_ms: u64) -> Vec<HostHint> {
    let mut args = vec!["--localnet", "--retry=2", "--timeout=500"];
    let iface_arg;
    if let Some(i) = iface {
        iface_arg = format!("--interface={}", i);
        args.insert(0, &iface_arg);
    }
    
    let mut stdout_str = String::new();
    
    let cmd = create_command("arp-scan").args(&args).output();
    if let Ok(Ok(output)) = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), cmd).await {
        if output.status.success() {
            stdout_str = String::from_utf8_lossy(&output.stdout).to_string();
        }
    }
    
    if stdout_str.is_empty() {
        let mut sudo_args = vec!["-n", "arp-scan"];
        sudo_args.extend(args);
        let cmd = create_command("sudo").args(&sudo_args).output();
        if let Ok(Ok(output)) = tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), cmd).await {
            if output.status.success() {
                stdout_str = String::from_utf8_lossy(&output.stdout).to_string();
            }
        }
    }
    
    let mut hosts = Vec::new();
    let re = Regex::new(r"^(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F:]{17})\s*(.*)$").unwrap();
    
    for line in stdout_str.lines() {
        if let Some(cap) = re.captures(line.trim()) {
            let vendor_hint = cap.get(3).map(|m| m.as_str().trim().to_string())
                .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("(unknown)"));
                
            hosts.push(HostHint {
                ip: cap[1].to_string(),
                mac: normalize_mac(&cap[2]),
                vendor_hint,
                source: "arp-scan".to_string(),
            });
        }
    }
    
    hosts
}

pub struct DiscoverOptions {
    pub iface: Option<String>,
    pub use_nmap: bool,
    pub use_arp_scan: bool,
    pub ping_concurrency: usize,
}

pub async fn discover_hosts(cidr: &str, hosts: &[String], opts: DiscoverOptions) -> (Vec<HostHint>, Option<String>) {
    let mut found = Vec::new();
    let mut method = None;
    
    if opts.use_arp_scan && has_command("arp-scan").await {
        let res = arp_scan(opts.iface.as_deref(), 30000).await;
        if !res.is_empty() {
            found = res;
            method = Some("arp-scan".to_string());
        }
    }
    
    if found.is_empty() && opts.use_nmap && has_command("nmap").await {
        let res = nmap_ping(cidr, 60000).await;
        if !res.is_empty() {
            found = res;
            method = Some("nmap".to_string());
        }
    }
    
    if found.is_empty() {
        found = ping_sweep(hosts, opts.ping_concurrency).await;
        method = Some("ping".to_string());
    }
    
    let allowed: HashSet<String> = hosts.iter().cloned().collect();
    found.retain(|h| allowed.contains(&h.ip));
    
    let neigh = read_neighbors().await;
    let mut by_ip = HashMap::new();
    
    for mut h in found {
        if h.mac.is_none() {
            if let Some(mac) = neigh.get(&h.ip) {
                h.mac = Some(mac.clone());
            }
        }
        by_ip.insert(h.ip.clone(), h);
    }
    
    for (ip, mac) in neigh {
        if !by_ip.contains_key(&ip) && allowed.contains(&ip) {
            by_ip.insert(ip.clone(), HostHint {
                ip,
                mac: Some(mac),
                vendor_hint: None,
                source: "arp-cache".to_string(),
            });
        }
    }
    
    (by_ip.into_values().collect(), method)
}

use std::net::Ipv4Addr;
use get_if_addrs::{get_if_addrs, IfAddr};
use serde::Serialize;
use anyhow::{Result, anyhow};

pub fn ip_to_int(ip: &str) -> Result<u32> {
    let addr: Ipv4Addr = ip.parse()?;
    Ok(u32::from(addr))
}

pub fn int_to_ip(n: u32) -> String {
    Ipv4Addr::from(n).to_string()
}

pub fn netmask_to_prefix(netmask: &str) -> Result<u8> {
    let n = ip_to_int(netmask)?;
    let mut prefix = 0;
    for i in (0..=31).rev() {
        if (n >> i) & 1 == 1 {
            prefix += 1;
        } else {
            break;
        }
    }
    Ok(prefix)
}

#[derive(Debug)]
pub struct CidrInfo {
    pub network: u32,
    pub broadcast: u32,
    pub prefix: u8,
    pub cidr: String,
}

pub fn parse_cidr(cidr: &str) -> Result<CidrInfo> {
    let parts: Vec<&str> = cidr.split('/').collect();
    if parts.len() != 2 {
        return Err(anyhow!("Invalid CIDR"));
    }
    let ip = parts[0];
    let prefix: u8 = parts[1].parse()?;
    if prefix < 8 || prefix > 32 {
        return Err(anyhow!("Prefix must be between 8 and 32"));
    }
    
    let addr = ip_to_int(ip)?;
    let mask_bits = if prefix == 0 { 0 } else { (!0u32) << (32 - prefix) };
    let network = addr & mask_bits;
    let broadcast = network | !mask_bits;
    
    Ok(CidrInfo {
        network,
        broadcast,
        prefix,
        cidr: format!("{}/{}", int_to_ip(network), prefix),
    })
}

pub fn expand_cidr(cidr: &str, max_hosts: Option<usize>) -> Result<Vec<String>> {
    let info = parse_cidr(cidr)?;
    let mut first = info.network;
    let mut last = info.broadcast;
    
    if info.prefix <= 30 {
        first += 1;
        last -= 1;
    }
    
    let total = (last as i64 - first as i64 + 1).max(0) as usize;
    if let Some(max) = max_hosts {
        if total > max {
            return Err(anyhow!("Subnet too large ({} hosts). Max is {}.", total, max));
        }
    }
    
    let mut hosts = Vec::with_capacity(total);
    for i in first..=last {
        hosts.push(int_to_ip(i));
    }
    Ok(hosts)
}

pub fn cidr_of(address: &str, netmask: &str) -> Result<String> {
    let prefix = netmask_to_prefix(netmask)?;
    let info = parse_cidr(&format!("{}/{}", address, prefix))?;
    Ok(info.cidr)
}

#[derive(Debug, Serialize, Clone)]
pub struct InterfaceInfo {
    pub name: String,
    pub address: String,
    pub netmask: String,
    pub mac: String,
    pub cidr: String,
    #[serde(rename = "scanCidr")]
    pub scan_cidr: String,
}

pub fn list_interfaces() -> Vec<InterfaceInfo> {
    let mut out = Vec::new();
    if let Ok(interfaces) = get_if_addrs() {
        for iface in interfaces {
            if let IfAddr::V4(v4) = iface.addr {
                if v4.ip.is_loopback() {
                    continue;
                }
                let address = v4.ip.to_string();
                let netmask = v4.netmask.to_string();
                
                if let Ok(cidr) = cidr_of(&address, &netmask) {
                    let prefix: u8 = cidr.split('/').nth(1).unwrap_or("0").parse().unwrap_or(0);
                    let scan_cidr = if prefix < 24 {
                        cidr_of(&address, "255.255.255.0").unwrap_or_else(|_| cidr.clone())
                    } else {
                        cidr.clone()
                    };
                    
                    out.push(InterfaceInfo {
                        name: iface.name,
                        address,
                        netmask,
                        mac: String::new(),
                        cidr,
                        scan_cidr,
                    });
                }
            }
        }
    }
    out
}

pub fn is_private(ip: &str) -> bool {
    if let Ok(addr) = ip.parse::<Ipv4Addr>() {
        let octets = addr.octets();
        octets[0] == 10 ||
        (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] == 192 && octets[1] == 168) ||
        (octets[0] == 169 && octets[1] == 254) ||
        octets[0] == 127
    } else {
        false
    }
}

pub fn normalize_mac(mac: &str) -> Option<String> {
    if mac.is_empty() {
        return None;
    }
    let hex: String = mac
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    
    if hex.len() != 12 {
        return None;
    }
    
    let mut normalized = String::with_capacity(17);
    for (i, c) in hex.chars().enumerate() {
        if i > 0 && i % 2 == 0 {
            normalized.push(':');
        }
        normalized.push(c);
    }
    
    Some(normalized)
}

pub fn lookup_vendor(mac: &str) -> Option<&'static str> {
    let norm = normalize_mac(mac)?;
    let prefix = &norm[0..8];
    
    match prefix {
        // --- Hikvision ---
        "44:19:b6" | "4c:bd:8f" | "bc:ad:28" | "c0:56:e3" | "28:57:be" | 
        "58:03:fb" | "8c:e7:48" | "a4:14:37" | "e0:ba:ad" | "54:c4:15" | 
        "24:0f:9b" | "18:68:cb" | "3c:1b:f8" | "44:47:cc" | "98:8b:0a" | 
        "ac:b9:2f" | "b4:a3:82" | "d4:e8:53" | "f8:4d:fc" | "68:e2:07" | 
        "ec:c8:9c" | "1c:20:db" => Some("Hikvision"),
        
        // --- Dahua ---
        "3c:ef:8c" | "4c:11:bf" | "90:02:a9" | "bc:32:5f" | "e0:50:8b" | 
        "08:ee:8b" | "14:a7:8b" | "24:52:6a" | "38:af:29" | "9c:14:63" | 
        "a0:bd:1d" | "fc:5f:49" => Some("Dahua"),
        
        // --- Others ---
        "00:40:8c" | "ac:cc:8e" | "b8:a4:4f" => Some("Axis"),
        "48:ea:63" | "00:12:16" => Some("Uniview"),
        "00:0f:7c" | "d8:07:b6" | "54:af:97" => Some("TP-Link (Tapo/Vigi)"),
        "00:1a:4d" | "ec:71:db" => Some("Reolink"),
        "9c:8e:cd" => Some("Amcrest"),
        "00:80:f0" => Some("Panasonic"),
        "00:0e:8f" => Some("Sercomm"),
        "3c:e3:6b" | "54:2b:8d" => Some("Ezviz"),
        
        // --- Non-cameras ---
        "00:0c:29" | "00:50:56" => Some("VMware"),
        "08:00:27" => Some("VirtualBox"),
        "52:54:00" => Some("QEMU/KVM"),
        "b8:27:eb" | "dc:a6:32" | "e4:5f:01" | "2c:cf:67" => Some("Raspberry Pi"),
        
        _ => None,
    }
}

pub fn is_camera_vendor(vendor: Option<&str>) -> bool {
    matches!(
        vendor,
        Some("Hikvision") | Some("Dahua") | Some("Axis") | Some("Uniview") | 
        Some("Reolink") | Some("Amcrest") | Some("Ezviz") | Some("TP-Link (Tapo/Vigi)")
    )
}

pub fn is_hikvision_mac(mac: &str) -> bool {
    lookup_vendor(mac) == Some("Hikvision")
}

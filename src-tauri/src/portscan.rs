use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};
use futures_util::stream::{self, StreamExt};

pub async fn probe_port(host: &str, port: u16, timeout_ms: u64) -> bool {
    let addr = format!("{}:{}", host, port);
    let duration = Duration::from_millis(timeout_ms);
    match timeout(duration, TcpStream::connect(&addr)).await {
        Ok(Ok(_)) => true,
        _ => false,
    }
}

pub async fn scan_host_ports(host: &str, ports: &[u16], timeout_ms: u64, concurrency: usize) -> Vec<u16> {
    let stream = stream::iter(ports.iter().copied());
    let results = stream
        .map(|port| {
            let host_cloned = host.to_string();
            async move {
                if probe_port(&host_cloned, port, timeout_ms).await {
                    Some(port)
                } else {
                    None
                }
            }
        })
        .buffer_unordered(concurrency)
        .collect::<Vec<Option<u16>>>()
        .await;

    let mut open: Vec<u16> = results.into_iter().flatten().collect();
    open.sort_unstable();
    open
}

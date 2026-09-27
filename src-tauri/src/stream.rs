use std::sync::Arc;
use tokio::sync::{Mutex, broadcast, oneshot};
use tokio::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

fn create_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd
}
use std::process::Stdio;
use std::collections::HashMap;
use tokio::io::AsyncReadExt;
use bytes::Bytes;
use serde::{Serialize, Deserialize};
use std::time::{Instant, Duration};

use crate::config::Config;
use crate::mp4::Mp4Segmenter;
use crate::rtsp::mask_url;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamMeta {
    pub codec: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub profile: Option<String>,
    pub level: Option<u32>,
    pub transcode: bool,
    pub forced: bool,
}

pub async fn probe_stream(rtsp_url: &str, timeout_ms: u64, ffprobe_path: &str) -> Result<StreamMeta, anyhow::Error> {
    let args = [
        "-v", "error",
        "-rtsp_transport", "tcp",
        "-analyzeduration", "2000000",
        "-probesize", "1000000",
        "-select_streams", "v:0",
        "-show_entries", "stream=codec_name,width,height,avg_frame_rate,profile,level",
        "-of", "json",
        "-i", rtsp_url,
    ];

    let cmd = create_command(ffprobe_path)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let output = match tokio::time::timeout(Duration::from_millis(timeout_ms), cmd.wait_with_output()).await {
        Ok(Ok(o)) => o,
        _ => return Err(anyhow::anyhow!("PROBE_FAILED")),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.to_lowercase().contains("401") || stderr.to_lowercase().contains("unauthorized") {
            return Err(anyhow::anyhow!("UNAUTHORIZED"));
        }
        return Err(anyhow::anyhow!("PROBE_FAILED"));
    }

    let parsed: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    let streams = parsed.get("streams").and_then(|s| s.as_array());
    
    if let Some(stream) = streams.and_then(|s| s.first()) {
        let fps = if let Some(fr) = stream.get("avg_frame_rate").and_then(|v| v.as_str()) {
            let parts: Vec<&str> = fr.split('/').collect();
            if parts.len() == 2 {
                let num: f64 = parts[0].parse().unwrap_or(0.0);
                let den: f64 = parts[1].parse().unwrap_or(1.0);
                if den > 0.0 {
                    Some(num / den)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        Ok(StreamMeta {
            codec: stream.get("codec_name").and_then(|v| v.as_str()).map(|s| s.to_string()),
            width: stream.get("width").and_then(|v| v.as_u64()).map(|v| v as u32),
            height: stream.get("height").and_then(|v| v.as_u64()).map(|v| v as u32),
            fps,
            profile: stream.get("profile").and_then(|v| v.as_str()).map(|s| s.to_string()),
            level: stream.get("level").and_then(|v| v.as_u64()).map(|v| v as u32),
            transcode: false,
            forced: false,
        })
    } else {
        Err(anyhow::anyhow!("No video stream found"))
    }
}

#[derive(Clone, Debug)]
pub enum StreamEvent {
    Init(Bytes),
    Segment(Bytes),
    Error(String),
}

pub struct StreamSession {
    pub key: String,
    pub rtsp_url: String,
    pub meta: StreamMeta,
    pub tx: broadcast::Sender<StreamEvent>,
    pub init_segment: Arc<Mutex<Option<Bytes>>>,
    stats: Arc<Mutex<StreamStats>>,
    stopped: Arc<Mutex<bool>>,
    stop_tx: Option<oneshot::Sender<()>>,
}

#[derive(Default)]
struct StreamStats {
    bytes: usize,
    segments: usize,
    started_at: Option<Instant>,
}

#[derive(Serialize)]
pub struct StreamInfo {
    pub key: String,
    pub url: String,
    pub viewers: usize,
    pub codec: Option<String>,
    pub transcode: bool,
    pub resolution: Option<String>,
    pub fps: Option<f64>,
    pub segments: usize,
    pub kbps: u64,
    #[serde(rename = "uptimeSec")]
    pub uptime_sec: u64,
}

impl StreamSession {
    pub fn new(key: String, rtsp_url: String, meta: StreamMeta, _config: Arc<Config>) -> Self {
        let (tx, _) = broadcast::channel(100);
        let init_segment = Arc::new(Mutex::new(None));
        let stats = Arc::new(Mutex::new(StreamStats {
            started_at: Some(Instant::now()),
            ..Default::default()
        }));
        let stopped = Arc::new(Mutex::new(false));
        
        Self {
            key,
            rtsp_url,
            meta,
            tx,
            init_segment,
            stats,
            stopped,
            stop_tx: None,
        }
    }

    pub fn start(&mut self, config: Arc<Config>) {
        let (stop_tx, mut stop_rx) = oneshot::channel();
        self.stop_tx = Some(stop_tx);

        let input_args = vec![
            "-hide_banner",
            "-loglevel", "warning",
            "-rtsp_transport", "tcp",
            "-fflags", "nobuffer",
            "-flags", "low_delay",
            "-analyzeduration", "1000000",
            "-probesize", "500000",
            "-i", &self.rtsp_url,
        ];

        let mut video_args = if self.meta.transcode {
            vec![
                "-c:v", "libx264",
                "-preset", &config.stream.transcode_preset,
                "-tune", "zerolatency",
                "-profile:v", "main",
                "-pix_fmt", "yuv420p",
                "-b:v", &config.stream.transcode_bitrate,
                "-maxrate", &config.stream.transcode_bitrate,
                "-bufsize", "1M",
                "-g", "30",
            ]
        } else {
            vec!["-c:v", "copy"]
        };

        let mut args = input_args;
        args.push("-an"); // disable audio
        args.append(&mut video_args);
        
        let frag_dur = config.stream.frag_duration.to_string();
        let mut out_args = vec![
            "-f", "mp4",
            "-movflags", "+frag_keyframe+empty_moov+default_base_moof+omit_tfhd_offset",
            "-frag_duration", &frag_dur,
            "pipe:1"
        ];
        args.append(&mut out_args);

        let mut cmd = create_command(&config.stream.ffmpeg)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("Failed to start ffmpeg");

        let mut stdout = cmd.stdout.take().unwrap();
        let mut stderr = cmd.stderr.take().unwrap();

        let tx_clone = self.tx.clone();
        let init_segment_clone = self.init_segment.clone();
        let stats_clone = self.stats.clone();

        tokio::spawn(async move {
            let mut segmenter = Mp4Segmenter::new();
            let mut buf = [0u8; 8192];
            
            loop {
                tokio::select! {
                    _ = &mut stop_rx => {
                        break;
                    }
                    res = stdout.read(&mut buf) => {
                        match res {
                            Ok(0) | Err(_) => break,
                            Ok(n) => {
                                segmenter.write(&buf[..n], |init| {
                                    if let Ok(mut g) = init_segment_clone.try_lock() {
                                        *g = Some(init.clone());
                                    }
                                    let _ = tx_clone.send(StreamEvent::Init(init));
                                }, |seg| {
                                    if let Ok(mut g) = stats_clone.try_lock() {
                                        g.bytes += seg.len();
                                        g.segments += 1;
                                    }
                                    let _ = tx_clone.send(StreamEvent::Segment(seg));
                                });
                            }
                        }
                    }
                }
            }
            
            let _ = cmd.kill().await;
            let _ = tx_clone.send(StreamEvent::Error("ffmpeg exited".to_string()));
        });
        
        let key = self.key.clone();
        tokio::spawn(async move {
            let mut buf = [0u8; 1024];
            while let Ok(n) = stderr.read(&mut buf).await {
                if n == 0 { break; }
                let text = String::from_utf8_lossy(&buf[..n]);
                if text.to_lowercase().contains("401") || text.to_lowercase().contains("unauthorized") {
                    println!("[stream] {}: {}", key, text.trim());
                }
            }
        });
    }

    pub fn stop(&mut self) {
        let mut stopped = self.stopped.try_lock().unwrap();
        *stopped = true;
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
    }

    pub fn info(&self) -> StreamInfo {
        let stats = self.stats.try_lock().unwrap();
        let uptime_sec = if let Some(start) = stats.started_at {
            start.elapsed().as_secs()
        } else {
            0
        };
        
        let kbps = if uptime_sec > 0 {
            (stats.bytes as u64 * 8) / uptime_sec / 1000
        } else {
            0
        };

        StreamInfo {
            key: self.key.clone(),
            url: mask_url(&self.rtsp_url),
            viewers: self.tx.receiver_count(),
            codec: self.meta.codec.clone(),
            transcode: self.meta.transcode,
            resolution: if let (Some(w), Some(h)) = (self.meta.width, self.meta.height) {
                Some(format!("{}x{}", w, h))
            } else {
                None
            },
            fps: self.meta.fps,
            segments: stats.segments,
            kbps,
            uptime_sec,
        }
    }
}

pub struct StreamManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<StreamSession>>>>>,
    config: Arc<Config>,
}

impl StreamManager {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            config,
        }
    }

    pub async fn list(&self) -> Vec<StreamInfo> {
        let mut infos = Vec::new();
        let sessions = self.sessions.lock().await;
        for session in sessions.values() {
            let s = session.lock().await;
            infos.push(s.info());
        }
        infos
    }

    pub async fn acquire(&self, key: &str, rtsp_url: &str, force_transcode: bool) -> Result<Arc<Mutex<StreamSession>>, anyhow::Error> {
        let mut sessions = self.sessions.lock().await;
        
        if let Some(session) = sessions.get(key) {
            let s = session.lock().await;
            let stopped = *s.stopped.lock().await;
            if !stopped {
                return Ok(session.clone());
            }
        }

        if sessions.len() >= self.config.stream.max_sessions {
            return Err(anyhow::anyhow!("TOO_MANY_SESSIONS"));
        }

        let mut probe = probe_stream(rtsp_url, self.config.stream.probe_timeout, &self.config.stream.ffprobe).await?;
        
        let is_mse_safe = probe.codec.as_deref().unwrap_or("").eq_ignore_ascii_case("h264");
        probe.transcode = force_transcode || !is_mse_safe;
        probe.forced = force_transcode;

        let mut session = StreamSession::new(key.to_string(), rtsp_url.to_string(), probe, self.config.clone());
        session.start(self.config.clone());
        
        let arc_session = Arc::new(Mutex::new(session));
        sessions.insert(key.to_string(), arc_session.clone());
        
        Ok(arc_session)
    }

    pub async fn stop_all(&self) {
        let sessions = self.sessions.lock().await;
        for session in sessions.values() {
            let mut s = session.lock().await;
            s.stop();
        }
    }
}

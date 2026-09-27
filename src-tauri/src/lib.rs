pub mod config;
pub mod network;
pub mod oui;
pub mod credentials;
pub mod digest;
pub mod hikvision;
pub mod portscan;
pub mod discovery;
pub mod rtsp;
pub mod mp4;
pub mod stream;
pub mod scanner;
pub mod api;
pub mod websocket;
pub mod server;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      #[cfg(debug_assertions)] // use cfg attr instead of if cfg! so we don't need unused imports in release
      {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      
      tauri::async_runtime::spawn(async {
        if let Err(e) = server::run_server().await {
            eprintln!("Server error: {}", e);
        }
      });
      
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

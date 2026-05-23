use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::State;
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio_tungstenite::connect_async;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamConfig {
    pub cam_id: String,
    pub rtsp_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamStatus {
    pub cam_id: String,
    pub active: bool,
    pub error: Option<String>,
}

struct StreamHandle {
    child: Child,
    abort_handle: tokio::task::JoinHandle<()>,
}

pub struct AppState {
    streams: Arc<Mutex<HashMap<String, StreamHandle>>>,
}

impl AppState {
    fn new() -> Self {
        Self {
            streams: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[tauri::command]
async fn start_stream(
    state: State<'_, AppState>,
    server_url: String,
    config: StreamConfig,
) -> Result<String, String> {
    let mut streams = state.streams.lock().await;

    // Stop existing stream for this camera if any
    if let Some(mut handle) = streams.remove(&config.cam_id) {
        handle.abort_handle.abort();
        let _ = handle.child.kill().await;
    }

    let ws_url = format!("ws://{}/ingest/{}", server_url, config.cam_id);
    let rtsp_url = config.rtsp_url.clone();
    let cam_id = config.cam_id.clone();

    // Spawn ffmpeg process
    let mut child = Command::new("ffmpeg")
        .args([
            "-rtsp_transport", "tcp",
            "-i", &rtsp_url,
            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-tune", "zerolatency",
            "-vf", "scale=640:360",
            "-g", "30",
            "-f", "mp4",
            "-movflags", "frag_keyframe+empty_moov+default_base_moof",
            "-frag_duration", "500000",
            "-an",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;

    let stdout = child.stdout.take()
        .ok_or_else(|| "Failed to capture ffmpeg stdout".to_string())?;

    // Spawn a task that reads ffmpeg output and sends to WebSocket
    let abort_handle = tokio::spawn(async move {
        if let Err(e) = stream_to_ws(ws_url, stdout).await {
            eprintln!("[{}] Stream error: {}", cam_id, e);
        }
    });

    streams.insert(config.cam_id.clone(), StreamHandle { child, abort_handle });

    Ok(format!("Stream started for {}", config.cam_id))
}

async fn stream_to_ws(
    ws_url: String,
    mut stdout: tokio::process::ChildStdout,
) -> Result<(), String> {
    let (ws_stream, _) = connect_async(&ws_url).await.map_err(|e| format!("WebSocket connect failed: {}", e))?;
    let (mut write, _read) = ws_stream.split();

    let mut buf = vec![0u8; 65536];
    loop {
        let n = stdout.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        write.send(Message::Binary(buf[..n].to_vec().into()))
            .await
            .map_err(|e| format!("WebSocket send failed: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
async fn stop_stream(
    state: State<'_, AppState>,
    cam_id: String,
) -> Result<String, String> {
    let mut streams = state.streams.lock().await;
    if let Some(mut handle) = streams.remove(&cam_id) {
        handle.abort_handle.abort();
        let _ = handle.child.kill().await;
        Ok(format!("Stream stopped for {}", cam_id))
    } else {
        Ok(format!("No active stream for {}", cam_id))
    }
}

#[tauri::command]
async fn get_status(state: State<'_, AppState>) -> Result<Vec<StreamStatus>, String> {
    let streams = state.streams.lock().await;
    let cam_ids = ["cam1", "cam2", "cam3", "cam4"];
    let statuses: Vec<StreamStatus> = cam_ids
        .iter()
        .map(|id| StreamStatus {
            cam_id: id.to_string(),
            active: streams.contains_key(*id),
            error: None,
        })
        .collect();
    Ok(statuses)
}

#[tauri::command]
async fn stop_all(state: State<'_, AppState>) -> Result<String, String> {
    let mut streams = state.streams.lock().await;
    for (_, mut handle) in streams.drain() {
        handle.abort_handle.abort();
        let _ = handle.child.kill().await;
    }
    Ok("All streams stopped".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            start_stream,
            stop_stream,
            get_status,
            stop_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

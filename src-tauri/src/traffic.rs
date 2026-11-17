//! 托盘共用一个轻量 /traffic 流，避免读取每条连接的域名、规则和元数据。
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use serde::Deserialize;
use tauri::Manager;

static RATES: OnceLock<Mutex<Option<(f64, f64, Instant)>>> = OnceLock::new();
fn cache() -> &'static Mutex<Option<(f64, f64, Instant)>> { RATES.get_or_init(|| Mutex::new(None)) }
pub fn rates() -> (f64, f64) {
    cache().lock().ok().and_then(|v| *v)
        .filter(|(_, _, at)| at.elapsed() < Duration::from_secs(4))
        .map(|(up, down, _)| (up, down)).unwrap_or((0.0, 0.0))
}

#[derive(Deserialize)]
struct Frame { up: f64, down: f64 }
#[derive(Default)]
struct Decoder { buffer: Vec<u8> }
impl Decoder {
    fn feed(&mut self, chunk: &[u8]) -> Result<Option<(f64, f64)>, ()> {
        let mut latest = None;
        for byte in chunk {
            if *byte == b'\n' {
                if !self.buffer.is_empty() {
                    let f: Frame = serde_json::from_slice(&self.buffer).map_err(|_| ())?;
                    if !f.up.is_finite() || !f.down.is_finite() || f.up < 0.0 || f.down < 0.0 { return Err(()); }
                    latest = Some((f.up, f.down));
                    self.buffer.clear();
                }
            } else {
                if self.buffer.len() >= 4096 { return Err(()); }
                self.buffer.push(*byte);
            }
        }
        Ok(latest)
    }
}

async fn stream(app: &tauri::AppHandle) -> Result<(), ()> {
    let state = app.state::<crate::kernel::KernelState>();
    let port = *state.controller_port.lock().await;
    let secret = state.controller_secret.lock().await.clone();
    let client = crate::mihomo::client().map_err(|_| ())?;
    let request = client.get(format!("http://127.0.0.1:{port}/traffic"))
        .bearer_auth(&secret).send();
    let mut response = tokio::time::timeout(Duration::from_secs(3), request).await.map_err(|_| ())?
        .map_err(|_| ())?.error_for_status().map_err(|_| ())?;
    let mut decoder = Decoder::default();
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(3), response.chunk()).await
            .map_err(|_| ())?.map_err(|_| ())?.ok_or(())?;
        // 内核端口或密钥变化后立刻丢弃旧流，再连接新控制器。
        if *state.controller_port.lock().await != port || *state.controller_secret.lock().await != secret { return Err(()); }
        if let Some((up, down)) = decoder.feed(&chunk)? {
            if let Ok(mut value) = cache().lock() { *value = Some((up, down, Instant::now())); }
        }
    }
}

pub async fn run(app: tauri::AppHandle) {
    loop {
        let _ = stream(&app).await;
        if let Ok(mut value) = cache().lock() { *value = None; }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_split_frames_and_keeps_latest() {
        let mut d = Decoder::default();
        assert_eq!(d.feed(b"{\"up\":12,"), Ok(None));
        assert_eq!(d.feed(b"\"down\":34}\n{\"up\":56,\"down\":78}\n"), Ok(Some((56.0, 78.0))));
    }
    #[test]
    fn rejects_invalid_or_unbounded_frames() {
        assert!(Decoder::default().feed(b"{\"up\":-1,\"down\":10}\n").is_err());
        assert!(Decoder::default().feed(&vec![b'x'; 4097]).is_err());
    }
}

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::{self, Duration, Instant};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message as WsMessage};
use tracing::{debug, error, info, warn};

use crate::config::AgentConfig;
use crate::protocol::{self, AuthRequest, AuthResponse, Message};

/// Events received from the server
#[derive(Debug)]
pub enum ServerEvent {
    /// Successfully authenticated
    Authenticated {
        device_id: String,
        session_token: String,
    },
    /// Received a protocol message from server
    Message(Message),
    /// Connection lost
    Disconnected,
}

/// Handle to send messages to the server
#[derive(Clone)]
pub struct ConnectionHandle {
    tx: mpsc::Sender<Vec<u8>>,
}

impl ConnectionHandle {
    pub async fn send_message(&self, msg: &Message) -> Result<()> {
        self.tx
            .send(msg.encode())
            .await
            .map_err(|_| anyhow::anyhow!("connection channel closed"))
    }

    pub async fn send_raw(&self, data: Vec<u8>) -> Result<()> {
        self.tx
            .send(data)
            .await
            .map_err(|_| anyhow::anyhow!("connection channel closed"))
    }
}

/// Enroll with the server via HTTP to get a session token
pub async fn enroll(config: &AgentConfig) -> Result<(String, String)> {
    let url = config.enroll_url();
    let token = config
        .enroll_token
        .as_ref()
        .context("no enrollment token")?;

    let hostname = gethostname();
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();

    let body = serde_json::json!({
        "enrollmentToken": token,
        "deviceName": &hostname,
        "deviceModel": format!("{} {}", os, arch),
        "androidVersion": "",
        "osType": &os,
        "hostname": &hostname,
        "arch": &arch,
        "agentVersion": env!("CARGO_PKG_VERSION"),
    });

    info!("enrolling with server at {}", url);
    let client = reqwest::Client::new();
    let resp = client.post(&url).json(&body).send().await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("enrollment failed: {} - {}", status, body);
    }

    let result: serde_json::Value = resp.json().await?;
    let device_id = result["deviceId"]
        .as_str()
        .context("missing deviceId in enrollment response")?
        .to_string();
    let session_token = result["sessionToken"]
        .as_str()
        .context("missing sessionToken in enrollment response")?
        .to_string();

    info!("enrolled successfully, device_id={}", device_id);
    Ok((device_id, session_token))
}

/// Run the WebSocket connection loop with automatic reconnection.
/// Returns a handle to send messages and a receiver for server events.
pub async fn run_connection(
    config: AgentConfig,
    event_tx: mpsc::Sender<ServerEvent>,
) -> Result<ConnectionHandle> {
    let (outgoing_tx, outgoing_rx) = mpsc::channel::<Vec<u8>>(256);
    let handle = ConnectionHandle {
        tx: outgoing_tx.clone(),
    };

    tokio::spawn(async move {
        connection_loop(config, event_tx, outgoing_rx, outgoing_tx).await;
    });

    Ok(handle)
}

async fn connection_loop(
    config: AgentConfig,
    event_tx: mpsc::Sender<ServerEvent>,
    mut outgoing_rx: mpsc::Receiver<Vec<u8>>,
    outgoing_tx: mpsc::Sender<Vec<u8>>,
) {
    let mut attempt = 0u32;

    loop {
        let delay = reconnect_delay(&config, attempt);
        if attempt > 0 {
            info!("reconnecting in {:.1}s (attempt {})", delay.as_secs_f64(), attempt);
            time::sleep(delay).await;
        }

        match connect_and_run(&config, &event_tx, &mut outgoing_rx, &outgoing_tx).await {
            Ok(()) => {
                info!("connection closed gracefully");
                attempt = 0;
            }
            Err(e) => {
                error!("connection error: {:#}", e);
                attempt = attempt.saturating_add(1);
            }
        }

        if event_tx.send(ServerEvent::Disconnected).await.is_err() {
            info!("event channel closed, stopping connection loop");
            break;
        }
    }
}

async fn connect_and_run(
    config: &AgentConfig,
    event_tx: &mpsc::Sender<ServerEvent>,
    outgoing_rx: &mut mpsc::Receiver<Vec<u8>>,
    _outgoing_tx: &mpsc::Sender<Vec<u8>>,
) -> Result<()> {
    let url = config.relay_url();
    info!("connecting to {}", url);

    let (ws_stream, _) = connect_async(&url)
        .await
        .context("failed to connect WebSocket")?;

    info!("WebSocket connected");

    let (mut ws_sink, mut ws_stream) = ws_stream.split();

    // Send authentication
    let session_token = config
        .session_token
        .as_ref()
        .context("no session token — need to enroll first")?;

    let auth_req = AuthRequest {
        token: session_token.clone(),
        device_type: std::env::consts::OS.to_string(),
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        hostname: gethostname(),
    };

    let auth_msg = protocol::auth_request(&auth_req)?;
    ws_sink
        .send(WsMessage::Binary(auth_msg.encode().into()))
        .await?;
    debug!("sent AUTH_REQUEST");

    // Wait for auth response
    let auth_timeout = Duration::from_secs(10);
    let auth_response = tokio::time::timeout(auth_timeout, async {
        while let Some(msg) = ws_stream.next().await {
            match msg? {
                WsMessage::Binary(data) => {
                    if let Some((msg, _)) = Message::decode(&data)? {
                        if msg.header.msg_type == protocol::AUTH_RESPONSE {
                            let resp: AuthResponse = msg.parse_json()?;
                            return Ok::<AuthResponse, anyhow::Error>(resp);
                        }
                    }
                }
                WsMessage::Close(_) => bail!("server closed connection during auth"),
                _ => {}
            }
        }
        bail!("connection closed before auth response")
    })
    .await
    .context("auth timeout")?
    .context("auth failed")?;

    if !auth_response.success {
        bail!(
            "authentication rejected: {}",
            auth_response.error.unwrap_or_default()
        );
    }

    let device_id = auth_response.device_id.unwrap_or_default();
    let new_session_token = auth_response.session_token.unwrap_or_default();

    info!("authenticated, device_id={}", device_id);

    event_tx
        .send(ServerEvent::Authenticated {
            device_id,
            session_token: new_session_token,
        })
        .await
        .ok();

    // Main message loop
    let heartbeat_interval = Duration::from_secs(config.heartbeat_interval_secs);
    let mut heartbeat_timer = time::interval(heartbeat_interval);
    heartbeat_timer.tick().await; // skip first immediate tick

    let mut last_pong = Instant::now();
    let heartbeat_timeout = heartbeat_interval * 3;

    let mut read_buf = Vec::new();

    loop {
        tokio::select! {
            // Incoming WebSocket messages
            ws_msg = ws_stream.next() => {
                match ws_msg {
                    Some(Ok(WsMessage::Binary(data))) => {
                        read_buf.extend_from_slice(&data);

                        // Decode all complete messages from buffer
                        loop {
                            match Message::decode(&read_buf) {
                                Ok(Some((msg, consumed))) => {
                                    read_buf.drain(..consumed);

                                    match msg.header.msg_type {
                                        protocol::HEARTBEAT_ACK => {
                                            last_pong = Instant::now();
                                            debug!("heartbeat ACK received");
                                        }
                                        protocol::HEARTBEAT => {
                                            // Server sent heartbeat, respond with ACK
                                            let ack = protocol::heartbeat_ack();
                                            ws_sink.send(WsMessage::Binary(ack.encode().into())).await?;
                                        }
                                        _ => {
                                            if event_tx.send(ServerEvent::Message(msg)).await.is_err() {
                                                info!("event channel closed");
                                                return Ok(());
                                            }
                                        }
                                    }
                                }
                                Ok(None) => break, // need more data
                                Err(e) => {
                                    error!("protocol decode error: {}", e);
                                    read_buf.clear();
                                    break;
                                }
                            }
                        }
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        ws_sink.send(WsMessage::Pong(data)).await?;
                    }
                    Some(Ok(WsMessage::Close(_))) => {
                        info!("server sent close frame");
                        return Ok(());
                    }
                    Some(Ok(_)) => {} // text, pong
                    Some(Err(e)) => return Err(e.into()),
                    None => {
                        info!("WebSocket stream ended");
                        return Ok(());
                    }
                }
            }

            // Outgoing messages from agent logic
            outgoing = outgoing_rx.recv() => {
                match outgoing {
                    Some(data) => {
                        ws_sink.send(WsMessage::Binary(data.into())).await?;
                    }
                    None => {
                        info!("outgoing channel closed");
                        return Ok(());
                    }
                }
            }

            // Heartbeat timer
            _ = heartbeat_timer.tick() => {
                if last_pong.elapsed() > heartbeat_timeout {
                    warn!("heartbeat timeout, disconnecting");
                    return Ok(());
                }
                let hb = protocol::heartbeat();
                ws_sink.send(WsMessage::Binary(hb.encode().into())).await?;
                debug!("sent heartbeat");
            }
        }
    }
}

fn reconnect_delay(config: &AgentConfig, attempt: u32) -> Duration {
    if attempt == 0 {
        return Duration::ZERO;
    }
    let base = config.reconnect_base_delay_secs as f64;
    let max = config.reconnect_max_delay_secs as f64;
    // Exponential backoff: base * 2^(attempt-1), capped at max
    let delay = (base * 2.0f64.powi(attempt as i32 - 1)).min(max);
    // Add jitter: ±25%
    let jitter = delay * 0.25 * (2.0 * rand_simple() - 1.0);
    Duration::from_secs_f64((delay + jitter).max(base))
}

fn rand_simple() -> f64 {
    // Simple pseudo-random using time - good enough for jitter
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    (nanos % 1000) as f64 / 1000.0
}

fn gethostname() -> String {
    hostname::get()
        .map(|h| h.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

// memt-sender — minimal hot-path Solana tx sender.
//
// Reads a base64-encoded VersionedTransaction (built by the TS core via
// Jupiter v6) from stdin, signs it with the keypair in WALLET_SECRET_KEY,
// and races it to Jito's Block Engine plus any RPCs listed in EXTRA_RPCS.
// First successful response wins; the rest are cancelled.
//
// Env:
//   WALLET_SECRET_KEY  base58 secret key (same format as TS uses)
//   JITO_BUNDLE_URL    optional, defaults to mainnet block engine
//   JITO_TIP_LAMPORTS  optional tip; default 0 (Jito will reject if too low)
//   EXTRA_RPCS         comma-separated list of HTTP RPC URLs to also try
//   RPC_HTTP_URL       fallback RPC (used if EXTRA_RPCS is unset)

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use futures::future::select_ok;
use solana_sdk::{
    signature::{Keypair, Signer},
    transaction::VersionedTransaction,
};
use std::env;
use std::time::Duration;
use tokio::io::{self, AsyncReadExt};

fn load_keypair() -> Result<Keypair> {
    let secret = env::var("WALLET_SECRET_KEY").context("WALLET_SECRET_KEY missing")?;
    let trimmed = secret.trim();
    if trimmed.starts_with('[') {
        let bytes: Vec<u8> = serde_json::from_str(trimmed)?;
        Keypair::from_bytes(&bytes).map_err(|e| anyhow!("keypair from json: {e}"))
    } else {
        let bytes = bs58::decode(trimmed).into_vec()?;
        Keypair::from_bytes(&bytes).map_err(|e| anyhow!("keypair from bs58: {e}"))
    }
}

async fn read_tx_from_stdin() -> Result<VersionedTransaction> {
    let mut buf = String::new();
    io::stdin().read_to_string(&mut buf).await?;
    let raw = B64.decode(buf.trim())?;
    let tx: VersionedTransaction = bincode::deserialize(&raw)
        .map_err(|e| anyhow!("deserialize tx: {e}"))?;
    Ok(tx)
}

fn sign(mut tx: VersionedTransaction, kp: &Keypair) -> Result<VersionedTransaction> {
    let msg_bytes = tx.message.serialize();
    let sig = kp.sign_message(&msg_bytes);

    let pubkey = kp.pubkey();
    let signers = tx.message.static_account_keys();
    let pos = signers
        .iter()
        .position(|k| k == &pubkey)
        .ok_or_else(|| anyhow!("wallet pubkey not found in tx accounts"))?;
    if pos >= tx.signatures.len() {
        bail!("signature slot {pos} out of bounds (len {})", tx.signatures.len());
    }
    tx.signatures[pos] = sig;
    Ok(tx)
}

async fn send_to_rpc(client: reqwest::Client, url: String, b64: String) -> Result<String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sendTransaction",
        "params": [b64, {
            "encoding": "base64",
            "skipPreflight": true,
            "maxRetries": 0,
        }],
    });
    let resp: serde_json::Value = client
        .post(&url)
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    if let Some(sig) = resp.get("result").and_then(|v| v.as_str()) {
        Ok(sig.to_string())
    } else {
        Err(anyhow!("RPC {url}: {resp}"))
    }
}

async fn send_to_jito(client: reqwest::Client, url: String, b64: String) -> Result<String> {
    let body = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "sendTransaction",
        "params": [b64, { "encoding": "base64" }],
    });
    let resp: serde_json::Value = client
        .post(&url)
        .json(&body)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    resp.get("result")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("Jito {url}: {resp}"))
}

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    let kp = load_keypair()?;
    let tx = read_tx_from_stdin().await?;
    let signed = sign(tx, &kp)?;
    let raw = bincode::serialize(&signed).context("serialize signed tx")?;
    let b64 = B64.encode(&raw);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;

    let mut futs: Vec<std::pin::Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>>> =
        Vec::new();

    let extra = env::var("EXTRA_RPCS").unwrap_or_default();
    let rpc_urls: Vec<String> = if extra.is_empty() {
        env::var("RPC_HTTP_URL").into_iter().collect()
    } else {
        extra.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect()
    };
    for url in rpc_urls {
        futs.push(Box::pin(send_to_rpc(client.clone(), url, b64.clone())));
    }

    let jito = env::var("JITO_BUNDLE_URL")
        .unwrap_or_else(|_| "https://mainnet.block-engine.jito.wtf/api/v1/transactions".into());
    futs.push(Box::pin(send_to_jito(client.clone(), jito, b64.clone())));

    if futs.is_empty() {
        bail!("no send targets configured (set EXTRA_RPCS or RPC_HTTP_URL)");
    }

    let (sig, _rest) = select_ok(futs).await.context("all send targets failed")?;
    println!("{sig}");
    Ok(())
}

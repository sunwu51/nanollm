use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read};
use std::time::Duration;

#[derive(Deserialize)]
struct Request {
    url: String,
    headers: HashMap<String, String>,
    body: String,
    timeout_secs: Option<u64>,
}

#[derive(Serialize)]
struct Response {
    status: u16,
    body: String,
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: Request = serde_json::from_str(&input)?;
    let mut headers = HeaderMap::new();
    for (key, value) in request.headers {
        headers.insert(HeaderName::from_bytes(key.as_bytes())?, HeaderValue::from_str(&value)?);
    }
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .pool_max_idle_per_host(2)
        .tcp_keepalive(Duration::from_secs(30))
        .build()?;
    let response = client
        .post(request.url)
        .headers(headers)
        .timeout(Duration::from_secs(request.timeout_secs.unwrap_or(30)))
        .body(request.body)
        .send()
        .await?;
    let output = Response { status: response.status().as_u16(), body: response.text().await? };
    println!("{}", serde_json::to_string(&output)?);
    Ok(())
}

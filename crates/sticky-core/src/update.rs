//! Read-only update checks and verification of published release artifacts.
use crate::{message, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::io::Read;

#[derive(Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub version: String,
    pub signature: String,
}
pub fn verify(bytes: &[u8], artifact: &Artifact, public_key: &str) -> Result<()> {
    let decode = |s: &str| -> Result<String> {
        String::from_utf8(
            STANDARD
                .decode(s.trim())
                .map_err(|e| message(e.to_string()))?,
        )
        .map_err(|e| message(e.to_string()))
    };
    let key = PublicKey::decode(&decode(public_key)?).map_err(|e| message(e.to_string()))?;
    let signature =
        Signature::decode(&decode(&artifact.signature)?).map_err(|e| message(e.to_string()))?;
    key.verify(bytes, &signature, true)
        .map_err(|e| message(e.to_string()))?;
    let signed = signature
        .trusted_comment()
        .split('\t')
        .find_map(|s| s.strip_prefix("version:"))
        .ok_or_else(|| message("Update signature does not bind a version"))?;
    if Version::parse(signed).map_err(|e| message(e.to_string()))?
        != Version::parse(&artifact.version).map_err(|e| message(e.to_string()))?
    {
        return Err(message(
            "Signed artifact version differs from the release manifest",
        ));
    }
    Ok(())
}
pub fn newer(remote: &str, current: &str) -> Result<bool> {
    Ok(Version::parse(remote).map_err(|e| message(e.to_string()))?
        > Version::parse(current).map_err(|e| message(e.to_string()))?)
}
pub const RELEASES_URL: &str = "https://github.com/petterssonjonas/sticky-markers/releases";
const FEED_URL: &str =
    "https://github.com/petterssonjonas/sticky-markers/releases/latest/download/latest.json";
const FEED_LIMIT: u64 = 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub notes: Option<String>,
    pub release_url: String,
}
#[derive(Deserialize)]
struct Feed {
    version: String,
    notes: Option<String>,
}
/// Feed metadata only: never downloads, stages, or executes an application.
pub fn parse_feed(bytes: &[u8], current: &str) -> Result<Option<Release>> {
    let feed: Feed = serde_json::from_slice(bytes)?;
    let version = Version::parse(&feed.version).map_err(|e| message(e.to_string()))?;
    if version.to_string() != feed.version {
        return Err(message("Noncanonical release version"));
    }
    if !newer(&feed.version, current)? {
        return Ok(None);
    }
    Ok(Some(Release {
        release_url: format!("{RELEASES_URL}/tag/v{}", feed.version),
        version: feed.version,
        notes: feed.notes,
    }))
}
fn read_feed(url: &str, current: &str) -> Result<Option<Option<Release>>> {
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(concat!("sticky-markers/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| message(e.to_string()))?
        .get(url)
        .send()
        .map_err(|e| message(e.to_string()))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    let response = response
        .error_for_status()
        .map_err(|e| message(e.to_string()))?;
    let mut bytes = Vec::new();
    response.take(FEED_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > FEED_LIMIT {
        return Err(message("Release metadata exceeds the size limit"));
    }
    Ok(Some(parse_feed(&bytes, current)?))
}
/// None means no published feed yet; Some(None) means already up to date.
pub fn check(current: &str) -> Result<Option<Option<Release>>> {
    read_feed(FEED_URL, current)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (&'static [u8], Artifact, String) {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../../../src-tauri/tauri.conf.json")).unwrap();
        (
            include_bytes!("../../../tests/fixtures/updater/artifact.txt"),
            Artifact {
                version: "0.1.0".into(),
                signature: include_str!("../../../tests/fixtures/updater/artifact.txt.sig")
                    .trim()
                    .into(),
            },
            config["plugins"]["updater"]["pubkey"]
                .as_str()
                .unwrap()
                .into(),
        )
    }
    #[test]
    fn signed_content_and_version_are_both_required() {
        let (bytes, mut artifact, key) = fixture();
        verify(bytes, &artifact, &key).unwrap();
        assert!(verify(b"tampered", &artifact, &key).is_err());
        artifact.version = "9.0.0".into();
        assert!(verify(bytes, &artifact, &key).is_err());
    }
    #[test]
    fn checks_offer_release_packages_and_ignore_installation_targets() {
        let bytes = br#"{"version":"0.2.0","notes":"New release","platforms":{"linux-x86_64":{"url":"https://untrusted.example/payload"}}}"#;
        let release = parse_feed(bytes, "0.1.0").unwrap().unwrap();
        assert_eq!(release.release_url, format!("{RELEASES_URL}/tag/v0.2.0"));
        assert_eq!(release.notes.as_deref(), Some("New release"));
        assert!(parse_feed(bytes, "0.2.0").unwrap().is_none());
        assert!(parse_feed(bytes, "1.0.0").unwrap().is_none());
        assert!(parse_feed(br#"{"version":"../../payload"}"#, "0.1.0").is_err());
    }
    #[test]
    fn checks_handle_unpublished_and_published_feeds() {
        use std::io::{Read, Write};
        for (code, body) in [(404, "missing"), (200, "{\"version\":\"0.2.0\"}")] {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/latest.json", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                stream.read(&mut request).unwrap();
                write!(
                    stream,
                    "HTTP/1.1 {code} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            });
            let result = read_feed(&url, "0.1.0").unwrap();
            assert_eq!(result.is_some(), code == 200);
            if code == 200 {
                assert_eq!(result.unwrap().unwrap().version, "0.2.0");
            }
            server.join().unwrap();
        }
    }
    #[test]
    fn versions_are_compared_numerically_and_downgrades_rejected() {
        assert!(newer("0.10.0", "0.9.0").unwrap());
        assert!(!newer("0.9.0", "0.10.0").unwrap());
        assert!(!newer("1.0.0", "1.0.0").unwrap());
        assert!(newer("../../1.0.0", "1.0.0").is_err());
    }
}

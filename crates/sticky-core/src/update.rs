//! Verification and atomic activation for user-managed Linux updates.
//! Notes and package-manager-owned binaries are never changed here.
use crate::{atomic_write, message, Core, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};

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
fn image_path(core: &Core, version: &str) -> Result<PathBuf> {
    let v = Version::parse(version).map_err(|e| message(e.to_string()))?;
    if v.to_string() != version {
        return Err(message("Noncanonical update version"));
    }
    Ok(core
        .data
        .join("updates/installed")
        .join(version)
        .join("StickyMarkers.AppImage"))
}
pub fn active_image(core: &Core, current: &str, public_key: &str) -> Result<Option<PathBuf>> {
    let metadata = core.data.join("updates/active.json");
    let artifact: Artifact = match fs::read(&metadata) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if !newer(&artifact.version, current)? {
        return Ok(None);
    }
    let path = image_path(core, &artifact.version)?;
    let bytes = fs::read(&path)?;
    verify(&bytes, &artifact, public_key)?;
    validate_image(&bytes)?;
    Ok(Some(path))
}
fn validate_image(bytes: &[u8]) -> Result<()> {
    if !bytes.starts_with(b"\x7fELF") || bytes.get(8..11) != Some(b"AI\x02") {
        return Err(message(
            "The Linux update is not an AppImage type 2 executable",
        ));
    }
    Ok(())
}
pub fn activate_image(
    core: &Core,
    bytes: &[u8],
    artifact: &Artifact,
    public_key: &str,
    current: &str,
) -> Result<PathBuf> {
    verify(bytes, artifact, public_key)?;
    validate_image(bytes)?;
    if !newer(&artifact.version, current)? {
        return Err(message("Refusing an application downgrade"));
    }
    let _lock = core.lock("application-updater")?;
    let path = image_path(core, &artifact.version)?;
    atomic_write(&path, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
    }
    // Activate only after the new executable is fully written and verified.
    // Keep previous version directories for rollback; no destructive cleanup during restart.
    atomic_write(
        &core.data.join("updates/active.json"),
        &serde_json::to_vec(artifact)?,
    )?;
    Ok(path)
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
    fn failed_update_leaves_active_install_and_notes_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let core = Core::new(dir.path().join("data")).unwrap();
        atomic_write(
            &core.data.join("updates/active.json"),
            b"previous activation",
        )
        .unwrap();
        fs::create_dir(dir.path().join("vault")).unwrap();
        let v = core.register(&dir.path().join("vault")).unwrap();
        core.create(&v.id, Some("n.md"), "keep this note", None)
            .unwrap();
        let (bytes, artifact, key) = fixture();
        assert!(activate_image(&core, bytes, &artifact, &key, "0.0.1").is_err()); // signed text is not an executable
        assert_eq!(
            fs::read(core.data.join("updates/active.json")).unwrap(),
            b"previous activation"
        );
        assert_eq!(core.read(&v.id, "n.md").unwrap().content, "keep this note");
    }
    #[test]
    fn versions_are_compared_numerically_and_downgrades_rejected() {
        assert!(newer("0.10.0", "0.9.0").unwrap());
        assert!(!newer("0.9.0", "0.10.0").unwrap());
        assert!(!newer("1.0.0", "1.0.0").unwrap());
        assert!(newer("../../1.0.0", "1.0.0").is_err());
    }
}

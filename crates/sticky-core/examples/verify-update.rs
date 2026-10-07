use sticky_core::update::{verify, Artifact};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 3 {
        return Err("Usage: verify-update ARTIFACT SIGNATURE VERSION".into());
    }
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../../src-tauri/tauri.conf.json"))?;
    verify(
        &std::fs::read(&args[0])?,
        &Artifact {
            version: args[2].clone(),
            signature: std::fs::read_to_string(&args[1])?,
        },
        config["plugins"]["updater"]["pubkey"]
            .as_str()
            .ok_or("No public key")?,
    )?;
    println!("Verified signed update {}", args[0]);
    Ok(())
}

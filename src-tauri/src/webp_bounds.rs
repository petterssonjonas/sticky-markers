//! The WebP codec does not enforce image::Limits during all its allocations.
//! Check container lengths and every actual bitstream/frame size before entering
//! it; its extended canvas dimensions alone are not a safe allocation bound.
use sticky_core::{message, Result};
const PIXELS: u64 = 4 * 1024 * 1024;
const CHUNKS: usize = 4096;
fn u24(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | u32::from(bytes[1]) << 8 | u32::from(bytes[2]) << 16
}
fn dimensions((width, height): (u32, u32)) -> Result<()> {
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > PIXELS
    {
        return Err(message("WebP exceeds the 4 megapixel image limit"));
    }
    Ok(())
}
fn bitstream(kind: &[u8], bytes: &[u8]) -> Result<(u32, u32)> {
    let size = if kind == b"VP8 " {
        if bytes.len() < 10 || bytes[0] & 1 != 0 || bytes[3..6] != [0x9d, 0x01, 0x2a] {
            return Err(message("Invalid WebP VP8 header"));
        }
        (
            u32::from(u16::from_le_bytes([bytes[6], bytes[7]]) & 0x3fff),
            u32::from(u16::from_le_bytes([bytes[8], bytes[9]]) & 0x3fff),
        )
    } else {
        if bytes.len() < 5 || bytes[0] != 0x2f {
            return Err(message("Invalid WebP VP8L header"));
        }
        let bits = u32::from_le_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
        if bits >> 29 != 0 {
            return Err(message("Invalid WebP VP8L version"));
        }
        ((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    };
    dimensions(size)?;
    Ok(size)
}
fn chunks<'a>(
    mut bytes: &'a [u8],
    count: &mut usize,
    mut visit: impl FnMut(&[u8], &'a [u8], &mut usize) -> Result<()>,
) -> Result<()> {
    while !bytes.is_empty() {
        *count += 1;
        if *count > CHUNKS || bytes.len() < 8 {
            return Err(message("Invalid or excessively complex WebP container"));
        }
        let size = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let end = 8usize
            .checked_add(size)
            .ok_or_else(|| message("Invalid WebP chunk length"))?;
        let padded = end
            .checked_add(size & 1)
            .ok_or_else(|| message("Invalid WebP chunk length"))?;
        if padded > bytes.len() {
            return Err(message("WebP chunk exceeds file length"));
        }
        visit(&bytes[..4], &bytes[8..end], count)?;
        bytes = &bytes[padded..];
    }
    Ok(())
}
pub fn validate(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err(message("Invalid WebP container"));
    }
    let declared = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
    if declared.checked_add(8) != Some(bytes.len()) {
        return Err(message("WebP RIFF length does not match file"));
    }
    let mut canvas = None;
    let mut image = None;
    let mut frame_count = 0;
    let mut count = 0;
    chunks(&bytes[12..], &mut count, |kind, data, count| {
        match kind {
            b"VP8X" => {
                if canvas.is_some() || image.is_some() || frame_count > 0 || data.len() != 10 {
                    return Err(message("Invalid WebP canvas header"));
                }
                let size = (u24(&data[4..7]) + 1, u24(&data[7..10]) + 1);
                dimensions(size)?;
                canvas = Some(size);
            }
            b"VP8 " | b"VP8L" => {
                if image.is_some() || frame_count > 0 {
                    return Err(message("Multiple WebP image bitstreams"));
                }
                let size = bitstream(kind, data)?;
                if canvas.is_some_and(|canvas| size != canvas) {
                    return Err(message("WebP bitstream dimensions do not match canvas"));
                }
                image = Some(size);
            }
            b"ANMF" => {
                frame_count += 1;
                if frame_count > 128 || image.is_some() || data.len() < 16 {
                    return Err(message("Invalid or excessively long WebP animation"));
                }
                let canvas = canvas.ok_or_else(|| message("WebP animation needs a canvas"))?;
                let x = u24(&data[..3]) * 2;
                let y = u24(&data[3..6]) * 2;
                let size = (u24(&data[6..9]) + 1, u24(&data[9..12]) + 1);
                dimensions(size)?;
                if x + size.0 > canvas.0 || y + size.1 > canvas.1 {
                    return Err(message("WebP animation frame exceeds canvas"));
                }
                let mut frame_image = false;
                chunks(&data[16..], count, |kind, data, _| {
                    match kind {
                        b"VP8 " | b"VP8L" => {
                            if frame_image || bitstream(kind, data)? != size {
                                return Err(message(
                                    "WebP bitstream dimensions do not match frame",
                                ));
                            }
                            frame_image = true;
                        }
                        b"ALPH" => {}
                        _ => return Err(message("Unsupported WebP frame chunk")),
                    }
                    Ok(())
                })?;
                if !frame_image {
                    return Err(message("WebP frame lacks an image"));
                }
            }
            // Bound all metadata by its real input length before the decoder
            // can allocate EXIF/ICC buffers using attacker-supplied chunk sizes.
            b"EXIF" | b"ICCP" | b"XMP " | b"ALPH" | b"ANIM" => {}
            _ => {}
        }
        Ok(())
    })?;
    if image.is_none() && frame_count == 0 {
        return Err(message("WebP lacks image data"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        let mut bytes = kind.to_vec();
        bytes.extend_from_slice(&(data.len() as u32).to_le_bytes());
        bytes.extend_from_slice(data);
        if data.len() & 1 == 1 {
            bytes.push(0);
        }
        bytes
    }
    fn riff(chunks: Vec<u8>) -> Vec<u8> {
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&((chunks.len() + 4) as u32).to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        bytes.extend(chunks);
        bytes
    }
    #[test]
    fn checks_actual_vp8_dimensions_before_codec_allocation() {
        let mut chunks = chunk(b"VP8X", &[0; 10]); // one-pixel declared canvas
        chunks.extend(chunk(
            b"VP8 ",
            &[0, 0, 0, 0x9d, 0x01, 0x2a, 0xff, 0x3f, 0xff, 0x3f],
        ));
        assert!(validate(&riff(chunks))
            .unwrap_err()
            .to_string()
            .contains("4 megapixel"));
        let mut chunks = chunk(b"VP8X", &[0; 10]);
        chunks.extend(chunk(b"VP8 ", &[0, 0, 0, 0x9d, 0x01, 0x2a, 2, 0, 2, 0]));
        assert!(validate(&riff(chunks))
            .unwrap_err()
            .to_string()
            .contains("do not match canvas"));
    }
    #[test]
    fn rejects_metadata_and_frame_chunks_outside_the_input() {
        let mut forged = b"EXIF".to_vec();
        forged.extend_from_slice(&(1024u32 * 1024 * 1024).to_le_bytes());
        assert!(validate(&riff(forged))
            .unwrap_err()
            .to_string()
            .contains("file length"));
        let mut chunks = chunk(b"VP8X", &[0; 10]);
        let mut frame = vec![0; 16];
        frame.extend(chunk(b"VP8L", &[0x2f, 0xff, 0xff, 0xff, 0x0f]));
        chunks.extend(chunk(b"ANMF", &frame));
        assert!(validate(&riff(chunks)).is_err());
    }
    #[test]
    fn ordinary_static_and_animated_headers_pass() {
        let frame_image = chunk(b"VP8L", &[0x2f, 0, 0, 0, 0]);
        assert!(validate(&riff(frame_image.clone())).is_ok());
        let mut chunks = chunk(b"VP8X", &[0; 10]);
        let mut frame = vec![0; 16];
        frame.extend(frame_image);
        chunks.extend(chunk(b"ANMF", &frame));
        assert!(validate(&riff(chunks)).is_ok());
    }
}

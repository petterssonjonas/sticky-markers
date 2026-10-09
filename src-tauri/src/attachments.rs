//! Local attachments are untrusted vault data. Bound file reads before decoding,
//! decoder allocations before rendering, and the final IPC payload separately.
use base64::Engine;
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use std::{
    fs::File,
    io::{Cursor, Read, Write},
    path::Path,
};
use sticky_core::{message, Result};

pub const INPUT_LIMIT: usize = 20 * 1024 * 1024;
const SVG_LIMIT: usize = 256 * 1024;
const PIXEL_LIMIT: u64 = 16 * 1024 * 1024;
const EDGE_LIMIT: u32 = 8192;
const OUTPUT_LIMIT: usize = 5 * 1024 * 1024;
const THUMBNAIL_EDGE: u32 = 1024;

fn dimensions(width: u32, height: u32) -> Result<()> {
    if width == 0
        || height == 0
        || width > EDGE_LIMIT
        || height > EDGE_LIMIT
        || u64::from(width) * u64::from(height) > PIXEL_LIMIT
    {
        return Err(message("Attachment exceeds the 16 megapixel image limit"));
    }
    Ok(())
}

fn read_limited(reader: impl Read, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take((limit + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(message("Attachment is too large"));
    }
    Ok(bytes)
}

/// A PNG encoder may emit more than the image's raw size; enforce the transfer
/// limit while encoding rather than after allocating another unlimited buffer.
struct BoundedOutput(Cursor<Vec<u8>>);
impl Write for BoundedOutput {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.0.get_ref().len().saturating_add(buf.len()) > OUTPUT_LIMIT {
            return Err(std::io::Error::other("Attachment preview is too large"));
        }
        self.0.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl std::io::Seek for BoundedOutput {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        self.0.seek(position)
    }
}

fn raster(bytes: &[u8], format: ImageFormat) -> Result<Vec<u8>> {
    raster_with_budget(bytes, format, 96 * 1024 * 1024)
}
fn raster_with_budget(bytes: &[u8], format: ImageFormat, allocation_limit: u64) -> Result<Vec<u8>> {
    let mut decoder = decoder_with_budget(bytes, format, allocation_limit)?;
    let orientation = decoder
        .orientation()
        .map_err(|e| message(format!("Invalid image orientation: {e}")))?;
    // Animated attachments are displayed as a static first-frame preview; this
    // avoids handing an unbounded sequence of decoded frames to the webview.
    let decoded = DynamicImage::from_decoder(decoder)
        .map_err(|e| message(format!("Cannot decode image: {e}")))?;
    let mut thumbnail = decoded.thumbnail(
        decoded.width().min(THUMBNAIL_EDGE),
        decoded.height().min(THUMBNAIL_EDGE),
    );
    drop(decoded);
    thumbnail.apply_orientation(orientation);
    let mut output = BoundedOutput(Cursor::new(Vec::new()));
    thumbnail
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|e| message(format!("Cannot prepare image preview: {e}")))?;
    Ok(output.0.into_inner())
}
fn decoder_with_budget(
    bytes: &[u8],
    format: ImageFormat,
    allocation_limit: u64,
) -> Result<impl ImageDecoder + '_> {
    if format == ImageFormat::WebP {
        crate::webp_bounds::validate(bytes)?;
    }
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(EDGE_LIMIT);
    limits.max_image_height = Some(EDGE_LIMIT);
    limits.max_alloc = Some(allocation_limit);
    reader.limits(limits.clone());
    // Install limits before constructing the first decoder. PNG header probing
    // may decompress ICC/text metadata and is not a cheap, allocation-free read.
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| message(format!("Invalid image: {e}")))?;
    let (width, height) = decoder.dimensions();
    dimensions(width, height)?;
    limits
        .reserve(decoder.total_bytes())
        .map_err(|e| message(format!("Image exceeds decoder budget: {e}")))?;
    decoder
        .set_limits(limits)
        .map_err(|e| message(format!("Image exceeds decoder budget: {e}")))?;
    Ok(decoder)
}

fn safe_svg_paint(value: &str) -> bool {
    let value = value.trim().to_ascii_lowercase();
    if value.contains(['\\', '@', '<', '>']) || value.contains("expression(") {
        return false;
    }
    if value.contains("url(") {
        return value.strip_prefix("url(#").is_some_and(|v| {
            v.ends_with(')') && !v[..v.len() - 1].contains(['(', ')', '\\', '"', '\'', ':', '/'])
        });
    }
    true
}
fn safe_svg_style(value: &str) -> bool {
    value
        .split(';')
        .filter(|s| !s.trim().is_empty())
        .all(|declaration| {
            let Some((key, value)) = declaration.split_once(':') else {
                return false;
            };
            [
                "fill",
                "stroke",
                "stroke-width",
                "fill-opacity",
                "stroke-opacity",
                "opacity",
                "fill-rule",
                "stroke-linecap",
                "stroke-linejoin",
                "font-family",
                "font-size",
                "font-weight",
                "text-anchor",
                "dominant-baseline",
                "display",
                "visibility",
                "stop-color",
                "stop-opacity",
            ]
            .contains(&key.trim().to_ascii_lowercase().as_str())
                && safe_svg_paint(value)
        })
}
fn svg(bytes: &[u8]) -> Result<Vec<u8>> {
    let source = std::str::from_utf8(bytes).map_err(|_| message("SVG must be UTF-8"))?;
    let document = roxmltree::Document::parse(source).map_err(|_| message("Invalid SVG"))?;
    let root = document.root_element();
    if root.tag_name().name() != "svg" {
        return Err(message("Not an SVG image"));
    }
    let dimension = |key| {
        root.attribute(key)
            .and_then(|s| s.trim().trim_end_matches("px").parse::<f64>().ok())
    };
    let view_box = root.attribute("viewBox").and_then(|s| {
        let values: Vec<f64> = s
            .split(|c: char| c.is_whitespace() || c == ',')
            .filter(|s| !s.is_empty())
            .map(str::parse)
            .collect::<std::result::Result<_, _>>()
            .ok()?;
        (values.len() == 4).then(|| (values[2], values[3]))
    });
    let width = dimension("width").or(view_box.map(|b| b.0));
    let height = dimension("height").or(view_box.map(|b| b.1));
    let (width, height) = match (width, height) {
        (Some(w), Some(h)) if w.is_finite() && h.is_finite() && w > 0.0 && h > 0.0 => {
            dimensions(w.ceil() as u32, h.ceil() as u32)?;
            (w, h)
        }
        _ => return Err(message("SVG needs bounded width/height or a viewBox")),
    };
    // Permit static shapes, text and gradients. External resources, scripts,
    // recursive <use>, filters, masks and embedded HTML are not needed for a
    // sticky-note preview and can bypass its resource budget.
    let allowed = [
        "svg",
        "g",
        "defs",
        "title",
        "desc",
        "path",
        "rect",
        "circle",
        "ellipse",
        "line",
        "polyline",
        "polygon",
        "text",
        "tspan",
        "linearGradient",
        "radialGradient",
        "stop",
        "clipPath",
    ];
    let mut count = 0;
    for node in document.descendants().filter(|n| n.is_element()) {
        count += 1;
        if count > 2048 || !allowed.contains(&node.tag_name().name()) {
            return Err(message("SVG is too complex for an attachment preview"));
        }
        for attr in node.attributes() {
            let name = attr.name().to_ascii_lowercase();
            if name.starts_with("on")
                || name == "href"
                || name == "src"
                || name == "filter"
                || name == "mask"
                || if name == "style" {
                    !safe_svg_style(attr.value())
                } else {
                    !safe_svg_paint(attr.value())
                }
            {
                return Err(message(
                    "SVG contains unsupported active content or resources",
                ));
            }
        }
    }
    // Normalize the outer pixel box. Percentage width/height and missing values
    // must not grow to an arbitrary desktop viewport size after validation.
    let ratio = (f64::from(THUMBNAIL_EDGE) / width.max(height)).min(1.0);
    let root_start = root.range().start;
    let name_end = source[root_start + 1..]
        .find(|c: char| c.is_whitespace() || c == '/' || c == '>')
        .map(|offset| root_start + 1 + offset)
        .ok_or_else(|| message("Invalid SVG root"))?;
    let mut normalized = source.to_owned();
    let mut removed: Vec<_> = root
        .attributes()
        .filter(|a| ["width", "height"].contains(&a.name()))
        .map(|a| a.range())
        .collect();
    removed.sort_by_key(|range| std::cmp::Reverse(range.start));
    for range in removed {
        normalized.replace_range(range, "");
    }
    normalized.insert_str(
        name_end,
        &format!(
            " width=\"{}\" height=\"{}\"",
            (width * ratio).ceil(),
            (height * ratio).ceil()
        ),
    );
    Ok(normalized.into_bytes())
}

pub fn read(path: &Path) -> Result<String> {
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let format = match extension.as_str() {
        "png" => Some(ImageFormat::Png),
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "gif" => Some(ImageFormat::Gif),
        "webp" => Some(ImageFormat::WebP),
        "svg" => None,
        _ => return Err(message("Not a supported image")),
    };
    // Inspect type and size before opening/reading (directories, devices and
    // pipes are not images). Recheck the opened handle and enforce the streaming
    // cap even when a regular file changes after its metadata was inspected.
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(message("Attachment must be a regular file"));
    }
    let limit = if format.is_some() {
        INPUT_LIMIT
    } else {
        SVG_LIMIT
    };
    if metadata.len() > limit as u64 {
        return Err(message("Attachment is too large"));
    }
    let file = File::open(path)?;
    if !file.metadata()?.file_type().is_file() {
        return Err(message("Attachment must be a regular file"));
    }
    let bytes = read_limited(file, limit)?;
    let (mime, output) = if let Some(format) = format {
        ("image/png", raster(&bytes, format)?)
    } else {
        ("image/svg+xml", svg(&bytes)?)
    };
    Ok(format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(output)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(extension: &str, content: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "sticky-asset-{}.{}",
            uuid::Uuid::new_v4(),
            extension
        ));
        std::fs::write(&path, content).unwrap();
        path
    }
    #[test]
    fn byte_limit_does_not_trust_an_initial_size() {
        assert!(read_limited(std::io::repeat(0).take(1000), 20).is_err());
        assert_eq!(read_limited(&b"bounded"[..], 20).unwrap(), b"bounded");
    }
    #[test]
    fn unsupported_types_are_rejected_before_opening() {
        assert_eq!(
            read(Path::new("not-present.iso")).unwrap_err().to_string(),
            "Not a supported image"
        );
        let path = fixture("png", b"");
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(read(&path)
            .unwrap_err()
            .to_string()
            .contains("regular file"));
        std::fs::remove_dir(&path).unwrap();
    }
    #[test]
    fn oversized_regular_files_are_rejected_without_reading() {
        let path = fixture("png", b"");
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len((INPUT_LIMIT + 1) as u64)
            .unwrap();
        assert_eq!(
            read(&path).unwrap_err().to_string(),
            "Attachment is too large"
        );
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn image_dimensions_and_transfer_have_separate_budgets() {
        assert!(dimensions(8192, 8192).is_err());
        assert!(dimensions(1, 8193).is_err());
        // A tiny, CRC-correct PNG advertises 8192 x 8192 pixels. The header must
        // be rejected before the decoder can allocate the advertised bitmap.
        let bomb = [
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 32, 0, 0, 0, 32, 0,
            8, 6, 0, 0, 0, 114, 170, 202, 89, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207,
            192, 240, 31, 0, 5, 0, 1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66,
            96, 130,
        ];
        assert!(raster(&bomb, ImageFormat::Png)
            .unwrap_err()
            .to_string()
            .contains("16 megapixel"));
        let image = image::DynamicImage::new_rgba8(1200, 800);
        let mut encoded = Cursor::new(Vec::new());
        image.write_to(&mut encoded, ImageFormat::Png).unwrap();
        let result = raster(encoded.get_ref(), ImageFormat::Png).unwrap();
        let decoded = image::load_from_memory(&result).unwrap();
        assert_eq!(decoded.width(), THUMBNAIL_EDGE);
        assert!(result.len() <= OUTPUT_LIMIT);
        let mut output = BoundedOutput(Cursor::new(vec![0; OUTPUT_LIMIT]));
        assert!(output.write_all(&[1]).is_err());
    }
    #[test]
    fn decoder_budget_is_applied_before_metadata_and_output_allocations() {
        let compressed_metadata = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAXWlDQ1Bwcm9maWxlAAB4nO3BAQEAAACAkNvN7wgKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAajhPBwnTSPLLAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==").unwrap();
        // PNG discards an ICC profile when bounded decompression cannot fit it.
        // Confirm limits already apply during decoder/header construction.
        let mut bounded =
            decoder_with_budget(&compressed_metadata, ImageFormat::Png, 8192).unwrap();
        assert!(bounded.icc_profile().unwrap().is_none());
        let mut control =
            decoder_with_budget(&compressed_metadata, ImageFormat::Png, 1024 * 1024).unwrap();
        assert_eq!(control.icc_profile().unwrap().unwrap().len(), 65536);
        let rgba16 = DynamicImage::ImageRgba16(image::ImageBuffer::new(64, 64));
        let mut encoded = Cursor::new(Vec::new());
        rgba16.write_to(&mut encoded, ImageFormat::Png).unwrap();
        assert!(
            raster_with_budget(encoded.get_ref(), ImageFormat::Png, 8192)
                .unwrap_err()
                .to_string()
                .contains("decoder budget")
        );
        let small = DynamicImage::new_rgba8(1, 1);
        let mut encoded = Cursor::new(Vec::new());
        small.write_to(&mut encoded, ImageFormat::Png).unwrap();
        assert!(raster_with_budget(encoded.get_ref(), ImageFormat::Png, 8192).is_ok());
    }
    #[test]
    fn ordinary_webp_and_jpeg_exif_orientation_survive_thumbnailing() {
        let image = DynamicImage::new_rgb8(4, 2);
        let mut jpeg = Cursor::new(Vec::new());
        image.write_to(&mut jpeg, ImageFormat::Jpeg).unwrap();
        // One little-endian TIFF Orientation entry (6 = rotate 90 degrees).
        let exif = [
            b'E', b'x', b'i', b'f', 0, 0, b'I', b'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0,
            0, 0, 6, 0, 0, 0, 0, 0, 0, 0,
        ];
        let mut oriented = jpeg.get_ref()[..2].to_vec();
        oriented.extend_from_slice(&[0xff, 0xe1]);
        oriented.extend_from_slice(&((exif.len() + 2) as u16).to_be_bytes());
        oriented.extend_from_slice(&exif);
        oriented.extend_from_slice(&jpeg.get_ref()[2..]);
        let preview = raster(&oriented, ImageFormat::Jpeg).unwrap();
        let decoded = image::load_from_memory(&preview).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2, 4));
        let mut webp = Cursor::new(Vec::new());
        image.write_to(&mut webp, ImageFormat::WebP).unwrap();
        assert!(raster(webp.get_ref(), ImageFormat::WebP).is_ok());
    }
    #[test]
    fn one_pixel_lossless_webp_rejects_entropy_group_amplification_before_tables() {
        // LSB-first WebP stream: no transforms/cache; one entropy-map pixel
        // with R=0,G=128 selects group 128, requiring 129 outer groups. The
        // remaining outer tree data is deliberately absent: the budget error
        // must occur before reading it, rather than a generic truncation error.
        let mut bits = Vec::<u8>::new();
        let mut write = |value: u32, count: u8| {
            for bit in 0..count {
                bits.push(((value >> bit) & 1) as u8);
            }
        };
        write(0, 1); // no transforms
        write(0, 1); // no main color cache
        write(1, 1); // entropy map present
        write(0, 3); // entropy map block size = four pixels
        write(0, 1); // no entropy image color cache
        for symbol in [128u32, 0, 0, 255, 0] {
            write(1, 1); // simple Huffman tree
            write(0, 1); // one symbol
            if symbol > 1 {
                write(1, 1);
                write(symbol, 8);
            } else {
                write(0, 1);
                write(symbol, 1);
            }
        }
        let mut payload = vec![0x2f, 0, 0, 0, 0]; // 1x1 VP8L header
        for byte in bits.chunks(8) {
            payload.push(
                byte.iter()
                    .enumerate()
                    .fold(0u8, |value, (i, bit)| value | bit << i),
            );
        }
        let mut chunk = b"VP8L".to_vec();
        chunk.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        chunk.extend_from_slice(&payload);
        if payload.len() & 1 != 0 {
            chunk.push(0);
        }
        let mut file = b"RIFF".to_vec();
        file.extend_from_slice(&((chunk.len() + 4) as u32).to_le_bytes());
        file.extend_from_slice(b"WEBP");
        file.extend(chunk);
        let error = raster(&file, ImageFormat::WebP).unwrap_err().to_string();
        assert!(
            error.contains("Lossless Huffman group budget exceeded (128)"),
            "{error}"
        );
    }
    #[test]
    fn svg_rejects_pixel_bombs_recursive_content_and_remote_resources() {
        assert!(svg(
            br##"<svg viewBox="0 0 24 24"><path d="M0 0 L24 24" fill="url(#color)"/></svg>"##
        )
        .is_ok());
        for source in [
            r#"<svg width="8192" height="8192"/>"#,
            r#"<svg width="24" height="24"><image href="https://example.com/image.png"/></svg>"#,
            r##"<svg width="24" height="24"><use href="#loop" id="loop"/></svg>"##,
            r#"<svg width="24" height="24"><path onload="boom()"/></svg>"#,
            r#"<svg width="24" height="24"><path fill="url(https://example.com/x)"/></svg>"#,
        ] {
            assert!(svg(source.as_bytes()).is_err(), "{source}");
        }
        let normalized = svg(br##"<svg viewBox="0 0 24 24" width="100%" height="100%"><defs><linearGradient id="color"><stop style="stop-color:red"/></linearGradient></defs><path style="fill: red;stroke: url(#color)"/></svg>"##).unwrap();
        let normalized = String::from_utf8(normalized).unwrap();
        assert!(normalized.contains("width=\"24\" height=\"24\""));
        assert!(!normalized.contains("100%"));
    }
}

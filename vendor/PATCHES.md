# Vendored WebP decoder

`image-webp/` is the published crates.io `image-webp` **0.2.4** source package from
<https://crates.io/crates/image-webp/0.2.4>, upstream
<https://github.com/image-rs/image-webp>. The source, package manifest, original
manifest, README and original MIT/Apache-2.0 licenses are retained. Cargo's
registry bookkeeping and its standalone lockfile are omitted.

Published crate archive SHA-256:
`525e9ff3e1a4be2fbea1fdf0e98686a6d98b4d8f937e1bf7402245af1909e8c3`.

Sticky Markers uses this copy through the workspace `[patch.crates-io]`. It is
excluded from workspace membership; the application's regression tests exercise
the patched decoder through the production attachment pipeline.

The only runtime changes from 0.2.4 are:

1. `src/lossless.rs`: reject `num_huff_groups > 128` in `read_huffman_codes`,
   after reading the entropy map and **before constructing any outer Huffman
   groups**.
2. `src/decoder.rs`: add the corresponding `HuffmanGroupBudgetExceeded` error,
   with the message `Lossless Huffman group budget exceeded (128)`.

The shared lossless helper covers both VP8L image data and compressed ALPH data.
Pixel dimensions alone cannot bound entropy-group table allocation: an entropy
map can name a high group index even for a one-pixel image. This guard caps that
independent resource while preserving ordinary lossy and lossless images.

With the decoder's largest supported color cache, the five alphabets contain at
most 2,328 + 256 + 256 + 256 + 40 = **3,136 symbols** per group. Each tree reserves
at most twice its alphabet's node count and at most 1,024 `u32` lookup entries.
On a 64-bit target a node occupies 16 bytes, giving an upper estimate of
`128 × (2 × 3,136 × 16 + 5 × 1,024 × 4) = 15,466,496` bytes for group node/table
storage (under 16 MiB, before allocator overhead and small vector descriptors).
Other image storage remains bounded separately by the attachment pipeline.

When updating `image`/`image-webp`, compare the vendored source against the exact
new upstream release. Keep this guard and its regressions until the upstream
decoder provides an equivalent limit covering both lossless image and alpha
paths. Never silently replace this copy with the registry version. Run
`cargo test --locked --workspace` and verify ordinary WebP controls as well as
the one-pixel excessive-group regression before removing or adapting the patch.

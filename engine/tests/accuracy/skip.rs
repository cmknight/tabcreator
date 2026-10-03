//! The count-in skip every fixture runs with: a `countin_bleed*` take was recorded after a
//! count-in, so its first 100 ms are skipped (US-4.1); every other fixture skips nothing. Shared
//! by `tests/fixtures.rs`, `tests/pyin_oracle.rs` and `examples/dump_preprocessed.rs` (the
//! last two include this file by `#[path]`).

/// `skipStartMs` for the fixture called `name`.
pub fn skip_start_ms(name: &str) -> f64 {
    if name.starts_with("countin_bleed") {
        100.0
    } else {
        0.0
    }
}

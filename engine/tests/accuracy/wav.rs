//! A minimal RIFF/WAVE reader for the fixtures: 16-bit PCM, mono, any sample rate. Anything
//! else is rejected with an error naming the file.

use std::path::Path;

/// Decoded mono audio, samples scaled to -1..1.
pub struct Wav {
    pub sample_rate: u32,
    pub pcm: Vec<f32>,
}

/// Reads and decodes `path`; the error names the file.
pub fn read_wav(path: &Path) -> Result<Wav, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse_wav(&bytes).map_err(|e| format!("{}: {e}", path.display()))
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

/// Parses a 16-bit PCM mono RIFF/WAVE file, walking its chunks.
pub fn parse_wav(b: &[u8]) -> Result<Wav, String> {
    if b.len() < 12 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".to_owned());
    }
    let mut at = 12;
    let mut format: Option<(u16, u16, u32, u16)> = None;
    while at + 8 <= b.len() {
        let id = &b[at..at + 4];
        let size = u32_at(b, at + 4) as usize;
        let body = at + 8;
        let end = body
            .checked_add(size)
            .filter(|&e| e <= b.len())
            .ok_or_else(|| format!("chunk {:?} runs past the end of the file", lossy(id)))?;
        match id {
            b"fmt " => {
                if size < 16 {
                    return Err("fmt chunk too short".to_owned());
                }
                format = Some((
                    u16_at(b, body),      // audio format
                    u16_at(b, body + 2),  // channels
                    u32_at(b, body + 4),  // sample rate
                    u16_at(b, body + 14), // bits per sample
                ));
            }
            b"data" => {
                let (audio_format, channels, sample_rate, bits) =
                    format.ok_or("data chunk before fmt chunk")?;
                if audio_format != 1 || channels != 1 || bits != 16 {
                    return Err(format!(
                        "unsupported WAV: format {audio_format}, {channels} channels, {bits} bits \
                         (need 16-bit PCM mono)"
                    ));
                }
                if sample_rate == 0 {
                    return Err("sample rate 0".to_owned());
                }
                let data = &b[body..end];
                if !data.len().is_multiple_of(2) {
                    return Err("odd-length 16-bit data chunk".to_owned());
                }
                let pcm = data
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|&s| f32::from(i16::from_le_bytes(s)) / 32768.0)
                    .collect();
                return Ok(Wav { sample_rate, pcm });
            }
            _ => {}
        }
        // Chunks are padded to an even length.
        at = end + (size & 1);
    }
    Err("no data chunk".to_owned())
}

fn lossy(id: &[u8]) -> String {
    String::from_utf8_lossy(id).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(format: u16, channels: u16, bits: u16, data: &[u8]) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(b"RIFF");
        b.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        b.extend_from_slice(b"WAVEfmt ");
        b.extend_from_slice(&16u32.to_le_bytes());
        b.extend_from_slice(&format.to_le_bytes());
        b.extend_from_slice(&channels.to_le_bytes());
        b.extend_from_slice(&48_000u32.to_le_bytes());
        b.extend_from_slice(&(48_000u32 * 2).to_le_bytes());
        b.extend_from_slice(&2u16.to_le_bytes());
        b.extend_from_slice(&bits.to_le_bytes());
        b.extend_from_slice(b"data");
        b.extend_from_slice(&(data.len() as u32).to_le_bytes());
        b.extend_from_slice(data);
        b
    }

    #[test]
    fn reads_16_bit_mono_pcm() {
        let data = [0x00, 0x80, 0x00, 0x40, 0x00, 0x00];
        let w = parse_wav(&wav(1, 1, 16, &data)).unwrap();
        assert_eq!(w.sample_rate, 48_000);
        assert_eq!(w.pcm, vec![-1.0, 0.5, 0.0]);
    }

    #[test]
    fn rejects_other_formats() {
        assert!(parse_wav(&wav(1, 2, 16, &[0; 4])).is_err());
        assert!(parse_wav(&wav(1, 1, 24, &[0; 6])).is_err());
        assert!(parse_wav(&wav(3, 1, 16, &[0; 4])).is_err());
        assert!(parse_wav(b"not a wav file").is_err());
    }

    #[test]
    fn bad_format_error_names_the_file() {
        let path = std::env::temp_dir().join("accuracy-stereo-test.wav");
        std::fs::write(&path, wav(1, 2, 16, &[0; 4])).unwrap();
        let err = read_wav(&path).err().unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(err.contains(&path.display().to_string()), "{err}");
        assert!(err.contains("2 channels"), "{err}");
    }

    #[test]
    fn error_names_the_file() {
        let err = read_wav(Path::new("/nonexistent/x.wav")).err().unwrap();
        assert!(err.contains("/nonexistent/x.wav"));
    }
}

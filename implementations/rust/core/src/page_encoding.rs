//! Gzip for the UI page (`spec/protocol.md` §5.1): the adapters compress it
//! once and pick the stored copy per request.

use std::io::Write;

use flate2::write::GzEncoder;
use flate2::Compression;

/// Reads `Accept-Encoding` per RFC 9110 §12.5.3: an explicit gzip (or
/// x-gzip) entry wins over `*`, and q=0 means not acceptable.
pub fn accepts_gzip<'a>(header_values: impl IntoIterator<Item = &'a str>) -> bool {
    let (mut gzip_q, mut star_q) = (-1.0, -1.0);
    for entry in header_values.into_iter().flat_map(|v| v.split(',')) {
        let mut params = entry.split(';');
        let coding = params.next().unwrap_or_default().trim();
        let mut q = 1.0;
        for param in params {
            let (name, value) = param.split_once('=').unwrap_or((param, ""));
            if name.trim().eq_ignore_ascii_case("q") {
                q = value.trim().parse().unwrap_or(0.0);
            }
        }
        if coding.eq_ignore_ascii_case("gzip") || coding.eq_ignore_ascii_case("x-gzip") {
            gzip_q = q;
        } else if coding == "*" {
            star_q = q;
        }
    }
    if gzip_q >= 0.0 {
        gzip_q > 0.0
    } else {
        star_q > 0.0
    }
}

/// Never fails: writing to a `Vec` can't, so neither can the encoder over it.
pub fn gzip_page(page: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::best());
    encoder
        .write_all(page)
        .expect("gzip into a Vec never fails");
    encoder.finish().expect("gzip into a Vec never fails")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_gzip_follows_q_values() {
        let cases: &[(&[&str], bool)] = &[
            (&[], false),
            (&[""], false),
            (&["gzip"], true),
            (&["GZIP"], true),
            (&["x-gzip"], true),
            (&["gzip, deflate, br, zstd"], true),
            (&["br", "gzip"], true),
            (&["gzip;q=0"], false),
            (&["gzip; q=0.000"], false),
            (&["gzip;q=0.5"], true),
            (&["br"], false),
            (&["identity"], false),
            (&["*"], true),
            (&["*;q=0"], false),
            (&["gzip;q=0, *"], false),
            (&["*;q=0, gzip"], true),
            (&["gzip;q=abc"], false),
        ];
        for (headers, want) in cases {
            assert_eq!(accepts_gzip(headers.iter().copied()), *want, "{headers:?}");
        }
    }
}

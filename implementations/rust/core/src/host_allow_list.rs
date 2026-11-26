//! The optional `Host` allow-list against DNS rebinding (`spec/protocol.md`
//! §3.1). Adapters build one per router and check every request with
//! [`HostAllowList::allows`] before anything else runs.

use crate::Config;

/// Built once, at router construction. With no entries configured the check
/// is off and every `Host` passes.
#[derive(Debug, Clone, Default)]
pub struct HostAllowList {
    /// `None` when `allowed_hosts` is absent or empty. Entries that fail to
    /// parse are dropped, so a list of only bad entries is `Some(empty)` and
    /// rejects every request.
    entries: Option<Vec<(String, Option<u16>)>>,
    warnings: Vec<String>,
}

impl HostAllowList {
    /// Builds the list from `config.allowed_hosts` and logs its warnings.
    pub fn from_config(config: &Config) -> Self {
        let list = Self::new(&config.allowed_hosts);
        for warning in &list.warnings {
            tracing::warn!("ashurbanipal: {warning}");
        }
        list
    }

    fn new(hosts: &[String]) -> Self {
        if hosts.is_empty() {
            return Self {
                entries: None,
                warnings: vec![
                    "allowed_hosts is not set, so any Host header is accepted and a \
                     DNS-rebinding page can read the viewer (spec/protocol.md §3.1)"
                        .to_string(),
                ],
            };
        }
        let mut warnings = Vec::new();
        let entries = hosts
            .iter()
            .filter_map(|entry| {
                let parsed = parse_host_port(entry);
                if parsed.is_none() {
                    warnings.push(format!(
                        "allowed_hosts entry {entry:?} is not a host name with an optional \
                         port, so it matches nothing"
                    ));
                }
                parsed.map(|(name, port)| (name.to_ascii_lowercase(), port))
            })
            .collect();
        Self {
            entries: Some(entries),
            warnings,
        }
    }

    /// False when `allowed_hosts` is absent or empty, so an adapter can skip
    /// the check entirely.
    pub fn is_active(&self) -> bool {
        self.entries.is_some()
    }

    /// `host` is the request's raw `Host` header, or its HTTP/2 `:authority`;
    /// never a forwarded header. With the check on, a missing or malformed
    /// `host` is rejected.
    pub fn allows(&self, host: Option<&str>) -> bool {
        let Some(entries) = &self.entries else {
            return true;
        };
        let Some((name, port)) = host.and_then(parse_host_port) else {
            return false;
        };
        entries.iter().any(|(entry_name, entry_port)| {
            entry_name.eq_ignore_ascii_case(name) && entry_port.is_none_or(|p| port == Some(p))
        })
    }
}

/// `name` or `name:port`, with an IPv6 literal in brackets; one trailing dot
/// on the name is dropped. No scheme, path, userinfo or wildcard.
fn parse_host_port(text: &str) -> Option<(&str, Option<u16>)> {
    let (name, port) = if text.starts_with('[') {
        let end = text.find(']')?;
        let (name, rest) = text.split_at(end + 1);
        let inner = &name[1..name.len() - 1];
        if inner.is_empty()
            || !inner
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
        {
            return None;
        }
        let port = if rest.is_empty() {
            None
        } else {
            Some(rest.strip_prefix(':')?)
        };
        (name, port)
    } else {
        let (name, port) = match text.split_once(':') {
            Some((name, port)) => (name, Some(port)),
            None => (text, None),
        };
        // `billing.internal.` is the same DNS name as `billing.internal`.
        let name = name.strip_suffix('.').unwrap_or(name);
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-' || b == b'_')
        {
            return None;
        }
        (name, port)
    };
    let port = match port {
        None => None,
        Some(p) if !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()) => {
            Some(p.parse::<u16>().ok()?)
        }
        Some(_) => return None,
    };
    Some((name, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str = include_str!("../../../../spec/fixtures/host-allow-list-tests.json");

    #[derive(serde::Deserialize)]
    struct Fixtures {
        cases: Vec<Case>,
    }

    #[derive(serde::Deserialize)]
    struct Case {
        name: String,
        allowed_hosts: Vec<String>,
        host: Option<String>,
        allowed: bool,
    }

    #[test]
    fn shared_fixture_cases() {
        let fixtures: Fixtures = serde_json::from_str(FIXTURES).unwrap();
        for case in fixtures.cases {
            let hosts = HostAllowList::new(&case.allowed_hosts);
            assert_eq!(
                hosts.allows(case.host.as_deref()),
                case.allowed,
                "{}",
                case.name
            );
        }
    }

    #[test]
    fn no_entries_warns_that_the_check_is_off() {
        let hosts = HostAllowList::new(&[]);
        assert!(!hosts.is_active());
        assert_eq!(hosts.warnings.len(), 1);
        assert!(hosts.warnings[0].contains("allowed_hosts is not set"));
    }

    #[test]
    fn warnings_reach_a_log_logger_without_a_tracing_subscriber() {
        struct Capture(std::sync::Mutex<Vec<String>>);
        impl log::Log for Capture {
            fn enabled(&self, _: &log::Metadata) -> bool {
                true
            }
            fn log(&self, record: &log::Record) {
                self.0.lock().unwrap().push(record.args().to_string());
            }
            fn flush(&self) {}
        }
        static CAPTURE: Capture = Capture(std::sync::Mutex::new(Vec::new()));
        // The only test in this binary that installs a logger.
        log::set_logger(&CAPTURE).unwrap();
        log::set_max_level(log::LevelFilter::Warn);
        HostAllowList::from_config(&Config::default());
        let messages = CAPTURE.0.lock().unwrap();
        assert!(
            messages
                .iter()
                .any(|m| m.contains("allowed_hosts is not set")),
            "{messages:?}"
        );
    }

    #[test]
    fn each_bad_entry_warns() {
        let entries = [
            "http://localhost",
            "localhost/x",
            "*.example",
            "localhost:abc",
            "ok.example",
        ];
        let hosts = HostAllowList::new(&entries.map(String::from));
        assert_eq!(hosts.warnings.len(), 4);
        assert!(hosts.warnings[0].contains("\"http://localhost\""));
    }
}

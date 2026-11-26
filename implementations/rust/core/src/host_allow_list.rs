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

    fn list(entries: &[&str]) -> HostAllowList {
        HostAllowList::new(&entries.iter().map(|e| e.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn no_entries_turns_the_check_off_with_a_warning() {
        let hosts = list(&[]);
        assert!(hosts.allows(Some("anything.example")));
        assert!(hosts.allows(None));
        assert_eq!(hosts.warnings.len(), 1);
        assert!(hosts.warnings[0].contains("allowed_hosts is not set"));
    }

    #[test]
    fn a_name_without_a_port_matches_any_port() {
        let hosts = list(&["billing.internal"]);
        assert!(hosts.allows(Some("billing.internal")));
        assert!(hosts.allows(Some("billing.internal:4000")));
        assert!(!hosts.allows(Some("evil.example")));
        assert!(!hosts.allows(Some("billing.internal.evil.example")));
        assert!(hosts.warnings.is_empty());
    }

    #[test]
    fn a_name_with_a_port_matches_only_that_port() {
        let hosts = list(&["billing.internal:4000"]);
        assert!(hosts.allows(Some("billing.internal:4000")));
        assert!(!hosts.allows(Some("billing.internal")));
        assert!(!hosts.allows(Some("billing.internal:4001")));
    }

    #[test]
    fn names_compare_case_insensitively() {
        let hosts = list(&["Billing.Internal"]);
        assert!(hosts.allows(Some("BILLING.internal:4000")));
    }

    #[test]
    fn a_trailing_dot_names_the_same_host() {
        let hosts = list(&["billing.internal", "other.internal."]);
        assert!(hosts.allows(Some("billing.internal.")));
        assert!(hosts.allows(Some("billing.internal.:4000")));
        assert!(hosts.allows(Some("other.internal")));
        assert!(!hosts.allows(Some(".")));
        assert!(!hosts.allows(Some("billing.internal..")));
    }

    #[test]
    fn ipv6_literals_use_brackets() {
        let hosts = list(&["[::1]:4000", "[fe80::1]"]);
        assert!(hosts.allows(Some("[::1]:4000")));
        assert!(!hosts.allows(Some("[::1]:4001")));
        assert!(hosts.allows(Some("[FE80::1]:80")));
        assert!(!hosts.allows(Some("::1")));
    }

    #[test]
    fn a_missing_or_malformed_host_is_rejected() {
        let hosts = list(&["localhost"]);
        for host in [
            None,
            Some(""),
            Some("localhost:"),
            Some("localhost:99999"),
            Some("localhost:80x"),
            Some("user@localhost"),
            Some("localhost/path"),
            Some("local host"),
        ] {
            assert!(!hosts.allows(host), "{host:?}");
        }
    }

    #[test]
    fn bad_entries_match_nothing_and_warn() {
        let hosts = list(&[
            "http://localhost",
            "localhost/x",
            "*.example",
            "localhost:abc",
            "ok.example",
        ]);
        assert_eq!(hosts.warnings.len(), 4);
        assert!(hosts.warnings[0].contains("\"http://localhost\""));
        assert!(!hosts.allows(Some("localhost")));
        assert!(hosts.allows(Some("ok.example")));
    }

    #[test]
    fn a_list_of_only_bad_entries_rejects_everything() {
        let hosts = list(&["http://localhost"]);
        assert!(!hosts.allows(Some("localhost")));
        assert!(!hosts.allows(None));
    }
}

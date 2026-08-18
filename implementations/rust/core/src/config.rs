use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Off unless the host sets this explicitly. Ashurbanipal doesn't know
    /// or police which environment it's running in — that's the host's
    /// call entirely; see `docs/design.md` §6.
    pub enabled: bool,
    pub limits: Limits,
    pub siblings: Vec<Sibling>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            limits: Limits::default(),
            siblings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Limits {
    pub default_page_size: u32,
    pub max_page_size: u32,
    pub query_timeout_secs: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            default_page_size: 50,
            max_page_size: 100,
            query_timeout_secs: 5,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct Sibling {
    pub name: String,
    pub dbviewer_url: String,
    pub health_path: String,
}

#[derive(Debug)]
pub enum ConfigError {
    Toml(toml::de::Error),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Toml(e) => write!(f, "invalid ashurbanipal config: {e}"),
        }
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    pub fn from_toml(toml_str: &str) -> Result<Self, ConfigError> {
        toml::from_str(toml_str).map_err(ConfigError::Toml)
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_by_default() {
        assert!(!Config::default().is_enabled());
    }

    #[test]
    fn disabled_when_config_absent() {
        // Malformed/incomplete config (no `enabled` key at all) must fail
        // closed, not silently enable via some other default.
        let config = Config::from_toml("").unwrap();
        assert!(!config.is_enabled());
    }

    #[test]
    fn enabled_when_explicitly_set() {
        let config = Config::from_toml("enabled = true").unwrap();
        assert!(config.is_enabled());
    }

    #[test]
    fn parses_full_config() {
        let config = Config::from_toml(
            r#"
            enabled = true

            [limits]
            default_page_size = 25
            max_page_size = 50
            query_timeout_secs = 3

            [[siblings]]
            name = "billing"
            dbviewer_url = "https://billing.internal.vpn/__ashurbanipal"
            health_path = "/health"
            "#,
        )
        .unwrap();
        assert!(config.is_enabled());
        assert_eq!(config.limits.max_page_size, 50);
        assert_eq!(config.siblings.len(), 1);
    }

    #[test]
    fn defaults_applied() {
        let config = Config::from_toml("enabled = true").unwrap();
        assert_eq!(config.limits.default_page_size, 50);
        assert_eq!(config.limits.max_page_size, 100);
        assert_eq!(config.limits.query_timeout_secs, 5);
        assert!(config.siblings.is_empty());
    }
}

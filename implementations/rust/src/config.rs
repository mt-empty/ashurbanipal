use serde::Deserialize;

/// `production` is deliberately not representable: config naming it fails
/// at parse time. Any other token is a valid environment name — the
/// vocabulary is open so `uat`/`sit`/`int`-style org naming isn't forced
/// to lie.
const PRODUCTION_ALIASES: &[&str] = &["production", "prod", "prd", "live"];

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub environment: String,
    /// Which environments the browser is enabled for. Empty means disabled
    /// everywhere.
    #[serde(default)]
    pub enabled_for: Vec<String>,
    #[serde(default)]
    pub limits: Limits,
    #[serde(default)]
    pub siblings: Vec<Sibling>,
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
    ProductionEnabled(String),
    Toml(toml::de::Error),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ProductionEnabled(v) => write!(
                f,
                "ashurbanipal must never be enabled in production: `enabled_for` contains {v:?}"
            ),
            Self::Toml(e) => write!(f, "invalid ashurbanipal config: {e}"),
        }
    }
}

impl std::error::Error for ConfigError {}

fn is_production_like(value: &str) -> bool {
    PRODUCTION_ALIASES
        .iter()
        .any(|alias| value.eq_ignore_ascii_case(alias))
}

impl Config {
    pub fn from_toml(toml_str: &str) -> Result<Self, ConfigError> {
        let config: Config = toml::from_str(toml_str).map_err(ConfigError::Toml)?;
        config.validate()?;
        Ok(config)
    }

    /// Constructing a `Config` directly (e.g. in host code) should call
    /// this before `router()`.
    pub fn validate(&self) -> Result<(), ConfigError> {
        for value in &self.enabled_for {
            if is_production_like(value) {
                return Err(ConfigError::ProductionEnabled(value.clone()));
            }
        }
        Ok(())
    }

    /// `any` matches every environment except production-like ones.
    pub fn is_enabled(&self) -> bool {
        if is_production_like(&self.environment) {
            return false;
        }
        self.enabled_for.iter().any(|enabled| {
            enabled.eq_ignore_ascii_case("any") || enabled.eq_ignore_ascii_case(&self.environment)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base(environment: &str, enabled_for: &[&str]) -> Config {
        Config {
            environment: environment.to_string(),
            enabled_for: enabled_for.iter().map(|s| s.to_string()).collect(),
            limits: Limits::default(),
            siblings: Vec::new(),
        }
    }

    #[test]
    fn production_aliases_rejected_at_parse_time() {
        for alias in ["production", "prod", "PROD", "Production", "PRD", "live"] {
            let toml_str = format!("environment = \"dev\"\nenabled_for = [\"dev\", \"{alias}\"]");
            let err = Config::from_toml(&toml_str).unwrap_err();
            assert!(
                matches!(err, ConfigError::ProductionEnabled(_)),
                "{alias} should be rejected, got: {err}"
            );
        }
    }

    #[test]
    fn any_non_production_token_accepted() {
        for env in ["uat", "sit", "int", "stagin", "qa-eu-1"] {
            let toml_str = format!("environment = \"{env}\"\nenabled_for = [\"{env}\"]");
            let config = Config::from_toml(&toml_str).unwrap();
            assert!(config.is_enabled(), "{env} should enable when it matches");
        }
    }

    #[test]
    fn parses_full_config() {
        let config = Config::from_toml(
            r#"
            environment = "dev"
            enabled_for = ["dev", "integration", "staging"]

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
    fn disabled_when_environment_not_listed() {
        assert!(!base("staging", &["dev"]).is_enabled());
        assert!(!base("dev", &[]).is_enabled());
    }

    #[test]
    fn disabled_when_enabled_for_absent_from_config() {
        // Malformed/incomplete config (no `enabled_for` key at all) must
        // fail closed, not silently enable via some other default.
        let config = Config::from_toml("environment = \"dev\"").unwrap();
        assert!(!config.is_enabled());
    }

    #[test]
    fn enabled_case_insensitively() {
        assert!(base("DEV", &["dev"]).is_enabled());
        assert!(base("staging", &["STAGING"]).is_enabled());
    }

    #[test]
    fn any_excludes_production_like_environments() {
        assert!(base("dev", &["any"]).is_enabled());
        assert!(base("staging", &["any"]).is_enabled());
        assert!(!base("production", &["any"]).is_enabled());
        assert!(!base("PROD", &["any"]).is_enabled());
    }

    #[test]
    fn defaults_applied() {
        let config = Config::from_toml("environment = \"dev\"\nenabled_for = [\"dev\"]").unwrap();
        assert_eq!(config.limits.default_page_size, 50);
        assert_eq!(config.limits.max_page_size, 100);
        assert_eq!(config.limits.query_timeout_secs, 5);
        assert!(config.siblings.is_empty());
    }
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Fail-closed: disabled unless the host enables it (`spec/protocol.md` §4).
    pub enabled: bool,
    pub limits: Limits,
    pub instance: Option<Instance>,
    pub siblings: Vec<Sibling>,
}

/// This instance's own name and label. Labels are opaque host strings: echoed,
/// never parsed or acted on (`spec/protocol.md` §4).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Instance {
    pub name: String,
    pub label: String,
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
    pub base_url: String,
    pub health_path: String,
    pub label: Option<String>,
}

impl Sibling {
    fn is(&self, instance: &Instance) -> bool {
        self.name == instance.name && self.label.as_deref() == Some(instance.label.as_str())
    }
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

    /// The `instance`/`label` rules of `spec/protocol.md` §5.6; adapters call
    /// this once, at router construction.
    pub fn validate_siblings(&self) -> Result<(), String> {
        if let Some(instance) = &self.instance {
            if instance.name.is_empty() || instance.label.is_empty() {
                return Err("instance needs a non-empty name and label".into());
            }
        }
        let mut seen = std::collections::HashSet::new();
        for sibling in &self.siblings {
            if sibling.label.as_deref() == Some("") {
                return Err(format!(
                    "sibling {:?} has an empty label; omit it instead",
                    sibling.name
                ));
            }
            if !seen.insert((sibling.name.as_str(), sibling.label.as_deref())) {
                return Err(format!(
                    "two siblings share the name {:?} and the same label",
                    sibling.name
                ));
            }
        }
        Ok(())
    }

    /// Whether `sibling` is this instance's own entry, which is reported
    /// healthy without a health check: it is serving the response.
    pub fn is_instance(&self, sibling: &Sibling) -> bool {
        self.instance.as_ref().is_some_and(|i| sibling.is(i))
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
        // Absent config stays disabled (`spec/protocol.md` §4).
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
            base_url = "https://billing.internal.vpn/__ashurbanipal"
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
        assert!(config.instance.is_none());
    }

    const LABELLED: &str = r#"
        [instance]
        name = "orders"
        label = "dev"

        [[siblings]]
        name = "orders"
        label = "dev"
        base_url = "http://orders-dev/__ashurbanipal"
        health_path = "/health"

        [[siblings]]
        name = "orders"
        label = "int"
        base_url = "http://orders-int/__ashurbanipal"
        health_path = "/health"

        [[siblings]]
        name = "billing"
        base_url = "http://billing/__ashurbanipal"
        health_path = "/health"
    "#;

    #[test]
    fn parses_instance_and_labels() {
        let config = Config::from_toml(LABELLED).unwrap();
        assert_eq!(
            config.instance,
            Some(Instance {
                name: "orders".into(),
                label: "dev".into()
            })
        );
        assert_eq!(config.siblings[1].label.as_deref(), Some("int"));
        assert_eq!(config.siblings[2].label, None);
        assert_eq!(config.validate_siblings(), Ok(()));
    }

    #[test]
    fn only_the_matching_name_and_label_is_this_instance() {
        let config = Config::from_toml(LABELLED).unwrap();
        let mine: Vec<_> = config
            .siblings
            .iter()
            .map(|s| config.is_instance(s))
            .collect();
        assert_eq!(mine, [true, false, false]);
    }

    #[test]
    fn nothing_is_this_instance_without_an_instance() {
        let config = Config::from_toml(&LABELLED.replace("[instance]", "[unused]")).unwrap();
        assert!(!config.siblings.iter().any(|s| config.is_instance(s)));
    }

    #[test]
    fn instance_with_an_empty_label_is_invalid() {
        let mut config = Config::from_toml(LABELLED).unwrap();
        config.instance.as_mut().unwrap().label.clear();
        assert!(config.validate_siblings().is_err());
    }

    #[test]
    fn instance_missing_a_label_does_not_parse() {
        assert!(Config::from_toml("[instance]\nname = \"orders\"").is_err());
    }

    #[test]
    fn empty_sibling_label_is_invalid() {
        let config =
            Config::from_toml(&LABELLED.replace("label = \"int\"", "label = \"\"")).unwrap();
        assert!(config.validate_siblings().is_err());
    }

    #[test]
    fn duplicate_name_and_label_is_invalid() {
        let config =
            Config::from_toml(&LABELLED.replace("label = \"int\"", "label = \"dev\"")).unwrap();
        assert!(config.validate_siblings().is_err());
    }

    #[test]
    fn duplicate_unlabelled_name_is_invalid() {
        let mut config = Config::from_toml(LABELLED).unwrap();
        config.siblings.push(config.siblings[2].clone());
        assert!(config.validate_siblings().is_err());
    }
}

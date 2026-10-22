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

    /// What `/api/siblings` reports. Adapters build it once, at router
    /// construction.
    pub fn siblings_view(&self) -> SiblingsView {
        let mut warnings = Vec::new();
        let instance = match &self.instance {
            Some(i) if i.name.is_empty() || i.label.is_empty() => {
                warnings.push("instance needs a non-empty name and label; ignored".into());
                None
            }
            other => other.clone(),
        };
        let mut seen = std::collections::HashMap::new();
        let siblings = self
            .siblings
            .iter()
            .map(|sibling| {
                let mut sibling = sibling.clone();
                if sibling.label.as_deref() == Some("") {
                    warnings.push(format!(
                        "sibling {:?} has an empty label; treated as unlabelled",
                        sibling.name
                    ));
                    sibling.label = None;
                }
                let copies = seen
                    .entry((sibling.name.clone(), sibling.label.clone()))
                    .or_insert(0);
                *copies += 1;
                if *copies == 2 {
                    warnings.push(match &sibling.label {
                        Some(label) => format!(
                            "two siblings share the name {:?} and the label {label:?}",
                            sibling.name
                        ),
                        None => format!(
                            "two siblings share the name {:?} and no label",
                            sibling.name
                        ),
                    });
                }
                sibling
            })
            .collect();
        SiblingsView {
            instance,
            siblings,
            warnings,
        }
    }
}

/// The sibling config after `spec/protocol.md` §5.6's corrections, which
/// never reject it: each correction is reported in `warnings` instead.
#[derive(Debug, Clone, Default)]
pub struct SiblingsView {
    pub instance: Option<Instance>,
    pub siblings: Vec<Sibling>,
    pub warnings: Vec<String>,
}

impl SiblingsView {
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
        assert!(config.siblings_view().warnings.is_empty());
    }

    #[test]
    fn only_the_matching_name_and_label_is_this_instance() {
        let view = Config::from_toml(LABELLED).unwrap().siblings_view();
        let mine: Vec<_> = view.siblings.iter().map(|s| view.is_instance(s)).collect();
        assert_eq!(mine, [true, false, false]);
    }

    #[test]
    fn nothing_is_this_instance_without_an_instance() {
        let view = Config::from_toml(&LABELLED.replace("[instance]", "[unused]"))
            .unwrap()
            .siblings_view();
        assert!(!view.siblings.iter().any(|s| view.is_instance(s)));
    }

    #[test]
    fn instance_with_an_empty_label_is_ignored_with_a_warning() {
        let mut config = Config::from_toml(LABELLED).unwrap();
        config.instance.as_mut().unwrap().label.clear();
        let view = config.siblings_view();
        assert_eq!(view.instance, None);
        assert_eq!(
            view.warnings,
            ["instance needs a non-empty name and label; ignored"]
        );
    }

    #[test]
    fn instance_missing_a_label_does_not_parse() {
        assert!(Config::from_toml("[instance]\nname = \"orders\"").is_err());
    }

    #[test]
    fn empty_sibling_label_is_unlabelled_with_a_warning() {
        let view = Config::from_toml(&LABELLED.replace("label = \"int\"", "label = \"\""))
            .unwrap()
            .siblings_view();
        assert_eq!(view.siblings[1].label, None);
        assert_eq!(
            view.warnings,
            ["sibling \"orders\" has an empty label; treated as unlabelled"]
        );
    }

    #[test]
    fn duplicates_are_all_kept_with_one_warning() {
        let mut config =
            Config::from_toml(&LABELLED.replace("label = \"int\"", "label = \"dev\"")).unwrap();
        config.siblings.push(config.siblings[2].clone());
        config.siblings.push(config.siblings[2].clone());
        let view = config.siblings_view();
        assert_eq!(view.siblings.len(), 5);
        assert_eq!(
            view.warnings,
            [
                "two siblings share the name \"orders\" and the label \"dev\"",
                "two siblings share the name \"billing\" and no label",
            ]
        );
    }
}

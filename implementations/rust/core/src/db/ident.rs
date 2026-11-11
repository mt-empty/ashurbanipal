/// A schema, table or column name as a catalog query returned it. It is the
/// only kind of name `quote_ident` takes, so request text never reaches SQL as an identifier.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Ident(String);

impl Ident {
    /// Called only with a name read from a catalog query's result, never with request text.
    pub(in crate::db) fn from_catalog(name: String) -> Self {
        Ident(name)
    }

    #[cfg(test)]
    pub(crate) fn for_test(name: &str) -> Self {
        Ident(name.to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl std::ops::Deref for Ident {
    type Target = str;

    fn deref(&self) -> &str {
        &self.0
    }
}

impl std::borrow::Borrow<str> for Ident {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl PartialEq<str> for Ident {
    fn eq(&self, other: &str) -> bool {
        self.0 == other
    }
}

use super::{DbError, NotAllowedKind};

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

    /// The entry of `list` that `name` matches exactly, or `not_allowed` of `kind` naming it.
    pub(crate) fn find_in<'a>(
        list: &'a [Ident],
        name: &str,
        kind: NotAllowedKind,
    ) -> Result<&'a Ident, DbError> {
        list.iter()
            .find(|i| i.0 == name)
            .ok_or_else(|| DbError::not_allowed(kind, format!("{} {name:?}", kind.noun())))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl std::borrow::Borrow<str> for Ident {
    fn borrow(&self) -> &str {
        &self.0
    }
}

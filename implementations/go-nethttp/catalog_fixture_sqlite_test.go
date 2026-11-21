//go:build sqlite

package ashurbanipal

import "testing"

var sqliteFixtureEngine = fixtureEngine{
	name: "sqlite", dialect: sqliteJoinDialect, splicesSchema: false,
	column: func(c map[string]any) colMeta {
		declared := fixtureString(c, "declared")
		typeName := declared
		if typeName == "" {
			typeName = "unknown"
		}
		class := sqliteColumnClass(declared)
		return colMeta{name: fixtureString(c, "name"), typeName: typeName, class: class, compare: sqliteTypedCompare(class)}
	},
}

func TestJoinBuilderFixturesSQLite(t *testing.T) {
	runJoinFixture(t, sqliteFixtureEngine)
}

func TestFilterBuilderFixturesSQLite(t *testing.T) {
	runFilterFixture(t, sqliteFixtureEngine)
}

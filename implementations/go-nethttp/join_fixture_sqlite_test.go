//go:build sqlite

package ashurbanipal

import "testing"

func TestJoinBuilderFixturesSQLite(t *testing.T) {
	runJoinFixture(t, joinFixtureEngine{
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
	})
}

//go:build mysql

package ashurbanipal

import "testing"

func TestJoinBuilderFixturesMySQL(t *testing.T) {
	runJoinFixture(t, joinFixtureEngine{
		name: "mysql", dialect: mysqlJoinDialect, splicesSchema: true,
		column: func(c map[string]any) colMeta {
			return colMeta{
				name: fixtureString(c, "name"), typeName: fixtureString(c, "column_type"),
				class:     mysqlColumnClass(fixtureString(c, "data_type"), fixtureString(c, "column_type")),
				compare:   mysqlTypedCompare(fixtureString(c, "data_type")),
				collation: fixtureCollation(c),
			}
		},
	})
}

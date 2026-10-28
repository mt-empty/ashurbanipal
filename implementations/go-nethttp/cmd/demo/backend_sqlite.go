//go:build sqlite

package main

import (
	"database/sql"

	_ "modernc.org/sqlite"

	ashurbanipal "github.com/mt-empty/ashurbanipal/implementations/go-nethttp"
)

func init() {
	backends["sqlite"] = func(timeout int) (ashurbanipal.DbSource, *sql.DB) {
		db := openDB("sqlite", requireEnv("SQLITE_PATH", "sqlite"))
		return ashurbanipal.NewSQLiteSource(db, timeout), db
	}
}

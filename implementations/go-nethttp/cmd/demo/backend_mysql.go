//go:build mysql

package main

import (
	"database/sql"
	"log"
	"net/url"
	"strings"

	"github.com/go-sql-driver/mysql"

	ashurbanipal "github.com/mt-empty/ashurbanipal/implementations/go-nethttp"
)

func init() {
	backends["mysql"] = func(timeout int) (ashurbanipal.DbSource, *sql.DB) {
		db := openDB("mysql", mysqlDSN(requireEnv("MYSQL_URL", "mysql")))
		return ashurbanipal.NewMySQLSource(db, timeout), db
	}
}

// mysqlDSN turns a mysql://user:pass@host:port/db URL into the driver's DSN.
func mysqlDSN(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		log.Fatalf("parsing MYSQL_URL: %v", err)
	}
	cfg := mysql.NewConfig()
	cfg.User = u.User.Username()
	cfg.Passwd, _ = u.User.Password()
	cfg.Net = "tcp"
	cfg.Addr = u.Host
	cfg.DBName = strings.TrimPrefix(u.Path, "/")
	return cfg.FormatDSN()
}

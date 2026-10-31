# ashurbanipal-node-express

A read-only database browser you mount inside your own [Express](https://expressjs.com) app. It reuses your app's database pool, so there are no extra credentials and nothing extra to deploy. Part of [Ashurbanipal](https://github.com/mt-empty/ashurbanipal).

Requires Node.js 24+ and Express 5.

## Install

```sh
npm install ashurbanipal-node-express pg
```

Install only the driver you use: `pg` for Postgres, `mysql2` for MySQL or MariaDB, `sqlite3` for SQLite.

## Quick start

```ts
import express from "express";
import { Pool } from "pg";
import { createRouter, PostgresSource } from "ashurbanipal-node-express";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const viewer = createRouter({ enabled: true }, [{ name: "primary", source: new PostgresSource(pool) }]);

const app = express();
// app.get(...) your own routes
app.use(viewer); // the router already includes the /__ashurbanipal path
app.listen(3000);
```

Open <http://localhost:3000/__ashurbanipal>.

## Turn it on only where you want it

`enabled` defaults to off. When it is off, every viewer path returns 404. Decide where to enable it, for example from an environment variable:

```ts
createRouter({ enabled: process.env.ASHURBANIPAL_ENABLED === "true" }, sources);
```

## Protect it

Ashurbanipal has no login. Anyone who can reach `/__ashurbanipal` can read every table your app's database user can read. Put your own auth in front, and check a role, not just a login. Register the guard on the viewer's path, before the viewer:

```ts
app.use("/__ashurbanipal", (req, res, next) => {
  if (!isAdmin(req)) return res.status(401).end();
  next();
});

app.use(viewer);
```

If you changed `basePath`, guard that path instead.

## MySQL, MariaDB, or SQLite

Import these sources from their own paths. The main entry doesn't export them, so a Postgres-only app never loads `mysql2` or `sqlite3`:

```ts
import { createPool } from "mysql2/promise";
import { MySqlSource } from "ashurbanipal-node-express/dist/src/db/mysql.js";

const viewer = createRouter(config, [{ name: "primary", source: new MySqlSource(createPool(process.env.MYSQL_URL!)) }]);
```

```ts
import sqlite3 from "sqlite3";
import { SqliteSource } from "ashurbanipal-node-express/dist/src/db/sqlite.js";

const viewer = createRouter(config, [{ name: "primary", source: new SqliteSource(new sqlite3.Database("app.db")) }]);
```

Column comments and common-value stats are empty on MySQL and SQLite.

## More than one database

Pass more than one source. The first one is the default, and the UI lets you switch between them:

```ts
createRouter(config, [
  { name: "orders", source: new PostgresSource(ordersPool) },
  { name: "billing", source: new PostgresSource(billingPool) },
]);
```

## Configuration

```ts
createRouter(
  {
    enabled: true,
    basePath: "/__ashurbanipal", // optional; change the URL path
    limits: { defaultPageSize: 50, maxPageSize: 100, queryTimeoutSecs: 5 }, // optional; the defaults
  },
  sources,
);
```

The [configuration table](https://github.com/mt-empty/ashurbanipal#configuration) lists every option, including `instance` and `siblings`. Those let the UI show which of your other services are reachable. In TypeScript, write the names in camelCase (`baseUrl`, `healthPath`).

## See also

- [Live demo](https://mt-empty.github.io/ashurbanipal/demo/live/)

# Ashurbanipal Spring Boot starter

A read-only database browser for your own Spring Boot app. It reuses your app's `DataSource`, so there are no extra credentials and nothing extra to deploy. Part of [Ashurbanipal](https://github.com/mt-empty/ashurbanipal).

Requires Java 21+ and Spring Boot 4 (Spring MVC). It does not work on Spring Boot 3.

## Install

Gradle:

```kotlin
implementation("io.github.mt-empty:ashurbanipal-spring-boot-starter:0.12.0")
```

Maven:

```xml
<dependency>
  <groupId>io.github.mt-empty</groupId>
  <artifactId>ashurbanipal-spring-boot-starter</artifactId>
  <version>0.12.0</version>
</dependency>
```

Your app must be a Spring MVC app (`spring-boot-starter-web`) with a `DataSource` bean and a JDBC driver on the classpath. The starter adds no driver of its own.

## Quick start

Add this to `application.yml`:

```yaml
ashurbanipal:
  enabled: true
```

Start your app and open `http://localhost:8080/__ashurbanipal`. That's it: the starter uses your app's `DataSource` and assumes Postgres.

## Turn it on only where you want it

`enabled` defaults to `false`. When it is off, the starter registers nothing, so the path returns 404. Decide where to enable it, for example from an environment variable:

```yaml
ashurbanipal:
  enabled: ${ASHURBANIPAL_ENABLED:false}
```

## Protect it

Ashurbanipal has no login. Anyone who can reach `/__ashurbanipal` can read every table your app's database user can read. Put your own auth in front, and check a role, not just a login. With Spring Security:

```kotlin
http.authorizeHttpRequests {
    it.requestMatchers("/__ashurbanipal/**").hasRole("ADMIN")
}
```

If you changed `base-path`, match that path instead. Without Spring Security, a `OncePerRequestFilter` that matches only that path does the same job.

## MySQL, MariaDB, or SQLite

Name the backend on a source. `mysql` covers MariaDB too:

```yaml
ashurbanipal:
  enabled: true
  sources:
    - name: primary
      backend: mysql   # or sqlite
```

Add the driver yourself, for example `com.mysql:mysql-connector-j`, `org.mariadb.jdbc:mariadb-java-client`, or `org.xerial:sqlite-jdbc`. The starter never guesses the backend from the driver on your classpath.

Column comments and common-value stats are empty on MySQL and SQLite.

## More than one database

List each source. The first one is the default, and the UI lets you switch between them. When your app has more than one `DataSource` bean, name the bean for each source:

```yaml
ashurbanipal:
  enabled: true
  sources:
    - name: orders
      data-source-bean: ordersDataSource
    - name: billing
      data-source-bean: billingDataSource
```

## Configuration

```yaml
ashurbanipal:
  enabled: true
  base-path: /__ashurbanipal   # optional; change the URL path
  limits:                      # optional; these are the defaults
    default-page-size: 50
    max-page-size: 100
    query-timeout-secs: 5
```

The [configuration table](https://github.com/mt-empty/ashurbanipal#configuration) lists every option, including `instance` and `siblings`. Those let the UI show which of your other services are reachable. In YAML, write the names in kebab-case (`base-url`, `health-path`).

## Troubleshooting

- **The UI loads but shows no data.** Your `Content-Security-Policy` probably blocks inline scripts. The page runs one inline `<script type="module">`, so allow it for the viewer's path.
- **Large filters return Tomcat's own 400 page.** A long filter can go over Tomcat's 8 KB header limit. Raise `server.max-http-request-header-size`, for example to `64KB`.

## See also

- [Live demo](https://mt-empty.github.io/ashurbanipal/demo/live/)

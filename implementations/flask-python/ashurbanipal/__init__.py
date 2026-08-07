"""Ashurbanipal — Flask port. `spec/protocol.md` + `spec/openapi.yaml`
peer to the Rust/Spring/Go/Node implementations (see `PORTING.md`).

Usage, mirroring every other port's `router(config, source)`:

    from ashurbanipal import router, Config
    from ashurbanipal.db.postgres import PgSource

    config = Config(environment="dev", enabled_for=["dev"])  # raises for a
                                                                # production-like value
    source = PgSource(dsn=os.environ["DATABASE_URL"])
    app.register_blueprint(router(config, source))

Backend modules (`ashurbanipal.db.postgres`/`.sqlite`/`.mysql`) are not
imported here — each pulls in its own driver dependency (psycopg, stdlib
sqlite3, PyMySQL), so importing this package alone never requires all
three to be installed.
"""

from .config import Config, Limits, ProductionEnabledError, Sibling
from .db import DbSource
from .routes import router

__all__ = ["Config", "Limits", "Sibling", "ProductionEnabledError", "DbSource", "router"]

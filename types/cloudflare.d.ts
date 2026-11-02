declare namespace Cloudflare {
  interface Env {
    /** The database is available only after the hosting D1 binding is configured. */
    DB?: D1Database;
  }
}

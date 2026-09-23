/** Exercise the real pg parser so provider URLs cannot silently discard certificate verification. */
import { expect, test } from "bun:test";
import pg from "pg";
import { postgresConnection } from "../../src/infrastructure/postgres/connection.js";

test("provider CA survives native URL parsing and preserves credentials and ordinary parameters", () => {
  const url =
    "postgresql://user%40name:p%3Ass%40word@database.example:25060/defaultdb?sslmode=require&application_name=tarubot";
  const parsed = new pg.Client(postgresConnection(url, "provider-ca-fixture"));
  // pg's public declarations narrow this runtime property to boolean; inspect its actual TLS object.
  expect<unknown>(parsed.ssl).toEqual({ ca: "provider-ca-fixture", rejectUnauthorized: true });
  expect(parsed.user).toBe("user@name");
  expect(parsed.password).toBe("p:ss@word");
  expect(parsed.host).toBe("database.example");
  expect(parsed.port).toBe(25060);
  expect(parsed.database).toBe("defaultdb");
  expect<unknown>(Reflect.get(parsed, "connectionParameters")).toMatchObject({
    application_name: "tarubot",
  });
});

test("URL TLS switches cannot weaken an explicitly configured provider CA", () => {
  for (const query of [
    "sslmode=no-verify",
    "ssl=0",
    "sslmode=disable",
    "sslmode=require&uselibpqcompat=true",
    "sslnegotiation=direct",
    "sslrootcert=/unused-ca&sslcert=/unused-cert&sslkey=/unused-key",
  ]) {
    const parsed = new pg.Client(
      postgresConnection(
        `postgresql://user:fixture@database.example/db?${query}`,
        "provider-ca-fixture",
      ),
    );
    expect<unknown>(parsed.ssl).toEqual({ ca: "provider-ca-fixture", rejectUnauthorized: true });
  }
});

test("local connections retain their original driver options and malformed TLS URLs stay redacted", () => {
  const local = "postgresql://user:fixture@localhost/db?sslmode=disable";
  expect(postgresConnection(local)).toEqual({ connectionString: local });
  expect(new pg.Client(postgresConnection(local)).ssl).toBe(false);
  expect(postgresConnection(local, "")).toEqual({ connectionString: local });
  expect(() => postgresConnection("invalid-with-sensitive-fixture", "provider-ca-fixture")).toThrow(
    "DATABASE_URL must be a PostgreSQL URL",
  );
});

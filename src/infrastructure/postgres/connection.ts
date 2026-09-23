/** Portable provider TLS configuration, shared by the bot and every compiled maintenance tool. */
import type { PoolConfig } from "pg";
import { Failure } from "../../domain/values.js";

/** An explicit provider CA controls TLS; URL SSL flags must not replace it inside node-postgres. */
export function postgresConnection(
  url: string,
  ca?: string,
): Pick<PoolConfig, "connectionString" | "ssl"> {
  if (!ca) return { connectionString: url };
  let endpoint: URL;
  try {
    endpoint = new URL(url);
    if (!["postgres:", "postgresql:"].includes(endpoint.protocol)) throw new Error("protocol");
  } catch {
    // URL parser diagnostics can contain passwords; expose only the invalid setting name.
    throw new Failure(
      "configuration",
      "DATABASE_URL must be a PostgreSQL URL when DATABASE_CA_CERT is set.",
    );
  }
  for (const key of [
    "ssl",
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "sslnegotiation",
    "uselibpqcompat",
  ])
    endpoint.searchParams.delete(key);
  return { connectionString: endpoint.toString(), ssl: { ca, rejectUnauthorized: true } };
}

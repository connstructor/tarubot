# Compile and verify all first-party code plus discoverable modules using pinned Bun.
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
# The local dependency and parser bundle both use the initialized, parent-pinned submodule.
COPY vendor/nodestone ./vendor/nodestone
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build && bun run typecheck && bun run test:unit && bun run test:contract

# Keep source/build dependencies separate from the final runtime dependency tree.
FROM oven/bun:1.4.2 AS dependencies
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
# Bun resolves the local dev-package manifest even when installing only runtime dependencies.
COPY vendor/nodestone/package.json ./vendor/nodestone/package.json
RUN bun install --frozen-lockfile --production

# Both services execute compiled ESM as a non-root user.
FROM oven/bun:1.4.2 AS runtime
WORKDIR /app
COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun package.json ./
COPY --chown=bun:bun LICENSE ./LICENSE
LABEL org.opencontainers.image.licenses="AGPL-3.0-only"
USER bun
STOPSIGNAL SIGTERM

# The bundled worker contains the pinned parser source; it loads the live selector set (2.19.0),
# falling back to the bundled copy in dist/sidecar/selectors-baseline.json.
FROM runtime AS nodestone
EXPOSE 8080
CMD ["bun", "dist/sidecar/server.js"]

# The test harness injects the SQL fixture separately into an ephemeral container.
FROM build AS test
CMD ["bun", "test", "tests"]

# Preserve directory layout: discovery resolves compiled modules relative to import.meta.url.
FROM runtime AS tarubot
COPY --chown=bun:bun migrations ./migrations
COPY --chown=bun:bun test-plans ./test-plans
EXPOSE 3000
CMD ["bun", "dist/src/main.js"]

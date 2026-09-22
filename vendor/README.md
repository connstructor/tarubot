# Build-time upstream sources

`nodestone/` is the `xivapi/nodestone` Git submodule. Initialize it before installing dependencies or building:

```sh
git submodule update --init --recursive
```

The parent repository records the tested commit. `bun run nodestone:update` advances the checkout to upstream HEAD and verifies the parser contracts. Commit the new submodule pointer, lockfile, and revision metadata together. First-party compatibility transformations remain in `sidecar/transforms.ts`; the upstream checkout is kept clean.

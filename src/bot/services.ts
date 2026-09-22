/** Typed dependency injection for modules; the loader has no knowledge of game features. */

/** A capability name plus the runtime proof needed to retrieve its concrete type safely. */
export class ServiceKey<T> {
  constructor(
    readonly name: string,
    readonly accepts: (value: unknown) => value is T,
  ) {}
}

/** Stores providers by token identity and reports missing/mismatched services at startup. */
export class Services {
  private readonly values = new Map<ServiceKey<unknown>, unknown>();
  private readonly names = new Set<string>();

  /** Register each capability once; NoInfer prevents a wrong value from widening its token. */
  provide<T>(key: ServiceKey<T>, value: NoInfer<T>): this {
    if (this.names.has(key.name)) throw new Error(`Duplicate service: ${key.name}`);
    if (!key.accepts(value)) throw new Error(`Invalid provider for service: ${key.name}`);
    this.values.set(key, value);
    this.names.add(key.name);
    return this;
  }

  /** Runtime narrowing keeps module dependencies typed without unchecked casts. */
  get<T>(key: ServiceKey<T>): T {
    const value = this.values.get(key);
    if (!key.accepts(value)) throw new Error(`Missing or invalid service: ${key.name}`);
    return value;
  }

  /** Validate declared dependencies before any gateway connection accepts work. */
  require(keys: readonly ServiceKey<unknown>[]): void {
    for (const key of keys) this.get(key);
  }
}

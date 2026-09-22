/** The source dependency is compiled separately; only this validated request bridge crosses it. */
declare module "nodestone-upstream" {
  interface RequestBridge {
    /** The source parser reads these fields only; this is not an Express request implementation. */
    params: Record<string, string>;
    query: Record<string, string>;
  }
  class Parser {
    /** Consumers must validate the dependency's result before it becomes an application fact. */
    parse(request: RequestBridge): Promise<unknown>;
  }
  export class Character extends Parser {}
  export class CharacterSearch extends Parser {}
  export class FreeCompany extends Parser {}
  export class FCMembers extends Parser {}
}

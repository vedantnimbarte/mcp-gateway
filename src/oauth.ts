import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

export const TOKENFILE = "tokens.json";

/**
 * The redirect URI is registered with the authorization server on first use, so it has to be
 * the same string on every later run — which rules out an ephemeral port.
 *
 * ponytail: fixed port, no config knob. Add one when the port actually collides with something.
 */
export const CALLBACK_PORT = 8419;
export const CALLBACK_PATH = "/callback";
export const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;

interface Entry {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
  state?: string;
}

interface StoreFile {
  version: 1;
  servers: Record<string, Entry>;
}

/**
 * Refresh tokens for `auth: oauth` backends, beside the config in `tokens.json`.
 *
 * NFR-3 keeps credentials out of `config.yaml` and takes them from the environment. Tokens are
 * different in kind: they are issued at runtime and must survive a restart or every daemon boot
 * would need a browser. They live in their own gitignored file, 0600, and never in the config.
 */
export class TokenStore {
  #file: StoreFile = { version: 1, servers: {} };

  constructor(readonly path: string) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as StoreFile;
      if (parsed.version === 1 && parsed.servers) this.#file = parsed;
    } catch {
      // No tokens yet, or an unreadable file: treat as empty and let `mcpgw auth` rebuild it.
    }
  }

  static pathFor(configPath: string): string {
    return join(dirname(configPath), TOKENFILE);
  }

  get(server: string): Entry {
    return this.#file.servers[server] ?? {};
  }

  set(server: string, patch: Entry): void {
    this.#file.servers[server] = { ...this.get(server), ...patch };
    this.#save();
  }

  clear(server: string, scope: "all" | "client" | "tokens" | "verifier"): void {
    const entry = this.get(server);
    if (scope === "all") delete this.#file.servers[server];
    else if (scope === "client") this.#file.servers[server] = { ...entry, client: undefined };
    else if (scope === "tokens") this.#file.servers[server] = { ...entry, tokens: undefined };
    else this.#file.servers[server] = { ...entry, verifier: undefined };
    this.#save();
  }

  #save(): void {
    writeFileSync(this.path, `${JSON.stringify(this.#file, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Windows has no POSIX mode bits; the file inherits the directory's ACL.
    }
  }
}

/** Thrown when a backend needs a browser and there is nobody at the keyboard. */
export class NeedsAuthorization extends Error {
  constructor(readonly server: string) {
    super(`backend "${server}" needs authorization: run \`mcpgw auth ${server}\``);
    this.name = "NeedsAuthorization";
  }
}

/**
 * One backend's OAuth identity. The SDK drives discovery, PKCE, registration, the token
 * exchange and refresh; this only decides where the pieces are kept and what happens when a
 * browser is required (ARCHITECTURE §7 — the SDK is the protocol, we are the plumbing).
 */
export class BackendAuth implements OAuthClientProvider {
  constructor(
    private readonly server: string,
    private readonly store: TokenStore,
    private readonly opts: {
      scope?: string;
      clientId?: string;
      clientSecret?: string;
      onRedirect?: (url: URL) => void;
    } = {},
  ) {}

  get redirectUrl(): string {
    return REDIRECT_URI;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `mcp-gateway (${this.server})`,
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.opts.clientSecret ? "client_secret_post" : "none",
      ...(this.opts.scope ? { scope: this.opts.scope } : {}),
    };
  }

  /** Random per attempt, and checked on the callback: the redirect is the CSRF boundary. */
  state(): string {
    const state = randomBytes(16).toString("hex");
    this.store.set(this.server, { state });
    return state;
  }

  /** Constant-time, since this is what stops a forged callback from being accepted. */
  matchesState(given: string | null): boolean {
    const expected = this.store.get(this.server).state;
    if (!expected || !given) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * A configured client wins, and its presence is what stops the SDK attempting dynamic
   * registration — which plenty of commercial servers advertise and then refuse.
   */
  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.opts.clientId) {
      return {
        client_id: this.opts.clientId,
        ...(this.opts.clientSecret ? { client_secret: this.opts.clientSecret } : {}),
      };
    }
    return this.store.get(this.server).client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    // Nothing to remember when the client was configured by hand.
    if (!this.opts.clientId) this.store.set(this.server, { client });
  }

  tokens(): OAuthTokens | undefined {
    return this.store.get(this.server).tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.store.set(this.server, { tokens });
  }

  saveCodeVerifier(verifier: string): void {
    this.store.set(this.server, { verifier });
  }

  codeVerifier(): string {
    const verifier = this.store.get(this.server).verifier;
    if (!verifier) throw new NeedsAuthorization(this.server);
    return verifier;
  }

  /**
   * The daemon has no browser and no user, so it refuses rather than stalling: the backend is
   * marked DOWN with an instruction. `mcpgw auth` supplies `onRedirect` and does the flow.
   */
  redirectToAuthorization(url: URL): void {
    if (!this.opts.onRedirect) throw new NeedsAuthorization(this.server);
    this.opts.onRedirect(url);
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "discovery") return;
    this.store.clear(this.server, scope);
  }
}

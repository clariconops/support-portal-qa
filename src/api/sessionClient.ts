import type { FrameworkEnv } from "../config/env.js";
import { ApiClient, serviceClient } from "./http.js";

export interface LoginResult {
  token: string;
  user: Record<string, unknown>;
}

/**
 * Wraps the session-service auth API. Real login (not token injection) so the
 * framework exercises the same path a browser does.
 */
export class SessionClient {
  private readonly api: ApiClient;
  private token?: string;

  constructor(private readonly env: FrameworkEnv) {
    this.api = serviceClient(env, "SESSION", () => this.token);
  }

  getToken(): string | undefined {
    return this.token;
  }

  private lastCredentials?: string;
  private cachedUser?: Record<string, unknown>;

  /**
   * Login and store the bearer token for subsequent calls. Reuses the token
   * for identical credentials — the backend rate-limits login attempts, so a
   * run must log in once, not once per behaviour.
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const credentials = `${email}|${password}`;
    if (this.token && this.lastCredentials === credentials) {
      return { token: this.token, user: this.cachedUser ?? {} };
    }
    // The login API validates a non-empty deviceId (any string) in the body.
    const deviceId = process.env.QA_DEVICE_ID ?? "qa-framework";
    const res = await this.api.post("/api/sessions/login", { email, password, deviceId });
    if (res.status >= 400) {
      throw new Error(`login failed (${res.status}): ${JSON.stringify(res.data)}`);
    }
    const data = ApiClient.unwrap<{
      user: Record<string, unknown>;
      tokens?: { accessToken?: string };
      accessToken?: string;
      token?: string;
    }>(res);
    const token = data.tokens?.accessToken ?? data.accessToken ?? data.token;
    if (!token) throw new Error("login succeeded but no token in response");
    this.token = token;
    this.lastCredentials = credentials;
    this.cachedUser = data.user;
    return { token, user: data.user };
  }

  async loginAs(role: "admin" | "agent" | "limited"): Promise<LoginResult> {
    const a = this.env.auth;
    switch (role) {
      case "admin":
        return this.login(a.adminEmail, a.adminPassword);
      case "agent":
        return this.login(a.agentEmail, a.agentPassword);
      case "limited":
        return this.login(a.limitedEmail, a.limitedPassword);
    }
  }

  async me(): Promise<Record<string, unknown>> {
    const res = await this.api.get("/api/sessions/me");
    return ApiClient.unwrap(res);
  }

  async logout(): Promise<void> {
    await this.api.post("/api/sessions/logout");
    this.token = undefined;
    this.lastCredentials = undefined;
    this.cachedUser = undefined;
  }
}
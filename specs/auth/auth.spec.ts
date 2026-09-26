import { defineFeature } from "../../src/orchestrator/suite.js";
import { assert, assertEquals } from "../../src/orchestrator/context.js";

/**
 * API behaviours for the `auth` feature. Each `suite.behaviour(id, fn)` id must
 * match a behaviour declared in `features/auth.feature.yaml`.
 */
const suite = defineFeature("auth", (s) => {
  // "logs in as admin with valid credentials"
  s.behaviour("auth.login.admin", async (ctx) => {
    const { adminEmail, adminPassword } = ctx.env.auth;
    const result = await ctx.session.login(adminEmail, adminPassword);
    assert(result.token, "expected a token from login");
    assert(result.user, "expected a user object from login");
  });

  // "rejects invalid credentials"
  s.behaviour("auth.login.invalid", async (ctx) => {
    let threw = false;
    try {
      await ctx.session.login("nobody@e2e.test", "wrong-password");
    } catch {
      threw = true;
    }
    assert(threw, "expected invalid credentials to be rejected");
  });

  // "returns current user profile"
  s.behaviour("auth.me.authenticated", async (ctx) => {
    await ctx.session.loginAs("admin");
    const me = await ctx.session.me();
    assert(me && typeof me === "object", "expected a user profile object");
  });

  // "logs out and clears the token"
  s.behaviour("auth.logout", async (ctx) => {
    await ctx.session.loginAs("admin");
    assert(ctx.session.getToken(), "expected an active token before logout");
    await ctx.session.logout();
    assertEquals(ctx.session.getToken(), undefined, "token should be cleared after logout");
  });
});

export default suite;
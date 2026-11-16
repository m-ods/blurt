// Sign in with AssemblyAI, or a pasted API key: a port of the Android app's
// Account.kt and OAuth.kt (themselves ports of Sources/AssemblyAI/OAuth and the
// engine's AssemblyAIAccount), whose comments say why each step is shaped the
// way it is.
//
// Authorization code with PKCE on the dashboard's consent page, opened through
// identity.launchWebAuthFlow; the access token is then traded for the
// connection's own API key, which is what the LLM Gateway call uses. The key
// sits in storage.local exactly where a pasted key goes, so the gateway call
// reads one place. Signing in adds renewal and a sign-out that ends the
// connection server-side.
//
// Loaded by the background script (renewal, sign-out, the key for a fill) and
// the settings page (sign-in, which has to outlive a service worker's idle
// timeout while the person is on the consent page).

/* global BLURT_FORMS_CONFIG */
/* exported Auth */

const Auth = (() => {
  const ext = globalThis.browser ?? globalThis.chrome;
  const config = BLURT_FORMS_CONFIG.oauth ?? {};

  // `aai:api` is what the key exchange checks for; `offline_access` buys the refresh token.
  const SCOPES = "openid email offline_access aai:api";
  const DAY = 24 * 60 * 60 * 1000;
  const EXPIRY_MARGIN = 2 * DAY; // renew this long before expiry when no rotation time is given
  const UNKNOWN_EXPIRY = DAY; // neither expiry nor rotation: renew daily
  const REJECTED_KEY_SPACING = 15 * 60 * 1000; // a refused key renews at once, at most this often

  const available =
    Boolean(config.clientId) &&
    [config.authorizeUrl, config.tokenUrl, config.apiOrigin].every((url) => typeof url === "string" && url.startsWith("https://"));

  const apiKeyUrl = available ? config.apiOrigin.replace(/\/+$/, "") + "/api/v2/oauth/api-key" : null;
  const revokeUrl = available ? apiKeyUrl + "/revoke" : null;

  /** The redirect this browser intercepts; the Connected App must list it. */
  const redirectUri = () => ext.identity.getRedirectURL("oauth");

  class AuthError extends Error {
    /** kind: "cancelled" | "consent" | "rejected" | "forbidden" | "unreachable" | "unavailable" */
    constructor(kind, message) {
      super(message ?? MESSAGES[kind] ?? MESSAGES.unreachable);
      this.kind = kind;
    }
  }

  // The Mac's wording (SignInFailure.message), with "browser" for "Mac".
  const MESSAGES = {
    unavailable: "Signing in isn't set up in this build of Blurt Forms. Paste an API key instead.",
    consent: "AssemblyAI didn't complete the sign-in. Try again.",
    rejected: "AssemblyAI didn't complete the sign-in. Try again.",
    forbidden: "AssemblyAI didn't allow Blurt to use your account. Ask an admin of your organization.",
    unreachable: "Couldn't reach AssemblyAI. Check your connection and try again.",
    signOutUnconfirmed:
      "AssemblyAI couldn't confirm the sign-out, so Blurt Forms is still connected. Check your connection and try again.",
  };

  // --- storage ---------------------------------------------------------------

  async function load() {
    const { apiKey = null, session = null } = await ext.storage.local.get(["apiKey", "session"]);
    return { apiKey, session };
  }

  const save = (values) => ext.storage.local.set(values);

  async function forget() {
    await ext.storage.local.remove(["apiKey", "session"]);
  }

  function renewalDue(session) {
    if (session.keyRotatesAt) return Date.parse(session.keyRotatesAt);
    if (session.keyExpiresAt) return Date.parse(session.keyExpiresAt) - EXPIRY_MARGIN;
    return Date.parse(session.renewedAt) + UNKNOWN_EXPIRY;
  }

  // --- PKCE ------------------------------------------------------------------

  function base64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  const randomString = (count) => base64Url(crypto.getRandomValues(new Uint8Array(count)));

  async function challenge(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return base64Url(new Uint8Array(digest));
  }

  // --- wire ------------------------------------------------------------------

  async function post(url, { bearer, form } = {}) {
    const headers = { Accept: "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    let body = "";
    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(form).toString();
    }
    let response;
    try {
      response = await fetch(url, { method: "POST", headers, body });
    } catch {
      throw new AuthError("unreachable");
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Left null: a non-JSON body says nothing about the credential.
    }
    return { status: response.status, json };
  }

  /** Logs a refused call's path, status and the server's own reason — never a token. */
  function refusal(url, status, json, error) {
    const reason = ["error", "error_description", "detail"]
      .filter((key) => json?.[key])
      .map((key) => `${key}=${json[key]}`)
      .join(" ");
    console.warn(`[Blurt Forms] ${new URL(url).pathname} -> ${status}: ${reason || "-"}`);
    return error;
  }

  function email(idToken) {
    try {
      const payload = idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      return JSON.parse(atob(payload)).email || null;
    } catch {
      return null; // only labels the account row, so it's read without verifying
    }
  }

  async function tokenRequest(form) {
    const { status, json } = await post(config.tokenUrl, { form });
    if (status >= 200 && status < 300 && json?.access_token) {
      return {
        accessToken: json.access_token,
        refreshToken: json.refresh_token || null,
        email: json.id_token ? email(json.id_token) : null,
      };
    }
    // RFC 6749 §5.2: a refused grant is a 400 or 401. Anything else says nothing about the credential.
    const kind = status === 400 || status === 401 ? "rejected" : "unreachable";
    throw refusal(config.tokenUrl, status, json, new AuthError(kind));
  }

  const refresh = (refreshToken) =>
    tokenRequest({ grant_type: "refresh_token", client_id: config.clientId, refresh_token: refreshToken });

  async function exchangeForKey(accessToken) {
    const { status, json } = await post(apiKeyUrl, { bearer: accessToken });
    if (status >= 200 && status < 300 && json?.api_key) {
      return {
        apiKey: json.api_key,
        keyExpiresAt: json.api_key_expires_at || null,
        keyRotatesAt: json.api_key_rotates_at || null,
      };
    }
    if (status === 401) throw refusal(apiKeyUrl, status, json, new AuthError("rejected"));
    if (status === 403) {
      const reason = json?.error_description || json?.detail;
      const message = reason ? `AssemblyAI didn't allow it: ${reason}` : undefined;
      throw refusal(apiKeyUrl, status, json, new AuthError("forbidden", message));
    }
    throw refusal(apiKeyUrl, status, json, new AuthError("unreachable"));
  }

  // --- public ----------------------------------------------------------------

  async function status() {
    const { apiKey, session } = await load();
    if (session) return { state: "signedIn", email: session.email };
    if (apiKey) return { state: "pastedKey" };
    return { state: "signedOut" };
  }

  /**
   * Runs the consent page and stores the minted key. Nothing is stored unless
   * every step succeeds, so a failed attempt leaves a pasted key (or nothing)
   * as it was.
   */
  async function signIn() {
    if (!available) throw new AuthError("unavailable");
    const verifier = randomString(32); // → 43 characters, the shortest RFC 7636 allows
    const state = randomString(16);
    const url = new URL(config.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: SCOPES,
      state,
      code_challenge: await challenge(verifier),
      code_challenge_method: "S256",
    }).toString();

    let callback;
    try {
      callback = new URL(await ext.identity.launchWebAuthFlow({ url: url.toString(), interactive: true }));
    } catch {
      // Closing the window and a refused redirect both land here; neither is worth an alarm.
      throw new AuthError("cancelled");
    }
    const params = callback.searchParams;
    // `state` first: an error redirect that isn't ours says nothing about this attempt.
    if (params.get("state") !== state) throw new AuthError("consent");
    const error = params.get("error");
    if (error === "access_denied") throw new AuthError("cancelled");
    if (error || !params.get("code")) {
      console.warn(`[Blurt Forms] sign-in callback refused: ${error ?? "no code"}`);
      throw new AuthError("consent");
    }

    const tokens = await tokenRequest({
      grant_type: "authorization_code",
      client_id: config.clientId,
      code: params.get("code"),
      code_verifier: verifier,
      redirect_uri: redirectUri(),
    });
    if (!tokens.refreshToken) {
      console.warn("[Blurt Forms] token response carried no refresh token (offline_access not granted?)");
      throw new AuthError("unreachable");
    }
    const key = await exchangeForKey(tokens.accessToken);
    await save({
      apiKey: key.apiKey,
      session: {
        refreshToken: tokens.refreshToken,
        email: tokens.email,
        keyExpiresAt: key.keyExpiresAt,
        keyRotatesAt: key.keyRotatesAt,
        renewedAt: new Date().toISOString(),
      },
    });
    return status();
  }

  let renewal = null; // one renewal at a time within a context
  let lastForcedRenewal = 0;

  /**
   * Renews when the key is due (or missing), or at once when `force`. A no-op
   * for a pasted key. The settings page can sign in or out while a renewal is
   * on the network, so a renewal that comes back to a different refresh token
   * than it started from writes nothing — the cross-context form of Android's
   * generation counter.
   */
  function renew(force = false) {
    renewal ??= renewLocked(force).finally(() => (renewal = null));
    return renewal;
  }

  async function renewLocked(force) {
    if (!available) return;
    let { apiKey, session } = await load();
    if (!session) return;
    if (!force && apiKey && Date.now() < renewalDue(session)) return;
    const started = session.refreshToken;
    const stillOurs = async () => (await load()).session?.refreshToken === started;
    try {
      const tokens = await refresh(session.refreshToken);
      if (!(await stillOurs())) return;
      // Keep a rotated refresh token before anything else can fail: the old one is already dead.
      session = { ...session, refreshToken: tokens.refreshToken ?? session.refreshToken, email: tokens.email ?? session.email };
      await save({ session });
      const key = await exchangeForKey(tokens.accessToken);
      if ((await load()).session?.refreshToken !== session.refreshToken) return;
      const now = new Date();
      session = { ...session, keyExpiresAt: key.keyExpiresAt, keyRotatesAt: key.keyRotatesAt, renewedAt: now.toISOString() };
      // A key still due right after renewing would renew on every fill; push the next one out.
      if (renewalDue(session) <= now.getTime()) {
        const expiry = key.keyExpiresAt && Date.parse(key.keyExpiresAt) > now.getTime() ? key.keyExpiresAt : null;
        session.keyRotatesAt = expiry ?? new Date(now.getTime() + UNKNOWN_EXPIRY).toISOString();
      }
      await save({ apiKey: key.apiKey, session });
    } catch (error) {
      // Offline or the server failed: change nothing, the next fill tries again.
      if (error.kind === "unreachable") return;
      // Refused: the connection is over (revoked from the dashboard, the member removed, the refresh token lapsed).
      if (await stillOurs()) await forget();
    }
  }

  /** The key a fill should use, renewed first when due. Null when there is none. */
  async function apiKey() {
    await renew(false);
    return (await load()).apiKey;
  }

  /**
   * The gateway refused the stored key. Renews at once rather than when due, at
   * most once per REJECTED_KEY_SPACING; returns whether there may now be a new key.
   */
  async function keyWasRejected() {
    const { session } = await load();
    if (!session || Date.now() - lastForcedRenewal < REJECTED_KEY_SPACING) return false;
    lastForcedRenewal = Date.now();
    await renew(true);
    return Boolean((await load()).apiKey);
  }

  async function savePastedKey(key) {
    // A pasted key replaces a sign-in, so that session is ended rather than orphaned.
    if ((await load()).session) {
      const message = await signOut();
      if (message) throw new AuthError("unreachable", message);
    }
    await save({ apiKey: key.trim() });
  }

  /**
   * Ends the connection server-side, then forgets it here. Returns the message
   * to show, with everything left in place, when the server couldn't confirm.
   * A refresh token the server already refuses counts as signed out. Null on success.
   */
  async function signOut() {
    if (renewal) await renewal.catch(() => {}); // it may have rotated the refresh token
    const { session } = await load();
    if (!session || !available) {
      await forget();
      return null;
    }
    try {
      const tokens = await refresh(session.refreshToken);
      const { status: code, json } = await post(revokeUrl, { bearer: tokens.accessToken });
      // 503 is the server saying the grant revoke failed: the grant is still
      // live, so this must not look like a sign-out.
      if (code === 401) throw new AuthError("rejected");
      if (code < 200 || code >= 300) throw refusal(revokeUrl, code, json, new AuthError("unreachable"));
    } catch (error) {
      if (error.kind !== "rejected") return MESSAGES.signOutUnconfirmed;
      // Rejected: nothing left server-side to end.
    }
    await forget();
    return null;
  }

  return { available, redirectUri, status, signIn, signOut, savePastedKey, apiKey, keyWasRejected, AuthError };
})();

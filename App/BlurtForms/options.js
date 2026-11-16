// The settings page: sign in (run here, not in the background, so the consent
// page can take as long as it likes without a service worker idling out
// under it), paste a key, pick the model, grant Firefox's site access.

/* global Auth, BLURT_FORMS_CONFIG */

const ext = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const ORIGINS = ["https://docs.google.com/forms/*", "https://*.assemblyai.com/*"];

function showError(message) {
  $("account-error").textContent = message ?? "";
  $("account-error").hidden = !message;
}

async function render() {
  const status = await Auth.status();
  const signedIn = status.state === "signedIn";
  $("account-status").textContent = signedIn
    ? `Signed in${status.email ? ` as ${status.email}` : ""}.`
    : status.state === "pastedKey"
      ? "Using a pasted API key."
      : "Not signed in.";
  $("sign-in").hidden = signedIn || !Auth.available;
  $("key-row").hidden = signedIn;
  $("signed-in-actions").hidden = !signedIn && status.state !== "pastedKey";
  $("sign-out").textContent = signedIn ? "Sign out" : "Remove key";
  $("redirect-section").hidden = !Auth.available;
  $("redirect").textContent = Auth.redirectUri();

  const { model = "" } = await ext.storage.local.get("model");
  $("model").value = model;
  $("model").placeholder = BLURT_FORMS_CONFIG.model;

  // Firefox grants MV3 host permissions only when asked; Chromium grants them at install.
  $("access").hidden = await ext.permissions.contains({ origins: ORIGINS });
}

async function busy(button, work) {
  button.disabled = true;
  showError(null);
  try {
    await work();
  } catch (error) {
    if (error?.kind !== "cancelled") showError(error?.message ?? String(error));
  } finally {
    button.disabled = false;
    await render();
  }
}

$("sign-in").addEventListener("click", (event) => busy(event.currentTarget, () => Auth.signIn()));

$("save-key").addEventListener("click", (event) =>
  busy(event.currentTarget, async () => {
    const key = $("api-key").value.trim();
    if (!key) throw new Error("Paste a key first.");
    await Auth.savePastedKey(key);
    $("api-key").value = "";
  }),
);

$("sign-out").addEventListener("click", (event) =>
  busy(event.currentTarget, async () => {
    // Through the background, so it waits out a renewal that may be rotating the refresh token there.
    const { error } = await ext.runtime.sendMessage({ type: "blurt-forms:sign-out" });
    if (error) throw new Error(error);
  }),
);

$("save-model").addEventListener("click", (event) =>
  busy(event.currentTarget, async () => {
    const model = $("model").value.trim();
    if (model) await ext.storage.local.set({ model });
    else await ext.storage.local.remove("model");
  }),
);

$("grant").addEventListener("click", (event) =>
  busy(event.currentTarget, async () => {
    // Must run straight from the click: permissions.request needs the user gesture.
    await ext.permissions.request({ origins: ORIGINS });
  }),
);

ext.storage.onChanged.addListener(render);
render();

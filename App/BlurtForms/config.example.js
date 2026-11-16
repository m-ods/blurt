// Copy to config.js (gitignored) before loading the extension.
//
// The oauth values are the Mac's SignIn.local.xcconfig values (and Android's
// blurt.oauth.* in local.properties). Leave any of them empty, or not https,
// and the settings page offers only the paste-an-API-key path.
globalThis.BLURT_FORMS_CONFIG = {
  oauth: {
    clientId: "",
    authorizeUrl: "", // https://…/dashboard/oauth/authorize
    tokenUrl: "", // https://…/v1/oauth2/token
    apiOrigin: "", // serves /api/v2/oauth/api-key[/revoke]
  },

  // The LLM Gateway a key is good for. A sandbox sign-in mints sandbox keys,
  // so point this at the sandbox's gateway when signing in against one.
  gatewayOrigin: "https://llm-gateway.assemblyai.com",

  // Forms are short and a person is waiting, but the mapping (dates, matching
  // choices, splitting one breath into several answers) wants a capable model.
  // Both IDs are from the gateway's docs; the settings page can override the first.
  model: "claude-sonnet-4-6",
  fallbackModel: "gemini-2.5-flash-lite",
};

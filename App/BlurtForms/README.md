# Blurt Forms

A browser extension for Brave and Firefox that fills a Google Form from one Blurt. Open the form,
Blurt "my name's Jane Doe, born March 3rd 1990, three fun facts: I've climbed Kilimanjaro, I
juggle, and I've read every Discworld book", and the name, birthday and fun-facts fields fill
themselves. You check them and press Submit; the extension never submits.

A prototype, like `App/BlurtAndroid`: not built or checked by CI, and `check.sh` doesn't lint
JavaScript.

## How it works

Blurt is unchanged. It pastes the transcript into whatever has focus, so the extension gives it a
place to paste:

1. **The panel.** On a `docs.google.com/forms/…/viewform` page the content script (`content.js`)
   adds a small "Blurt out your form" panel in the corner and focuses its box.
2. **Blurt.** Dictate as usual. Blurt pastes the polished transcript into the box, and the paste
   starts a fill, with no button to press. (Typed text works too: Return fills, Shift+Return adds
   a line.)
3. **Read the form.** The content script reads the questions on the current page from their ARIA
   roles (`listitem`, `heading`, `radio`, `checkbox`, `listbox`) and data attributes. Google
   Forms' class names are obfuscated and change, but these are what screen readers and the
   submission rely on. Each question goes out with its type, options, and the value already in
   it, so a second Blurt ("actually, my birthday's the 4th") corrects the first.
4. **Map.** The background script (`background.js`) sends the questions and the transcript to the
   LLM Gateway (`/v1/chat/completions`) with a strict JSON schema (`response_format`), and gets
   back one answer per question the person addressed. Questions they didn't address are left out,
   never guessed.
5. **Fill.** The content script sets each field the way typing does (the prototype's `value`
   setter plus `input`/`change` events), and clicks radios, checkboxes and dropdown options.
   Filled questions get a blue outline, and ones it couldn't fill get a dashed amber one. The
   panel lists what it skipped, required questions first.

The gateway call is made from the background script, not the page. A content script's `fetch` is
held to the Google Forms page's CORS policy, while the background has the gateway as a host
permission. The API key also never enters the page's process.

### Question types

| Type                                        | Filled as                                                             |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Short answer, paragraph, email, URL, number | text; a list question ("three fun facts") gets one numbered line each |
| Multiple choice, linear scale, dropdown     | the matching option; "Other:" with the person's words                 |
| Checkboxes                                  | every matching option (the answer replaces the selection)             |
| Multiple-choice and checkbox grids          | per row                                                               |
| Date, time                                  | `YYYY-MM-DD` / `HH:MM`, relative dates resolved against today         |
| File upload                                 | not filled: browsers don't let a script choose a file                 |

Multi-page forms fill one page per Blurt: press Next, then Blurt the next page.

## Install

```sh
cp config.example.js config.js   # config.js is gitignored; fill in sign-in values if you have them
```

- **Brave** (or any Chromium browser): `brave://extensions` → **Developer mode** → **Load
  unpacked** → this directory. The manifest's `key` pins the extension ID to
  `aailcjngojmlhnhcpnkgfnagadbmfkmk` wherever it's loaded from, so the sign-in redirect stays the
  same.
- **Firefox**: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → `manifest.json`.
  Temporary add-ons last until Firefox restarts; for a permanent install, sign it as an unlisted
  add-on on addons.mozilla.org (`web-ext sign`). Firefox grants Manifest V3 site access only when
  asked, so open the settings page and press **Allow access** once.

The toolbar button opens the settings page.

## Sign in with AssemblyAI

The same sign-in as the Mac and Android apps (`Sources/AssemblyAI/OAuth`, `App/BlurtAndroid`'s
`OAuth.kt`): authorization code with PKCE on the dashboard's consent page, then the access token is
traded at `/api/v2/oauth/api-key` for the connection's own API key, which is what the gateway call
uses. `auth.js` ports `Account.kt`: renewal when the key is due (checked before each fill), an
immediate renewal when the gateway refuses the key, and a sign-out that revokes server-side.

It's off unless `config.js` has the `oauth` values, which are the Mac's `SignIn.local.xcconfig`
values. Without them, the settings page offers only the paste-a-key field. A sandbox sign-in mints
sandbox keys, so also set `gatewayOrigin` to that sandbox's gateway.

**The Connected App must list each browser's redirect.** The apps' `com.assemblyai.blurt://` scheme
can't be used here: `identity.launchWebAuthFlow` only catches its own https redirect.

| Browser | Redirect URI                                                                        |
| ------- | ----------------------------------------------------------------------------------- |
| Brave   | `https://aailcjngojmlhnhcpnkgfnagadbmfkmk.chromiumapp.org/oauth`                    |
| Firefox | derived from the add-on ID `blurt-forms@assemblyai.com`; the settings page shows it |

The settings page prints the exact URI for whichever browser it's open in.

The token and key-exchange calls are made from extension pages, which skip CORS for hosts in
`host_permissions` (`https://*.assemblyai.com/*`). If the token endpoint lives on another host, add
that host there too.

The key and refresh token live in `storage.local`, unencrypted. That's the extension platform's
only store, and readable by anyone with access to the browser profile.

## Privacy

A fill sends the current page's question titles, descriptions, options and current values, along
with the transcript, to AssemblyAI's LLM Gateway, using the model on the settings page (default
`claude-sonnet-4-6`, falling back to `gemini-2.5-flash-lite`). Nothing else from the page is sent,
and nothing is sent until there's a transcript to fill from. The form's own text goes to the model
as data. The instruction tells it to ignore anything in the form that reads like a command, and
the extension can do nothing but fill fields on that page.

## Settled decisions

This doesn't touch Blurt's [settled decisions](../../AGENTS.md#settled-decisions--dont-reintroduce-these):
the dictation request, its cleanup and its context are exactly as they were. The gateway call here
maps a finished transcript onto a form. It isn't a cleanup pass on dictation, and it lives outside
the Mac app. Building form-filling into Blurt itself (detecting the form, calling the gateway from
the app) would need an explicit exception to the one-gateway-client rule, as read-aloud has.

## Design

The panel and the settings page follow the iPhone app's brand (`App/BlurtiOS/DESIGN.md`):
warm paper in the light and ink under film grain in the dark, a serif headline, uppercase mono
eyebrows and buttons, and Blurt green as the one accent, with the brand's rectangular corners
(4 for buttons, 8 for inputs, 12 for cards). The faces are the system's serif, monospaced and
default designs, because Blurt bundles no brand fonts. `brand.css` holds the values, copied from
`App/BlurtiOS/Design/tokens.json` and annotated with each token's name; keep the two in step. The
panel loads `brand.css` into its shadow root, so Google's styles can't reach it and its own can't
leak onto the form. The page follows the system appearance. The marks on the form itself always
use the light face's green and orange, because Google's form stays light.

`icons/` holds the toolbar icons, cut from `Design/brand/AppIcon.icon`, and a copy of
`Design/brand/blurt-ready-logo.png`, which is drawn as a mask and tinted with the accent.

## Files

| File                  | What it does                                                                         |
| --------------------- | ------------------------------------------------------------------------------------ |
| `manifest.json`       | Manifest V3 for both browsers (`service_worker` for Chromium, `scripts` for Firefox) |
| `config.example.js`   | sign-in values, gateway origin, default model; copy to `config.js`                   |
| `auth.js`             | Sign in with AssemblyAI and the pasted-key path, shared by background and settings   |
| `background.js`       | the LLM Gateway call: instruction, JSON schema, the renewal-and-retry on a 401       |
| `content.js`          | the panel, reading the form, filling it                                              |
| `options.html`, `.js` | the settings page                                                                    |
| `brand.css`           | Blurt's tokens and roles (eyebrow, heading, card, button, input, grain)              |
| `icons/`              | toolbar icons and the wordmark                                                       |

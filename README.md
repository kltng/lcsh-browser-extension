# LCSH Recommendation Tool

A Chrome extension that helps catalogers find Library of Congress Subject
Headings. You describe a work; the extension asks an AI model for candidate
headings, **looks every one of them up at the Library of Congress**, and only
then shows you what exists — with its real LC identifier, its link, and a MARC
field built from the authority record.

The AI is never the source of a heading, an identifier or a MARC field. If the
model invents something, you see it listed as "not found", not as a result.

## What it does

1. **Describe the work** — title, author, abstract, contents, notes, and
   optionally pictures of the cover or title page.
2. **Suggestions** — the model you chose proposes headings.
3. **Matches** — each suggestion is searched at `id.loc.gov` (or in the
   offline database, if you installed one). Failures are shown as failures.
4. **Recommendations** — you or the model pick among the real candidates. Each
   gets a MARC field derived from the authority record, or a plain reason why
   no field could be made.
5. **History** — saved locally, with the provider and model that produced it.

## Choose your AI provider

OpenAI, Google Gemini, Anthropic Claude, DeepSeek, Qwen, Zhipu GLM, Moonshot
Kimi, MiniMax, OpenRouter, LM Studio (your own machine), any
OpenAI-compatible endpoint, and **Gemini Nano**, which runs inside Chrome so
your text never leaves the device.

For Qwen, Zhipu, Moonshot and MiniMax you pick the international or the China
region yourself.

Your API key is stored by Chrome on your computer, is sent only to the
provider it belongs to, and never appears in a web address, in your history or
in exported files.

## Offline database (optional)

Instead of searching `id.loc.gov` over the network, you can install a SQLite
database of the authorities, published from Library of Congress bulk files by
the companion project `lcsh-db-builder`:

| Profile | Contents | Download | On disk |
|---|---|---|---|
| **core** (default) | subjects (LCSH) + genre/form (LCGFT) | about 62 MB | about 205 MB |
| full (advanced) | also 12 million names (LCNAF) | about 1.9 GB | about 5.4 GB |

With **core**, name headings are still looked up online. The download is
verified by SHA-256 before it replaces anything, and the previous database is
kept until the new one is proven good.

## Install (development)

```bash
npm install          # Node 20+; installs the pinned SQLite wasm build too
npm run build        # writes dist/
npm test             # the full suite
```

Then open `chrome://extensions/`, turn on **Developer mode**, choose **Load
unpacked**, and select the `dist` directory.

The Chrome Web Store build will be published separately.

## Use

1. Click the toolbar icon, then **Open the tool**.
2. In **Settings**, choose a provider and paste its API key (or choose Gemini
   Nano, which needs no key). Use **Test connection** to check it.
3. Describe the work, then walk through the four steps.
4. Copy the headings, copy the MARC fields, or export a CSV.

## Privacy

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md). In short: no server, no analytics,
your text goes only to the provider you chose and the headings go only to the
Library of Congress.

## Project layout

```
src/services/providers/   the 12 providers behind one interface
src/services/pipeline/    suggest → look up → select → MARC → export
src/services/lookup/      the Library of Congress backend and the coordinator
src/services/localdb/     the optional offline database: download, verify, query
src/components/           the React UI
docs/                     the specifications each phase was built and reviewed against
```

## Licence

MIT. Library of Congress data is in the public domain in the United States.

# Privacy Policy — LCSH Recommendation Tool

Last updated: 27 September 2026

## In short

- Everything you type stays on your computer, except what is sent to the AI
  provider **you choose** and to the Library of Congress to look up headings.
- Your API keys are kept on your computer and are sent only to the provider
  they belong to.
- The extension has no server. It collects no analytics and no telemetry.
- If you choose the on-device model (Gemini Nano), your text is not sent
  anywhere at all for the suggestion step.

## What you give the extension

You may enter a title, an author, an abstract, a table of contents and notes,
and you may upload images such as a book cover or title page. You may also
edit the cataloguing rules the extension sends with your text.

## Where that information goes

### 1. The AI provider you choose

The extension supports these providers. It contacts **only** the one you
select, using the key you enter for it:

| Provider | Where the request goes |
|---|---|
| OpenAI | `api.openai.com` |
| Google Gemini | `generativelanguage.googleapis.com` |
| Anthropic Claude | `api.anthropic.com` |
| DeepSeek | `api.deepseek.com` |
| Qwen (Alibaba) | `dashscope-intl.aliyuncs.com` or `dashscope.aliyuncs.com` |
| Zhipu GLM | `api.z.ai` or `open.bigmodel.cn` |
| Moonshot Kimi | `api.moonshot.ai` or `api.moonshot.cn` |
| MiniMax | `api.minimax.io` or `api.minimax.cn` |
| OpenRouter | `openrouter.ai` |
| LM Studio | an address you enter, normally your own computer |
| Custom endpoint | an address you enter |
| **Gemini Nano** | **nowhere — it runs inside Chrome on your device** |

For the Chinese providers you choose the international or the China region
yourself; the extension never switches regions on its own.

What is sent: your bibliographic text, your uploaded images, and your
cataloguing rules. What is never sent: your API keys for any *other*
provider, your history, or anything about your browser.

Each provider handles your data under its own privacy policy and its own
data-retention rules. Please read the policy of the provider you use.

### 2. The Library of Congress

To check that a suggested heading really exists, the extension searches
`id.loc.gov`. Only the heading text is sent — for example
`Motion pictures--Japan--History`. Your abstract, notes and images are never
sent to the Library of Congress.

If you install the offline database (below) and choose the profile that does
not include names, name headings are still looked up at `id.loc.gov`. With
the full offline database, a chosen name's MARC field is fetched from
`id.loc.gov` as well.

### 3. Hugging Face (only if you install the offline database)

The offline database is optional. If you install it, the extension downloads
files from `huggingface.co` and its content delivery network. The download
does **not** include anything you typed: it is a plain file download.
Hugging Face and its network receive the ordinary technical details of any
download, such as your IP address.

## What is stored, and where

Everything is stored by Chrome on your computer:

- **API keys** — in the extension's local storage. They are sent only to the
  matching provider, always in a request header, never in a web address.
  They never appear in your history, in exported files or in error messages.
- **Your settings** — the provider and model you chose, your cataloguing
  rules, and which lookup source you use.
- **History** — the records you save, including the headings, their Library
  of Congress identifiers and the MARC fields. An uploaded picture itself is
  never saved; only its file name, type and size are kept. History holds at
  most 25 records, and at most 256 KiB per record.
- **The offline database**, if you install it. It contains only public
  Library of Congress data.

Nothing is uploaded to us, because there is no "us" to upload to: the
extension has no server component.

## Permissions the extension asks for

- **Storage** and **unlimited storage** — to keep the settings, history and
  the optional database on your computer.
- **Access to `id.loc.gov`** — to look up headings.
- **Access to a provider's address** — requested only when you choose that
  provider, and only for that one. If you decline, the extension keeps
  working with the providers you already allowed.

## Your choices

- Change or delete your API key at any time in Settings.
- Delete one history record, or clear the whole history, in the History tab.
- Remove the offline database in Settings.
- Uninstall the extension: Chrome deletes everything listed above.

## Children

The extension is a professional cataloguing tool and is not directed at
children.

## Changes

If this policy changes, the date at the top changes with it. The current
version is always in the extension's repository.

## Contact

Please open an issue in the extension's GitHub repository.

# Chrome Web Store listing — draft for the next release

You submit this; I cannot. The current listing says "using Gemini API", which
will be wrong once this branch ships.

## Name

LCSH Recommendation Tool

## Short description (132 characters max)

> Suggests Library of Congress Subject Headings, checks every one against the
> real authority file, and builds the MARC field.

(123 characters.)

## Detailed description

> **Subject headings you can trust, because the extension checks them.**
>
> Describe a work — title, author, abstract, contents, notes, even a photo of
> the title page — and the extension asks an AI model for candidate subject
> headings. It then looks every candidate up in the Library of Congress
> authority file and shows you only what actually exists, with its LC
> identifier, its link, and a MARC field built from the authority record.
>
> If the model invents a heading, you see it listed as "no match returned by
> this search". You never see an invented heading dressed up as a real one,
> and you never see a MARC field that the model wrote.
>
> **Use the AI you already pay for.** OpenAI, Google Gemini, Anthropic Claude,
> DeepSeek, Qwen, Zhipu GLM, Moonshot Kimi, MiniMax, OpenRouter, a model
> running in LM Studio on your own machine, or any OpenAI-compatible endpoint.
> Your key is stored on your computer and is used only to sign in to the
> server you entered it for.
>
> **Or keep the AI on your computer.** Chrome's built-in Gemini Nano runs
> on your device, so your text is not sent to an AI company. (The headings
> are still checked at the Library of Congress, or in the offline database
> if you install it.)
>
> **Work offline.** You can install a copy of the Library of Congress subject
> and genre authorities (about 62 MB) and search it locally instead of over
> the network. A larger edition adds 12 million name authorities.
>
> **Made for cataloguers.** Subdivisions are kept. Deprecated headings point
> at their replacements. You can override any choice by hand. Copy a single
> MARC field, copy them all, or export a CSV. Your recent work is saved on
> your computer, with the provider and model that produced it.
>
> No account, no server, no analytics. Free and open source (MIT).

## Category

Productivity

## Single purpose (required by the Store)

> The extension helps a cataloguer produce Library of Congress Subject
> Headings for one work at a time: it collects bibliographic details, obtains
> candidate headings from an AI provider the user chooses, verifies each
> candidate against the Library of Congress authority file, and produces the
> corresponding MARC field.

## Permission justifications

| Permission | Why |
|---|---|
| `storage` | Keeps the user's settings, API key and saved results on the user's own computer. |
| `unlimitedStorage` | Only for the optional offline authority database, which can be several gigabytes. |
| `https://id.loc.gov/*` | Looks up each suggested heading in the Library of Congress authority file. This is the verification the extension exists to do. |
| `https://generativelanguage.googleapis.com/*` | Google Gemini. Required because earlier versions used Gemini only, so existing users keep working after the update. Used only when the user chooses Gemini. |
| Optional host permissions (provider endpoints) | Requested one at a time, only when the user selects that provider, so the extension can send that provider's request. Declining leaves every other provider working. |

## Privacy practices form

- **Personally identifiable information:** not collected.
- **Health, financial, authentication, personal communications, location,
  web history, user activity:** not collected.
- **Website content:** the bibliographic text the user types is sent to the
  AI provider the user chooses, and only the search terms (the headings,
  which the AI writes from the user's text) are sent to id.loc.gov. Not sold, not used for advertising, not used for anything
  unrelated to the single purpose.
- **Remote code:** none. All JavaScript and WebAssembly ships in the package.
- Privacy policy URL: the `PRIVACY_POLICY.md` in the repository (or wherever
  you host it).

## Before you submit

1. Bump the version in `manifest.json` (it is 1.1.0 now; this release is a
   large change, so 2.0.0 seems right — your call).
2. Take fresh screenshots: the provider picker, a Matches step showing a
   heading that was NOT found, and a Recommendations step with a MARC field.
3. Check that the privacy policy URL you enter is reachable.

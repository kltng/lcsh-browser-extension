# Things only you can do

Collected so they are not lost between phases. Nothing here blocks my work;
each item blocks a RELEASE gate.

## 1. Gemini Nano, in your daily Chrome (Phase 4 release gate)

Nano cannot run in the Chrome instance I drive automatically, so these two
checks need your browser. Load the built extension from `dist/`.

1. Settings → provider **Gemini Nano** → "Test connection". Expected:
   "Connection OK" and "Structured output OK".
2. Run one record through all five steps with Nano, ideally the Chinese one
   (日本電影人物志).
   - Expected: every recommendation shows a real LC ID and a link.
   - Expected: if Nano suggests something that does not exist (in my earlier
     evidence it invented "Japanese cinema"), that heading appears ONLY in the
     suggestions list with an outcome like "No match returned by this search",
     never as a recommendation.
   - Please tell me how long the suggestion step took. The spec gives Nano
     90 seconds for suggestion plus fallback, and I could not measure it.

## 2. One small question from the Phase 3 deny path

When you click **Deny** on the Chrome permission prompt after typing an API
key and model into Settings: is the typed text still in the form afterwards?
(Phase 4 claims it is kept. I could not test it, because automated Chrome
answers permission prompts by itself.)

## 3. Before the first database release (Phase 2)

- The Hugging Face dataset `kltng/lcsh-db-lite` does not exist yet. I will
  create it with one initial commit when the builder is approved; tell me if
  you would rather create it yourself.
- The dataset needs a fine-grained HF token with write access to that dataset
  only, stored as the GitHub secret `HF_TOKEN` in the new builder repo.
- The builder repo `kltng/lcsh-db-builder` is still local only; I will push it
  when the code is approved.

## 4. Chrome Web Store text (Phase 6, at release)

The current Store description says "using Gemini API", which will be wrong.
I will draft replacement text and the privacy-policy additions (multiple
providers, on-device Nano, the optional Hugging Face download); you submit.

## 5. Decisions already recorded (no action needed)

- Database profiles: `core` is the default; `full` is an advanced opt-in with
  a size warning (62 MB / 205 MB vs 1.87 GB / 5.4 GB, measured).
- Names: looked up online at the Library of Congress when only `core` is
  installed; with `full`, a chosen name's MARC key is fetched online.
- The extension never sends your bibliographic text to Hugging Face.

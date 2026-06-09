# Questionnaire Inspection Script

This project uses Playwright to inspect the Google Play IARC content rating
questionnaire as a dynamic tree.

Install dependencies:

```bash
npm install
```

Run the inspector:

```bash
npm run inspect:questionnaire
```

Do not use the default Playwright browser for Google login. Use the dedicated
Chrome workflow below.

## Recommended Google Login Workaround

Google may block login in Playwright's bundled browser with:

```text
This browser or app may not be secure.
```

Use a dedicated real Chrome profile with a DevTools port instead:

1. Start a real Chrome instance with a dedicated local profile:

```bash
bash scripts/open_debug_chrome.sh
```

2. In the opened Chrome window, sign in as `mengshu0715@gmail.com`.
3. Confirm the Play Console questionnaire page opens with that account.
4. In another terminal, run:

```bash
CDP_URL="http://127.0.0.1:9222" npm run inspect:questionnaire
```

In CDP mode, the inspector first reuses the already-open
`content-rating-iarc-questionnaire` tab. It does not navigate to the default
URL unless no matching tab exists. This avoids accidentally switching from the
working Google account slot, such as `/u/0`, to another slot, such as `/u/2`.

The target account is `mengshu0715@gmail.com`, because it has the Google Play
developer permission. The default URL uses `/u/2/`; if Chrome maps
`mengshu0715@gmail.com` to a different Google authuser slot, copy the working
Play Console URL from Chrome and pass it explicitly:

```bash
PLAY_CONSOLE_URL="https://play.google.com/console/u/<n>/developers/6147841152309536951/app/4975581156673272002/app-content/content-rating-iarc-questionnaire" \
CDP_URL="http://127.0.0.1:9222" \
npm run inspect:questionnaire
```

The dedicated Chrome profile is stored in `.chrome-debug-profile`. It is ignored
by git and reused across runs, so you only need to sign in once.

If port `9222` is occupied, choose another port:

```bash
CHROME_DEBUG_PORT=9333 bash scripts/open_debug_chrome.sh
CDP_URL="http://127.0.0.1:9333" npm run inspect:questionnaire
```

Useful environment variables:

```bash
PLAY_CONSOLE_URL="https://play.google.com/console/u/2/developers/.../content-rating-iarc-questionnaire"
IARC_CATEGORY="All Other App Types"
OUT_DIR="data"
CDP_URL="http://127.0.0.1:9222"
EXPECTED_GOOGLE_ACCOUNT="mengshu0715@gmail.com"
MAX_DEPTH=8
MAX_STATES=500
PAUSE_MS=700
npm run inspect:questionnaire
```

Outputs:

- `data/question_graph.json`: primary compact graph for sampling. Each question
  stores its options, and each option stores its direct child questions.
- `data/question_graph.md`: human-readable compact graph.
- `data/question_graph.html`: interactive local graph preview, generated with
  `npm run render:graph`.
- `data/questionnaire_tree.json`: raw debug trace with probe edges, states, and
  skipped probes.
- `data/questionnaire_tree.md`: human-readable raw trace summary.

The script does not click the final Summary `Save` button. It only changes
answers inside the questionnaire page to observe which questions appear or
disappear.

Render the graph preview:

```bash
npm run render:graph
```

You can also pass explicit paths:

```bash
npm run render:graph -- data/question_graph.json data/question_graph.html
```

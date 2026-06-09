#!/usr/bin/env bash
set -euo pipefail

URL="${PLAY_CONSOLE_URL:-https://play.google.com/console/u/2/developers/6147841152309536951/app/4975581156673272002/app-content/content-rating-iarc-questionnaire}"
PORT="${CHROME_DEBUG_PORT:-9222}"
DEBUG_USER_DATA_DIR="${CHROME_DEBUG_USER_DATA_DIR:-$PWD/.chrome-debug-profile}"
EXPECTED_ACCOUNT="${EXPECTED_GOOGLE_ACCOUNT:-mengshu0715@gmail.com}"

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port ${PORT} is already listening. Reuse it with CDP_URL=\"http://127.0.0.1:${PORT}\"." >&2
  exit 0
fi

open -na "Google Chrome" --args \
  "--remote-debugging-port=${PORT}" \
  "--remote-debugging-address=127.0.0.1" \
  "--user-data-dir=${DEBUG_USER_DATA_DIR}" \
  "${URL}"

for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  cat >&2 <<EOF
Chrome started, but DevTools is not reachable on 127.0.0.1:${PORT}.

Try a different port:
  CHROME_DEBUG_PORT=9333 bash scripts/open_debug_chrome.sh
EOF
  exit 1
fi

cat <<EOF
Started Google Chrome with remote debugging on port ${PORT}.

Dedicated Chrome data dir:
  ${DEBUG_USER_DATA_DIR}

Make sure the Play Console page is using this account:
  ${EXPECTED_ACCOUNT}

If this is the first run for this dedicated profile, sign in as
${EXPECTED_ACCOUNT} in the opened Chrome window first.

The default URL uses /u/2. If Chrome maps ${EXPECTED_ACCOUNT} to a different
Google authuser index after login, set PLAY_CONSOLE_URL to the matching
/u/<n>/ URL before starting this script.

Run the inspector in another terminal:
  EXPECTED_GOOGLE_ACCOUNT="${EXPECTED_ACCOUNT}" CDP_URL="http://127.0.0.1:${PORT}" npm run inspect:questionnaire
EOF

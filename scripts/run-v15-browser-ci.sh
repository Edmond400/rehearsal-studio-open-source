#!/usr/bin/env bash
# Isolated local Chromium E2E. NEVER points to production and creates only synthetic data.
set -euo pipefail
test -n "${RUNNER_TEMP:-}"
pnpm build
node scripts/prepare-v14-test-config.mjs
npm install --prefix "$RUNNER_TEMP/rehearsal-browser-deps" --no-fund --no-audit playwright@1.57.0
"$RUNNER_TEMP/rehearsal-browser-deps/node_modules/.bin/playwright" install --with-deps chromium
pnpm exec wrangler d1 migrations apply DB --local --config dist/server/wrangler.v14-test.json
pnpm exec wrangler dev --local --config dist/server/wrangler.v14-test.json --port 8794 >"$RUNNER_TEMP/rehearsal-browser-server.log" 2>&1 &
server_pid=$!
cleanup(){
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT
ready=0
for i in $(seq 1 75); do
 if curl -fsS --max-time 3 --output /dev/null http://127.0.0.1:8794/;then ready=1;break;fi
 if ! kill -0 "$server_pid" 2>/dev/null;then break;fi
 sleep 1
done
if [ "$ready" != 1 ];then
 echo 'Local isolated Worker failed to become ready'
 tail -100 "$RUNNER_TEMP/rehearsal-browser-server.log"
 exit 1
fi
STUDIO_TEST_ORIGIN=http://127.0.0.1:8794 \
STUDIO_PLAYWRIGHT_MODULE="$RUNNER_TEMP/rehearsal-browser-deps/node_modules/playwright/index.mjs" \
STUDIO_V15_SCREENSHOTS="$RUNNER_TEMP/rehearsal-v15-evidence" \
node tests/rehearsal-v15-browser.test.mjs
# Restart the whole scale fixture only when Wrangler's local proxy restarts
# during a slide POST. A new synthetic project avoids retrying an ambiguous write.
scale_log="$RUNNER_TEMP/rehearsal-scale-browser.log"
run_scale_browser(){
 STUDIO_TEST_ORIGIN=http://127.0.0.1:8794 \
 STUDIO_PLAYWRIGHT_MODULE="$RUNNER_TEMP/rehearsal-browser-deps/node_modules/playwright/index.mjs" \
 STUDIO_V15_SCREENSHOTS="$RUNNER_TEMP/rehearsal-v15-evidence" \
 node tests/rehearsal-v15-scale-browser.test.mjs
}
if ! run_scale_browser 2>&1 | tee "$scale_log"; then
 if ! grep -Fq 'Synthetic slide HTTP 503: Your worker restarted mid-request.' "$scale_log"; then
  exit 1
 fi
 echo 'Wrangler restarted during the synthetic scale test; retrying once with a fresh synthetic project.'
 run_scale_browser
fi
STUDIO_PLAYWRIGHT_MODULE="$RUNNER_TEMP/rehearsal-browser-deps/node_modules/playwright/index.mjs" \
STUDIO_PPTX_EVIDENCE="$RUNNER_TEMP/rehearsal-v15-pptx-evidence" \
node tests/rehearsal-pptx-browser.test.mjs

#!/usr/bin/env bash
set -euo pipefail

# 必須環境変数（タスク定義の environment / run-task --overrides から注入される）
: "${AWS_REGION:?}"
: "${RESULTS_BUCKET_NAME:?}"
: "${SSM_PARAMETER_PREFIX:?}"
: "${BASE_URL:?}"
: "${ORIGIN:=${BASE_URL}}"
: "${SCENARIO_NAME:=rest-smoke}"
: "${STUB_ENABLED:=false}"
: "${TEST_RUN_ID:?}"

echo "[load-test] run_id=${TEST_RUN_ID} scenario=${SCENARIO_NAME} base_url=${BASE_URL} stub=${STUB_ENABLED}"

# 1. シナリオファイルをS3から取得（正はGit。GitHub ActionsがJobの中で同期している）
aws s3 cp "s3://${RESULTS_BUCKET_NAME}/scenarios/${SCENARIO_NAME}.js" ./scenario.js

# 2. SSM Parameter Store から負荷試験用トークンを取得（値はログに出さない）
LOAD_TEST_TOKEN=$(aws ssm get-parameter \
  --name "${SSM_PARAMETER_PREFIX}/load-test-token" \
  --with-decryption --query "Parameter.Value" --output text 2>/dev/null || echo "")

if [ -z "${LOAD_TEST_TOKEN}" ]; then
  echo "[load-test] warning: failed to fetch load-test-token from SSM. Token-authenticated checks will be skipped." >&2
fi

# 3. k6実行（結果は summary.json として出力される。exit codeは後で個別に処理する）
set +e
BASE_URL="${BASE_URL}" \
  ORIGIN="${ORIGIN}" \
  LOAD_TEST_TOKEN="${LOAD_TEST_TOKEN}" \
  STUB_ENABLED="${STUB_ENABLED}" \
  TEST_RUN_ID="${TEST_RUN_ID}" \
  k6 run ./scenario.js
K6_EXIT_CODE=$?
set -e

# 4. 結果JSONをS3にアップロード（機微情報は含まれていない前提。summary.jsonはk6のhandleSummaryが生成）
if [ -f summary.json ]; then
  aws s3 cp summary.json "s3://${RESULTS_BUCKET_NAME}/results/${TEST_RUN_ID}/summary.json"
fi

echo "[load-test] k6 exit code=${K6_EXIT_CODE}"
exit "${K6_EXIT_CODE}"

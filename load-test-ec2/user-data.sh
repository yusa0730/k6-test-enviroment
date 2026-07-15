#!/bin/bash
# k6負荷試験（EC2版）の起動スクリプト。GitHub Actionsが run-instances 実行時に
# __PLACEHOLDER__ を実際の値に置換してから --user-data として渡す。
#
# ここに渡す値は RESULTS_BUCKET_NAME / SSM_PARAMETER_PREFIX / SCENARIO_NAME /
# TEST_RUN_ID のみで、いずれも機微情報ではない（バケット名・SSMのパス名・シナリオ名・
# 実行ID）。対象URL・SSOログイン情報・SAMLセッションCookieはここでは一切扱わず、
# scripts/run-load-test.sh が実行時にSSM Parameter Storeから直接取得する。
# そのため、これらの値はGitHub Actionsのログ・user-data・このリポジトリのどこにも残らない。
#
# このスクリプト自身の責務は「run-load-test.shを取得して実行し、結果とログを必ずS3へ
# 送ってからインスタンスを終了させる」ことだけ。実際のk6実行ロジックはrun-load-test.sh側。

exec > /var/log/load-test-user-data.log 2>&1
set -u

RESULTS_BUCKET_NAME="__RESULTS_BUCKET_NAME__"
SSM_PARAMETER_PREFIX="__SSM_PARAMETER_PREFIX__"
SCENARIO_NAME="__SCENARIO_NAME__"
TEST_RUN_ID="__TEST_RUN_ID__"

export AWS_REGION="ap-northeast-1"
export AWS_DEFAULT_REGION="${AWS_REGION}"
export RESULTS_BUCKET_NAME SSM_PARAMETER_PREFIX SCENARIO_NAME TEST_RUN_ID

echo "[load-test-ec2] bootstrap start run_id=${TEST_RUN_ID} scenario=${SCENARIO_NAME}"

cleanup() {
  local exit_code=$?
  if [ ! -f /tmp/k6-exit-code ]; then
    echo "${exit_code}" > /tmp/k6-exit-code
  fi
  aws s3 cp /var/log/load-test-user-data.log \
    "s3://${RESULTS_BUCKET_NAME}/results/${TEST_RUN_ID}/user-data.log" 2>/dev/null || true
  aws s3 cp /tmp/k6-exit-code \
    "s3://${RESULTS_BUCKET_NAME}/results/${TEST_RUN_ID}/exit_code" 2>/dev/null || true
  echo "[load-test-ec2] shutting down (exit_code=$(cat /tmp/k6-exit-code 2>/dev/null))"
  shutdown -h now
}
trap cleanup EXIT

# run-load-test.sh をS3から取得（正はGit。GitHub ActionsがJobの中で同期している）
aws s3 cp "s3://${RESULTS_BUCKET_NAME}/scripts/run-load-test.sh" /tmp/run-load-test.sh
chmod +x /tmp/run-load-test.sh

set +e
/tmp/run-load-test.sh
RUN_EXIT_CODE=$?
set -e
echo "${RUN_EXIT_CODE}" > /tmp/k6-exit-code

echo "[load-test-ec2] run-load-test.sh exit code=${RUN_EXIT_CODE}"
# ここから先は trap の cleanup が実行され、ログ・exit_codeのアップロードとシャットダウンが行われる

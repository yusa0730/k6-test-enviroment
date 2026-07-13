#!/bin/bash
# k6負荷試験（EC2版）の起動スクリプト。GitHub Actionsが run-instances 実行時に
# __PLACEHOLDER__ を実際の値に置換してから --user-data として渡す（ECS版のtask定義
# environmentオーバーライドに相当）。
#
# ECS版のentrypoint.shとの違い:
# - Dockerを使わずk6バイナリを直接展開して実行する
# - ECS Fargateにはタスク終了コードを取得するAPIがあるが、EC2にはインスタンス終了コードという
#   概念が無いため、k6のexit codeを明示的にS3へアップロードしてGitHub Actions側が判定する
# - 途中のどのステップで失敗しても必ずログ・exit_codeをアップロードしてインスタンスを終了させる
#   必要があるため、trap で cleanup を保証する（ECS Fargateではタスク終了時に自動でコンテナが
#   片付くが、EC2は明示的に `shutdown -h now` しないと動いたままになり課金され続ける）

exec > /var/log/load-test-user-data.log 2>&1
set -u

AWS_REGION="__AWS_REGION__"
RESULTS_BUCKET_NAME="__RESULTS_BUCKET_NAME__"
SSM_PARAMETER_PREFIX="__SSM_PARAMETER_PREFIX__"
BASE_URL="__BASE_URL__"
ORIGIN="__ORIGIN__"
SCENARIO_NAME="__SCENARIO_NAME__"
STUB_ENABLED="__STUB_ENABLED__"
TEST_RUN_ID="__TEST_RUN_ID__"
K6_VERSION="__K6_VERSION__"

export AWS_REGION AWS_DEFAULT_REGION="${AWS_REGION}"

echo "[load-test-ec2] run_id=${TEST_RUN_ID} scenario=${SCENARIO_NAME} base_url=${BASE_URL} stub=${STUB_ENABLED}"

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

set -e

# 1. k6本体をダウンロード（ECS版のDockerイメージと同じバージョンを使う。grafana/k6公式リリース）
curl -sSL "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-amd64.tar.gz" -o /tmp/k6.tar.gz
tar -xzf /tmp/k6.tar.gz -C /tmp
install -m 0755 "/tmp/k6-v${K6_VERSION}-linux-amd64/k6" /usr/local/bin/k6

WORKDIR=/opt/load-test
mkdir -p "${WORKDIR}"
cd "${WORKDIR}"

# 2. シナリオファイルをS3から取得（正はGit。GitHub ActionsがJobの中で同期している。ECS版と共有）
aws s3 cp "s3://${RESULTS_BUCKET_NAME}/scenarios/${SCENARIO_NAME}.js" ./scenario.js

# 3. SSM Parameter Store から負荷試験用トークンを取得（値はログに出さない）
LOAD_TEST_TOKEN=$(aws ssm get-parameter --name "${SSM_PARAMETER_PREFIX}/load-test-token" \
  --with-decryption --query "Parameter.Value" --output text 2>/dev/null || echo "")
if [ -z "${LOAD_TEST_TOKEN}" ]; then
  echo "[load-test-ec2] warning: failed to fetch load-test-token from SSM. Token-authenticated checks will be skipped." >&2
fi

# 4. k6実行（結果は summary.json として出力される。exit codeは後で個別に処理する）
set +e
BASE_URL="${BASE_URL}" \
  ORIGIN="${ORIGIN}" \
  LOAD_TEST_TOKEN="${LOAD_TEST_TOKEN}" \
  STUB_ENABLED="${STUB_ENABLED}" \
  TEST_RUN_ID="${TEST_RUN_ID}" \
  k6 run ./scenario.js
K6_EXIT_CODE=$?
set -e
echo "${K6_EXIT_CODE}" > /tmp/k6-exit-code

# 5. 結果JSONをS3にアップロード（機微情報は含まれていない前提。summary.jsonはk6のhandleSummaryが生成）
if [ -f summary.json ]; then
  aws s3 cp summary.json "s3://${RESULTS_BUCKET_NAME}/results/${TEST_RUN_ID}/summary.json"
fi

echo "[load-test-ec2] k6 exit code=${K6_EXIT_CODE}"
# ここから先は trap の cleanup が実行され、ログ・exit_codeのアップロードとシャットダウンが行われる

#!/usr/bin/env bash
set -euo pipefail

# k6実行の本体。呼び出し元（user-data.sh）が結果アップロード・shutdownの保証を
# 引き受けているため、このスクリプト自身はk6の実行結果をそのまま自分の終了コードとして
# 返すだけでよい（trapは持たない）。

# 必須環境変数（user-data.shがexportする、機微情報を含まない値のみ）
: "${AWS_REGION:?}"
: "${RESULTS_BUCKET_NAME:?}"
: "${SSM_PARAMETER_PREFIX:?}"
: "${SCENARIO_NAME:=smoke-rest}"
: "${TEST_RUN_ID:?}"

K6_VERSION="1.3.0"

echo "[load-test-ec2] run_id=${TEST_RUN_ID} scenario=${SCENARIO_NAME} ssm_prefix=${SSM_PARAMETER_PREFIX}"

# 0. k6/jqをインストール（起動のたびに使い捨てのため毎回必要。aws-cliはAmazon Linux 2023に標準搭載）
dnf install -y jq
curl -sSL "https://github.com/grafana/k6/releases/download/v${K6_VERSION}/k6-v${K6_VERSION}-linux-amd64.tar.gz" \
  | tar xz -C /tmp
mv "/tmp/k6-v${K6_VERSION}-linux-amd64/k6" /usr/local/bin/k6
chmod +x /usr/local/bin/k6

WORK_DIR=$(mktemp -d)
cd "${WORK_DIR}"

# 1. シナリオファイルをS3から取得（正はGit。GitHub ActionsがJobの中で同期している）
aws s3 cp "s3://${RESULTS_BUCKET_NAME}/scenarios/${SCENARIO_NAME}.js" ./scenario.js

# 2. SSM Parameter Store から対象URL・認証情報を取得（値はログに出さない）
# 対象URL自体もリポジトリ・ワークフローには一切書かず、ここで初めて取得する。
ssm_get() {
  aws ssm get-parameter --name "${SSM_PARAMETER_PREFIX}/$1" --with-decryption --query "Parameter.Value" --output text
}

BASE_URL=$(ssm_get "base-url")
ORIGIN=$(ssm_get "origin" 2>/dev/null || echo "${BASE_URL}")
SSO_LOGIN_ID=$(ssm_get "sso-login-id" 2>/dev/null || echo "")
SSO_LOGIN_PASSWORD=$(ssm_get "sso-login-password" 2>/dev/null || echo "")
AUTH_COOKIE=$(ssm_get "auth-token" 2>/dev/null || echo "")

if [ -z "${BASE_URL}" ]; then
  echo "[load-test-ec2] ${SSM_PARAMETER_PREFIX}/base-url が未設定です" >&2
  exit 1
fi

# 3. auth_token は「実際にSAML SSOでログインしたセッションのCookie値」を人手で一度
#    取得し、SSMへ登録したものをそのまま使う（load-test/README.mdの手元疎通確認と同じ運用）。
#    実SSOのIdPハンドシェイクはCI/k6から自動化できないため、この値は運用者が
#    ブラウザでSSOログイン→DevToolsでauth_tokenをコピー→SSM更新、を定期的に
#    手動で行うことで維持する。
if [ -z "${AUTH_COOKIE}" ]; then
  echo "[load-test-ec2] ${SSM_PARAMETER_PREFIX}/auth-token が未設定です（SSMへ手動でauth_tokenの値を登録してください）" >&2
  exit 1
fi

# 4. k6実行（結果は summary.json として出力される。exit codeはそのままこのスクリプトの終了コードにする）
set +e
K6_BASE_URL="${BASE_URL}" \
  K6_ORIGIN="${ORIGIN}" \
  K6_BASIC_USER="${SSO_LOGIN_ID}" \
  K6_BASIC_PASS="${SSO_LOGIN_PASSWORD}" \
  K6_AUTH_TOKEN="${AUTH_COOKIE}" \
  K6_TEST_RUN_ID="${TEST_RUN_ID}" \
  k6 run ./scenario.js
K6_EXIT_CODE=$?
set -e

# 5. 結果JSONをS3にアップロード（機微情報は含まれていない前提。summary.jsonはk6のhandleSummaryが生成）
if [ -f summary.json ]; then
  aws s3 cp summary.json "s3://${RESULTS_BUCKET_NAME}/results/${TEST_RUN_ID}/summary.json"
fi

echo "[load-test-ec2] k6 exit code=${K6_EXIT_CODE}"
exit "${K6_EXIT_CODE}"

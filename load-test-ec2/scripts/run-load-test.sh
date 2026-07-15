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

# インスタンス起動直後はEIPのassociateがまだ完了していない場合があり、その間は
# S3/SSM/インターネットへの到達性が無い。呼び出し元のuser-data.shと同じ理由で、
# ネットワークに依存する操作はリトライする。
retry() {
  local max_attempts=20
  local delay=3
  local attempt=1
  until "$@"; do
    if [ "${attempt}" -ge "${max_attempts}" ]; then
      echo "[load-test-ec2] command failed after ${attempt} attempts: $*" >&2
      return 1
    fi
    echo "[load-test-ec2] retrying ($((attempt + 1))/${max_attempts}) in ${delay}s: $*" >&2
    sleep "${delay}"
    attempt=$((attempt + 1))
  done
}

# 0. k6本体をダウンロード（起動のたびに使い捨てのため毎回必要。aws-cliはAmazon Linux 2023に標準搭載）
# 一旦ファイルに保存し、grafana/k6が同じリリースで配布しているchecksums.txtと
# 突き合わせてから展開する（ダウンロード時の破損・改ざんの検知。認証情報を扱うインスタンスで
# 素性を確認しないまま任意バイナリを実行するのは避ける）。
K6_TARBALL="k6-v${K6_VERSION}-linux-amd64.tar.gz"
K6_RELEASE_URL="https://github.com/grafana/k6/releases/download/v${K6_VERSION}"
retry curl -sSL "${K6_RELEASE_URL}/${K6_TARBALL}" -o "/tmp/${K6_TARBALL}"
retry curl -sSL "${K6_RELEASE_URL}/k6-v${K6_VERSION}-checksums.txt" -o /tmp/k6-checksums.txt

EXPECTED_SHA256=$(grep "  ${K6_TARBALL}\$" /tmp/k6-checksums.txt | awk '{print $1}')
if [ -z "${EXPECTED_SHA256}" ]; then
  echo "[load-test-ec2] ${K6_TARBALL} のchecksumがk6-v${K6_VERSION}-checksums.txtに見つかりません" >&2
  exit 1
fi
ACTUAL_SHA256=$(sha256sum "/tmp/${K6_TARBALL}" | awk '{print $1}')
if [ "${EXPECTED_SHA256}" != "${ACTUAL_SHA256}" ]; then
  echo "[load-test-ec2] k6バイナリのchecksumが一致しません（改ざん・破損の可能性）。expected=${EXPECTED_SHA256} actual=${ACTUAL_SHA256}" >&2
  exit 1
fi

tar xzf "/tmp/${K6_TARBALL}" -C /tmp
mv "/tmp/k6-v${K6_VERSION}-linux-amd64/k6" /usr/local/bin/k6
chmod +x /usr/local/bin/k6

WORK_DIR=$(mktemp -d)
cd "${WORK_DIR}"

# 1. シナリオファイルをS3から取得（正はGit。GitHub ActionsがJobの中で同期している）
retry aws s3 cp "s3://${RESULTS_BUCKET_NAME}/scenarios/${SCENARIO_NAME}.js" ./scenario.js

# 2. SSM Parameter Store から対象URL・認証情報を取得（値はログに出さない）
# 対象URL自体もリポジトリ・ワークフローには一切書かず、ここで初めて取得する。
# この時点までにk6ダウンロード・シナリオ取得でネットワーク到達性は既に確認できているはずなので、
# パラメータ未設定などの恒久的なエラーで無駄に待たされないよう、リトライ回数は短めにする。
ssm_get() {
  local max_attempts=5
  local delay=2
  local attempt=1
  until aws ssm get-parameter --name "${SSM_PARAMETER_PREFIX}/$1" --with-decryption --query "Parameter.Value" --output text; do
    if [ "${attempt}" -ge "${max_attempts}" ]; then
      return 1
    fi
    sleep "${delay}"
    attempt=$((attempt + 1))
  done
}

BASE_URL=$(ssm_get "base-url" 2>/dev/null || echo "")
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

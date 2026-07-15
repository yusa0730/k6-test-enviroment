import { check } from "k6";
import encoding from "k6/encoding";
import http from "k6/http";

// ---------------------------------------------------------------------------
// 疎通確認シナリオ（REST / smoke、SAMLセッションCookie対応）
//
// 対象URL・SSOログイン情報・SAMLセッションCookieはすべて呼び出し元（EC2版の
// load-test-ec2/scripts/run-load-test.sh）がSSM Parameter Storeから取得し、
// K6_ プレフィックス付きの環境変数として渡す。このファイル自体・リポジトリには
// 実際の値を一切書かない。
//
// 認証の仕組み:
//   auth_token Cookie 内のセッションは、SAML SSOで実際にログインした人間の
//   ブラウザセッションから一度だけ取得し、SSMへ登録したものを使い回す
//   （CI/k6からSSOのIdPハンドシェイク自体は自動化できないため）。
// ---------------------------------------------------------------------------

const BASE_URL = __ENV.K6_BASE_URL || "";
const ORIGIN = __ENV.K6_ORIGIN || BASE_URL;
const BASIC_USER = __ENV.K6_BASIC_USER || "";
const BASIC_PASS = __ENV.K6_BASIC_PASS || "";
const AUTH_TOKEN = __ENV.K6_AUTH_TOKEN || "";
const TEST_RUN_ID = __ENV.K6_TEST_RUN_ID || "local";

if (!BASE_URL) {
  throw new Error("K6_BASE_URL is required");
}

// 到達レート固定 (5rps) のスモークシナリオ。事前にウォームアップを挟む。
// 合否条件 (thresholds) は暫定値。
export const options = {
  scenarios: {
    warmup: {
      executor: "constant-vus",
      vus: 2,
      duration: "10s",
      exec: "warmup",
    },
    smoke: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 5,
      maxVUs: 10,
      startTime: "10s",
      exec: "smoke",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.1"],
    "http_req_duration{expected_response:true}": ["p(95)<5000"],
  },
};

// --- ヘルパー ----------------------------------------------------------------

function buildHeaders({ withSession }) {
  const headers = { Origin: ORIGIN };

  if (BASIC_USER && BASIC_PASS) {
    const encoded = encoding.b64encode(`${BASIC_USER}:${BASIC_PASS}`);
    headers["Authorization"] = `Basic ${encoded}`;
  }

  if (withSession && AUTH_TOKEN) {
    headers["Cookie"] = `auth_token=${AUTH_TOKEN}`;
  }

  return headers;
}

// --- シナリオ ----------------------------------------------------------------

function hitUnauthenticated() {
  // 0. 疎通確認（認証不要。CloudFront/WAFを通過できているかの最小確認）
  const res = http.get(`${BASE_URL}/api/test`, {
    headers: buildHeaders({ withSession: false }),
    tags: { name: "GET /api/test" },
  });

  check(res, {
    "test: status is 200": (r) => r.status === 200,
  });
}

function hitAuthenticated() {
  if (!AUTH_TOKEN) return;

  // 1. ユーザー情報取得（認証の疎通確認）
  const res = http.get(`${BASE_URL}/api/me`, {
    headers: buildHeaders({ withSession: true }),
    tags: { name: "GET /api/me" },
  });

  check(res, {
    "me: status is 200": (r) => r.status === 200,
    "me: has response body": (r) => r.body && r.body.length > 0,
  });
}

export function warmup() {
  hitUnauthenticated();
  hitAuthenticated();
}

export function smoke() {
  hitUnauthenticated();
  hitAuthenticated();
}

// --- ライフサイクル -----------------------------------------------------------

export function setup() {
  if (!BASIC_USER || !BASIC_PASS) {
    console.warn(
      "K6_BASIC_USER / K6_BASIC_PASS が未設定です。CloudFront/WAFのBasic認証で拒否される可能性があります。",
    );
  }
  if (!AUTH_TOKEN) {
    console.warn(
      "K6_AUTH_TOKEN が未設定です。認証が必要なチェック（GET /api/me）はスキップします。",
    );
  }
}

export function handleSummary(data) {
  return {
    // EC2実行時、run-load-test.sh がこれを読んでS3アップロードを行う
    "summary.json": JSON.stringify({
      testRunId: TEST_RUN_ID,
      metrics: data.metrics,
    }),
    stdout: JSON.stringify(data, null, 2),
  };
}

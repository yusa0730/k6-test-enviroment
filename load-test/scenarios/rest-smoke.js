import { check, sleep } from "k6";
import http from "k6/http";

const BASE_URL = __ENV.BASE_URL || "https://httpbin.org";
const ORIGIN = __ENV.ORIGIN || BASE_URL;
const LOAD_TEST_TOKEN = __ENV.LOAD_TEST_TOKEN || "";
const STUB_ENABLED = __ENV.STUB_ENABLED === "true";
const TEST_RUN_ID = __ENV.TEST_RUN_ID || "local";

function headersFor({ withToken }) {
  const headers = { Origin: ORIGIN };
  if (withToken && LOAD_TEST_TOKEN) {
    headers["X-Load-Test-Token"] = LOAD_TEST_TOKEN;
  }
  return headers;
}

// 到達レート固定 (5rps) のスモークシナリオ。事前にウォームアップを挟む。
// 合否条件 (thresholds) は暫定値。本番相当のSLIではない。
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
    http_req_failed: ["rate<0.01"],
    "http_req_duration{expected_response:true}": ["p(95)<2000"],
  },
};

export function setup() {
  if (!LOAD_TEST_TOKEN) {
    console.warn(
      "LOAD_TEST_TOKEN is not set. Skipping the SSM-sourced token check (GET /headers).",
    );
  }
}

// 対象APIの read-only エンドポイントを模したチェック（常に公開）
function hitPublicEndpoint() {
  const res = http.get(`${BASE_URL}/get`, {
    headers: headersFor({ withToken: false }),
    tags: { endpoint: "public_get" },
  });
  check(res, {
    "GET /get: status 200": (r) => r.status === 200,
  });
}

// SSM から取得したトークンをヘッダーに載せて送る「認証付きAPI」を模したチェック
function hitTokenEndpoint() {
  if (!LOAD_TEST_TOKEN) return;
  const res = http.get(`${BASE_URL}/headers`, {
    headers: headersFor({ withToken: true }),
    tags: { endpoint: "token_headers" },
  });
  check(res, {
    "GET /headers: status 200": (r) => r.status === 200,
    "GET /headers: token echoed back": (r) =>
      r.body && r.body.includes(LOAD_TEST_TOKEN),
  });
}

// STUB_ENABLED=true の場合は軽量エンドポイント、false の場合は /delay/1 で
// 「重い依存先を叩く本番相当の呼び出し」を模す（スタブ切り替えの再現）
function hitDependencyEndpoint() {
  const path = STUB_ENABLED ? "/get" : "/delay/1";
  const res = http.get(`${BASE_URL}${path}`, {
    headers: headersFor({ withToken: false }),
    tags: { endpoint: "dependency", stub: String(STUB_ENABLED) },
  });
  check(res, {
    "dependency endpoint: status 200": (r) => r.status === 200,
  });
}

export function warmup() {
  hitPublicEndpoint();
  hitTokenEndpoint();
  sleep(1);
}

export function smoke() {
  hitPublicEndpoint();
  hitTokenEndpoint();
  hitDependencyEndpoint();
}

// k6標準の summary をJSONで書き出す。ECSコンテナのentrypointがこれを読んで
// S3アップロードを行う。
export function handleSummary(data) {
  return {
    "summary.json": JSON.stringify({
      testRunId: TEST_RUN_ID,
      baseUrl: BASE_URL,
      stubEnabled: STUB_ENABLED,
      metrics: data.metrics,
    }),
    stdout: JSON.stringify(data, null, 2),
  };
}

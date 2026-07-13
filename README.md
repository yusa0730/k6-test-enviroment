# k6負荷試験環境（SST + ECS Fargate / EC2）

`k6-architecture.png` の構成をもとに、pnpm workspace + SST で構築した k6 負荷試験の実行基盤です。

コンピュートには **ECS Fargate版**（`load-test/`）と **EC2版**（`load-test-ec2/`）の2種類を用意している。
どちらも同じ役割（VPC・S3・IAM・シナリオ実行）を持つ完全に独立した実装で、同時に存在させても
互いに影響しない。まずECS版の構成を説明し、後半でEC2版との違いを説明する。

```
Developer が シナリオ(load-test/scenarios/*.js) をコミット
    ↓
GitHub UI から workflow_dispatch で手動実行
    ↓
GitHub Actions (.github/workflows/load-test-qa.yml)
    ├─ Job: Dockerイメージ build & ECR push（任意。k6本体更新時のみ）
    └─ Job: テスト実行
         1. シナリオファイルをS3に同期（正はGit）
         2. ECS Fargate タスクを run-task で起動
              ├─ S3からシナリオ取得
              ├─ SSM Parameter Storeからトークン取得
              ├─ k6 run でシナリオ実行
              └─ 結果JSON(summary.json)をS3にアップロード
         3. タスクの exit code を確認
         4. Slack通知（Webhook未設定ならスキップ）
    ↓
開発者がS3から結果をダウンロードして分析
```

## 何を構築しているか（ECS版）

| レイヤー | 内容 |
|---|---|
| `infra/src/services/load-test/network.ts` | k6実行専用の独立VPC（10.100.0.0/16）。Public/Private subnet、NAT Gateway、Security Group（egressのみ） |
| `infra/src/services/load-test/bucket.ts` | S3バケット。`scenarios/`（k6シナリオ置き場）と`results/`（結果JSON置き場、30日で自動削除） |
| `infra/src/services/load-test/repository.ts` | k6実行コンテナ用のECRリポジトリ |
| `infra/src/services/load-test/task-role.ts` | ECS Fargateタスク用のIAMロール（S3・SSMへの最小権限） |
| `infra/src/services/load-test/fargate.ts` | ECS Cluster + TaskDefinition（**Serviceは作らない**。実行のたびにrun-taskでオンデマンド起動する使い捨てバッチ） |
| `infra/src/stacks/load-test.ts` | 上記を束ねるスタック。SSM Parameterに検証用トークンも作成する |
| `load-test/scenarios/rest-smoke.js` | k6シナリオ本体。対象は一般公開の [httpbin.org](https://httpbin.org)（HTTPクライアントのテスト用に公式提供されているサイト） |
| `load-test/docker/` | k6実行コンテナ（Dockerfile + entrypoint.sh） |
| `.github/workflows/load-test-qa.yml` | 実行フロー全体を制御するGitHub Actions workflow |

## なぜこの構成にしたか

**1. VPCを既存インフラと分離し、専用に作った理由**
負荷試験用のFargateタスクは対象サイトへ外向きにリクエストを送るだけで、他システムから接続を受ける必要がない。既存VPCへピアリングすると誤って本番系のセキュリティグループ等に影響を与えるリスクがあるため、影響範囲をゼロにするために独立したVPCにした。NAT Gatewayを置いているのは、Fargateタスクの送信元IPを固定し、将来的に対象サービス側でWAFのallowlist登録を行えるようにするため（今回のhttpbin.org検証では不要だが、実運用でCloudFront経由の自社QA環境を叩く場合に必要になる構成のため最初から含めている）。

**2. ECS Service ではなく `run-task` にした理由**
負荷試験は「必要なときに一度だけ走らせるバッチ処理」であり、常時起動のWebサーバではない。ECS Serviceを作るとタスクが落ちても自動で立ち上がり続け、意図しない課金が発生する。`run-task` はGitHub Actionsから明示的に叩いた時だけコンテナが起動し、終了すれば課金も止まる。

**3. シナリオをDockerイメージに焼き込まず、S3同期にした理由**
シナリオ（何をどう叩くか）とコンテナ（k6本体・実行環境）は変更頻度が全く違う。シナリオはコード修正のたびに変わるが、Dockerイメージはk6のバージョンを上げる時くらいしか変わらない。焼き込み方式だとシナリオ修正のたびにDocker build（数分）が必要になるため、正はGitのシナリオファイルをS3に同期するだけにして、Docker buildは`rebuild_image`入力で明示的にオプトインする形にした。

**4. IAMロールを機能ごとに最小権限で切った理由**
Fargateタスクの実行ロール（`task-role.ts`）は「S3のscenarios/を読む」「S3のresults/に書く」「SSMの特定パス配下を読む」以外の権限を持たない。仮にコンテナが乗っ取られても、他のAWSリソースには波及しない設計にしている。同様にGitHub Actions用のOIDCロールも `k6env-load-test-*` という名前のリソースにしか触れないようスコープしている（後述）。

**5. 認証情報をSSM Parameter Storeから都度取得する構成にした理由**
シークレットをタスク定義やGitHub Actionsのenvに直接書かず、実行時にSSMから取得する形にすることで、シークレットの値がコード上・ログ上に残らないようにしている。今回はhttpbin.orgに対する検証用トークンだが、本番相当の対象（認証付きAPI）に切り替える際もこの構造をそのまま使える。

**6. 対象を`httpbin.org`にした理由**
このリポジトリは実行基盤そのものの検証が目的であり、特定の自社アプリケーションに依存させたくなかった。httpbin.orgはHTTPクライアントのテスト用に公式に提供されている一般公開サービスで、`/get`（単純GET）・`/headers`（送信ヘッダーのエコーバック、認証ヘッダーを使うAPIの疑似確認に使える）・`/delay/N`（重い依存先呼び出しの疑似確認に使える）など、今回の検証に必要なパターンが揃っている。本番のAPIに向ける場合は `.env` の `BASE_URL` / `ORIGIN` を差し替えるだけでよい。

**7. GitHub Actions用のIAMロールをリポジトリ単位でOIDC発行にした理由**
長期の固定IAMキーをGitHub Secretsに置くとキー漏洩時の被害が大きい。OIDC（`sts:AssumeRoleWithWebIdentity`）にすることで、GitHub Actionsの実行のたびに短命な一時クレデンシャルが発行される方式にした。信頼関係（trust policy）も `repo:yusa0730/k6-test-enviroment:*` に限定し、他リポジトリからはこのロールを引き受けられないようにしている。

## 使い方

### 前提
- pnpm がインストールされていること
- AWS CLI が設定済み（ローカルから直接触る場合）
- Docker（イメージをビルドする場合）
- k6（`brew install k6`。ローカルでシナリオ単体を試す場合）

### ローカルでシナリオだけ試す（AWS不要）

```bash
cd load-test
cp .env.example .env
pnpm run smoke:local
```

httpbin.org に直接アクセスして、5〜10VU相当のスモークテストが実行される。

### AWSにインフラをデプロイする（ローカルから）

```bash
pnpm install
cd load-test
pnpm run sst:deploy   # 作成
pnpm run sst:diff     # 差分確認
pnpm run sst:remove   # 削除（課金停止）
```

### GitHub Actions経由で実行する

`Actions` タブ → `Load Test (k6 on ECS Fargate)` → `Run workflow` から手動実行する。主な入力:

| 入力 | 説明 |
|---|---|
| `scenario` | 実行するシナリオ名（`load-test/scenarios/<name>.js`） |
| `stub_enabled` | 依存先呼び出しを軽量エンドポイントに切り替えるか |
| `rebuild_image` | k6実行コンテナを再ビルド・ECRプッシュするか（初回や k6バージョン更新時は `true`） |
| `infra_action` | `none`＝試験のみ実行 / `diff`＝インフラ差分確認 / `deploy`＝インフラ作成・更新 / `remove`＝インフラ削除 |
| `confirm_remove` | `infra_action=remove` のときだけ `REMOVE` と入力（誤操作防止） |

初回の流れの例:

1. `infra_action=deploy` でインフラ一式を作成
2. `infra_action=none`, `rebuild_image=true` でイメージをビルドしつつ負荷試験を実行
3. 以降、シナリオだけ直せば `infra_action=none`, `rebuild_image=false` で十分（S3同期のみ）
4. 使い終わったら `infra_action=remove`, `confirm_remove=REMOVE` で課金停止

結果は `s3://k6env-load-test-bucket-qa/results/<test_run_id>/summary.json` に保存される。CloudWatch Logsは `/aws/ecs/service/k6env-load-test-fargate-qa` を参照する。

### `infra_action=remove` の承認フロー

削除は誤操作の影響が大きいため、diffで削除対象を確認してから人が承認しないと実行されないようにしている。

1. `infra-diff` ジョブが `sst diff` を実行し、削除対象をワークフロー実行画面の **Summary** に表示する
2. `infra-remove` ジョブは `load-test-remove` という GitHub Environment に紐づいており、この environment には Required reviewer（リポジトリ管理者）が設定済みのため、diff完了後は **Waiting** 状態で止まる
3. Actions実行画面の **Review deployments** から Summary の diff 内容を確認し、問題なければ承認する
4. 承認後に初めて `sst remove` が実行される

Required reviewerの設定は一度だけ行えばよい（`gh api --method PUT repos/<owner>/<repo>/environments/load-test-remove` に `reviewers` を指定）。別リポジトリに移植する場合は改めて設定が必要。

### GitHub Actionsを動かすための事前設定（初回のみ）

このリポジトリでは以下がAWS側に設定済み。別リポジトリに移植する場合は同様の設定が必要。

1. GitHub OIDC Provider（`token.actions.githubusercontent.com`）をAWSアカウントに登録
2. そのOIDCを信頼するIAMロールを作成し、`repo:<owner>/<repo>:*` の `sub` に限定
   - 参考: このリポジトリでは `k6env-load-test-github-actions-role` という名前で作成し、`ec2:*` / `ecs:*` / `ecr:*`（対象リポジトリのみ）/ `s3:*`（対象バケットのみ）/ `iam:*`（`k6env-load-test-*` ロールのみ）/ `ssm:*`（`/k6env/load-test/*` 配下のみ）+ SSTの内部管理用に `/sst/bootstrap` と `/sst/passphrase/<app>/<stage>` へのSSMアクセスを許可
3. GitHub Secretsに登録
   - `AWS_OIDC_ROLE_ARN`: 上記ロールのARN
   - `AWS_ACCOUNT_ID`: AWSアカウントID
   - `SLACK_LOAD_TEST_WEBHOOK_URL`（任意）: 未設定なら通知ステップはスキップされる

## EC2版（ECSの代替実装）

ECS Fargateの代わりにEC2インスタンスでk6を実行する版。**ECS版のコードは一切変更していない**。
ECSとEC2のどちらでこの手の使い捨て負荷試験基盤を組むかを比較できるように、同じ役割を持つ
実装を並行して用意している。

```
GitHub Actions (.github/workflows/load-test-ec2-qa.yml)
    └─ Job: テスト実行
         1. シナリオファイルをS3に同期（load-test/scenarios/ をECS版と共有）
         2. EC2インスタンスを run-instances で起動（Launch Template使用）
              ├─ user-dataでk6バイナリを直接ダウンロード・展開（Dockerは使わない）
              ├─ S3からシナリオ取得 / SSMからトークン取得
              ├─ k6 run でシナリオ実行
              ├─ 結果JSON・実行ログ・exit_codeをS3にアップロード（trapで必ず実行される）
              └─ shutdown -h now でインスタンス自身を終了（課金停止）
         3. 起動直後にElastic IPをassociate（送信元IP固定）
         4. instance-terminated を待ってから、S3のexit_codeで合否判定
         5. Slack通知（Webhook未設定ならスキップ）
```

### 何を構築しているか（EC2版）

| レイヤー | 内容 |
|---|---|
| `infra/src/services/load-test-ec2/network.ts` | 専用VPC（10.101.0.0/16）。**NAT Gatewayは作らない**。Public subnetのみ + Elastic IPで送信元IPを固定 |
| `infra/src/services/load-test-ec2/bucket.ts` | S3バケット。ECS版と同じ役割（scenarios/・results/）だが別バケット |
| `infra/src/services/load-test-ec2/instance-role.ts` | EC2インスタンス用のIAMロール＋インスタンスプロファイル（S3・SSM・SSM Session Managerの最小権限。ECR権限は不要） |
| `infra/src/services/load-test-ec2/launch-template.ts` | EC2 Launch Template（ECS版のtask definitionに相当）。AMIはAmazon Linux 2023最新版をSSM Public Parameterから解決 |
| `infra/src/stacks/load-test-ec2.ts` | 上記を束ねるスタック |
| `load-test-ec2/user-data.sh` | インスタンス起動時に実行されるスクリプト（ECS版のentrypoint.shに相当） |
| `.github/workflows/load-test-ec2-qa.yml` | EC2版専用のGitHub Actions workflow |

### ECS版との違いとその理由

**1. NAT Gatewayを使わず、public subnet + Elastic IPにした理由**
ECS Fargateはprivate subnetにしか置けない awsvpc モードの都合上、外部疎通にNAT Gatewayが必要だった。EC2はpublic subnetに直接置いてElastic IPを割り当てるだけで同じ「送信元IP固定」が実現でき、NAT Gateway（時間課金＋データ処理課金）が丸ごと不要になる。EIPは起動中のインスタンスに紐付いていてもいなくても同額課金（2024年2月のAWS料金改定以降）なので、インスタンスを使っていない間もEIP自体は`sst remove`するまで課金され続ける点はECS版のNAT Gatewayと同じ「使ったら忘れず消す」運用が必要。ただし単価はNAT Gatewayよりかなり低い。

**2. Dockerを使わず、k6をuser-dataで直接インストールする理由**
EC2はOSが直接見えるので、Dockerを挟む必然性がない。ECS版はコンテナ実行環境そのものがFargateの要件だったが、EC2ではuser-data（cloud-init）でk6バイナリを展開して直接実行する方がシンプルで、ECR・イメージビルドの手間（build-imageジョブ）がまるごと不要になる。バージョンはECS版のDockerイメージ（`grafana/k6:1.3.0`）と同じ `v1.3.0` を指定し、動作の差異が出ないようにしている。

**3. exit_codeをS3に明示的にアップロードする理由**
ECS FargateにはRunTaskしたタスクの終了コードを`describe-tasks`で取得できるAPIがあるが、EC2インスタンスには「終了コード」という概念自体が無い（インスタンスが起動していたか終了したかの状態しか分からない）。そのため、k6の実行結果をuser-data内で明示的に`results/<test_run_id>/exit_code`としてS3に書き出し、GitHub Actions側はインスタンス終了（`instance-terminated`）を待ってからそのファイルを読んで合否判定する設計にしている。

**4. `trap` で後片付けを保証する理由**
ECS FargateはタスクプロセスがどのタイミングでExitしても、Fargate基盤側がコンテナとタスクの片付け（課金停止）を保証してくれる。EC2はそうではなく、user-dataスクリプトの途中（k6インストール失敗など）で異常終了すると、`shutdown -h now`まで到達せずインスタンスが起動しっぱなしになり、課金され続けるリスクがある。そのため`trap cleanup EXIT`でスクリプトがどこで失敗しても必ずログ・exit_codeのアップロードとシャットダウンが実行されるようにしている。

**5. Session Manager用の権限を持たせている理由**
Amazon Linux 2023はSSM Agentがプリインストール済みのため、`ssmmessages:*`系の権限をインスタンスロールに与えるだけでポート開放無しにSession Manager接続でデバッグできる（ECS版のECS Execに相当する）。

### 使い方（EC2版）

```bash
pnpm install
cd load-test-ec2
pnpm run sst:deploy   # 作成
pnpm run sst:diff     # 差分確認
pnpm run sst:remove   # 削除（課金停止）
```

GitHub Actionsは `Actions` タブ → `Load Test EC2 (k6 on EC2)` → `Run workflow` から実行する。入力はECS版とほぼ同じだが `rebuild_image` が無い（Dockerを使わないため）。`infra_action=remove` の承認フローもECS版と同様で、`load-test-ec2-remove` environmentにRequired reviewerを設定済み。

結果は `s3://k6env-load-test-ec2-bucket-qa/results/<test_run_id>/{summary.json,exit_code,user-data.log}` に保存される。CloudWatch Logsは使っていない（インスタンス終了後に失われるログをS3へ直接アップロードする設計のため）。

### ECS版・EC2版 比較まとめ

| 観点 | ECS版 | EC2版 |
|---|---|---|
| ネットワークコスト | NAT Gateway（時間課金＋データ処理課金） | Elastic IPのみ（NAT Gatewayよりかなり安い） |
| 実行単価 | Fargateの従量課金（サーバーレスの分だけ割高） | EC2オンデマンド課金（素の単価は安いがOS起動オーバーヘッドあり） |
| 起動オーバーヘッド | 数十秒（タスク起動が速い） | 1分弱（EC2起動＋user-data実行が乗る） |
| 実行環境の再現性 | Dockerイメージで完全固定 | user-dataスクリプトでOSパッケージ状態に依存する部分がある |
| 合否判定の取得方法 | `ecs describe-tasks` の exitCode | S3にアップロードした `exit_code` ファイル |
| デバッグ | CloudWatch Logs（永続） | S3にアップロードしたuser-data.log（インスタンス終了前に退避する設計） |
| Session Manager / ECS Exec相当 | ECS Exec | SSM Session Manager（AL2023はAgent同梱） |

どちらも「使うときだけ起動し、終わったら自動で片付く」設計は共通。単発の軽量スモークテストではEC2版の方がネットワークコストは低いが、Dockerイメージによる再現性や、将来的に本格負荷（マルチコンテナ分散実行など）に拡張しやすいのはECS版という住み分けになる。

## 費用について

**NAT Gateway（ECS版）・Elastic IP（EC2版）は常時起動課金される。** 検証が終わったら、使った方の `infra_action=remove` で必ず削除すること。ECS Fargateタスク・EC2インスタンス自体は実行時間のみの課金（どちらも使い捨てのオンデマンド起動方式なので、試験が終われば0円）。

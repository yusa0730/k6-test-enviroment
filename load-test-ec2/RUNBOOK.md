# 負荷試験（k6 on EC2）Runbook

`.github/workflows/load-test-ec2-qa.yml`（workflow_dispatch）を使って、対象サイトへk6負荷試験を実行するための手順書。ECS版の代替実装（`load-test/` + `load-test-qa.yml`）については触れず、EC2版のみを対象とする。

## この基盤の全体像

```
GitHub Actions (workflow_dispatch)
  → infra_action=deploy/diff/remove（インフラ操作。任意）
  → run-load-test（infra_action=none または deploy の時のみ）
      → EC2インスタンスをrun-instancesで起動
      → Elastic IPをassociate（送信元IP固定）
      → インスタンス内でk6実行（SSMから対象URL・認証情報を取得）
      → 結果をS3へアップロード → インスタンスは自身でshutdown -h now（終了・課金停止）
      → GitHub Actionsは結果（exit_codeマーカー）をS3から取得して合否判定
```

インスタンスは常時起動ではない。試験を実行するときだけ起動し、終わったら自動で終了する。常時課金されるのは Elastic IP（デプロイしている間ずっと。使い終わったら`infra_action=remove`で消すこと）だけ。

## 前提条件（初回のみ）

- リポジトリへの書き込み権限（workflow_dispatchの実行に必要）
- `load-test-ec2-remove` Environment（Settings > Environments）に Required reviewers が設定されていること（未設定だと`infra_action=remove`が承認なしで即実行されてしまう）
- GitHub Secrets に `AWS_OIDC_ROLE_ARN`（ECS版と共用のOIDCロール）が登録されていること
- 以下のSSM Parameter（`/k6env/load-test/ec2/qa/` 配下、`SecureString`）が登録されていること
  - `base-url` / `origin`: 対象サイトのベースURL（例: `https://example.workspace.satto-dev.com`）。**リポジトリ・ワークフローには一切書かない**ため、初回は手動で登録する
  - `sso-login-id` / `sso-login-password`: CloudFront/WAFのBasic認証情報
  - `auth-token`: 実際にSAML SSOでログインしたセッションのCookie値（後述「認証情報の準備」）

```bash
aws ssm put-parameter --name "/k6env/load-test/ec2/qa/base-url" --type "SecureString" --value "<対象URL>" --overwrite
aws ssm put-parameter --name "/k6env/load-test/ec2/qa/origin" --type "SecureString" --value "<対象URLと同じでよい>" --overwrite
aws ssm put-parameter --name "/k6env/load-test/ec2/qa/sso-login-id" --type "SecureString" --value "<Basic認証ユーザー名>" --overwrite
aws ssm put-parameter --name "/k6env/load-test/ec2/qa/sso-login-password" --type "SecureString" --value "<Basic認証パスワード>" --overwrite
```

**これらのコマンドは自分のターミナルで直接実行し、値をチャット等に貼らないこと。** `base-url`/`sso-login-*`はSSTのstate外で運用者が管理するリソースのため、`sst deploy`/`sst remove`とは無関係にいつでも登録・更新・削除できる。

## 認証情報の準備（auth-token）

実ユーザーはSAML SSO（外部IdPとの実際のハンドシェイク）でログインするため、CI/k6からこのログイン自体を自動化することはできない。代わりに、**人間が一度だけ実際にSSOでログインしたセッションのCookie値を取得し、SSMへ登録**して使い回す。

1. 負荷試験専用のテストユーザー（実運用ユーザーのアカウントを流用しない）で、ブラウザから対象サイトへアクセスし、実際にSSOログインを完了する
2. DevTools（`Cmd + Option + I`）→ Application/Storage → Cookies → `auth_token` の値をコピーする
3. **コピーしたらすぐにそのタブを閉じる**（開いたままだとブラウザ自身がAPIリクエストのたびにセッションをリフレッシュし、コピーした値が数分〜数十分で無効化されることがある）
4. 値を登録する

   ```bash
   aws ssm put-parameter \
     --name "/k6env/load-test/ec2/qa/auth-token" \
     --type "SecureString" \
     --value "<コピーしたauth_tokenの値>" \
     --overwrite
   ```

5. セッションは想定では最大14日程度有効とされるが、**実際にはブラウザタブの状態次第でもっと早く無効化されることがある**（本Runbook作成時にも数十分で切れた実績あり）。負荷試験がCIで401系の失敗をし始めたら、まずこの手順を再実行すること

## 通常の使い方

### 1. 環境作成（`infra_action=deploy`）

1. GitHub → Actions タブ → **Load Test EC2 (k6 on EC2)** → **Run workflow**
2. 入力
   - **Use workflow from**: `main`
   - **scenario**: `smoke-rest`
   - **infra_action**: `deploy`
   - **confirm_remove**: 空欄
3. **Run workflow** を押す
4. `infra-deploy` ジョブが緑になれば完了

> 同じrun内で `run-load-test` も自動的に実行される（deployのついでに1回試験も走る仕様）。infra作成直後は`auth-token`が古い/未設定だと、この分は失敗して当然なので気にしなくてよい（後述のトラブルシューティング参照）。

### 2. テスト実行（`infra_action=none`）

1. 再度 **Run workflow**
2. 入力
   - **scenario**: `smoke-rest`
   - **infra_action**: `none`
3. runを開き、`run-load-test` ジョブの完了を待つ（EC2起動〜k6実行〜結果アップロードで数分程度）

### 3. 結果の確認

`run-load-test` ジョブの **Summary** タブ（各ジョブのログ画面とは別の場所。runページ上部・下部で確認できる集計情報）に以下が表示される。

```
## 実行結果
- test_run_id: `<run_id>-<attempt>`
- exit_code: `0`
- 結果: `s3://k6env-load-test-ec2-bucket-qa/results/<test_run_id>/summary.json`
- ログ: `s3://k6env-load-test-ec2-bucket-qa/results/<test_run_id>/user-data.log`
```

- **`summary.json`**: k6の集計結果（`checks`合格率、`http_req_failed`率、レイテンシp95等）。AWSコンソールのS3からダウンロードして見る
- **`user-data.log`**: インスタンス上で実行された全ログ（k6実行時のターミナル出力がそのまま入っている、人間が読みやすい形式）。何が起きたか把握したいときはまずこれを見る

### 4. インフラ削除（`infra_action=remove`、承認が必要）

1. **Run workflow**
2. 入力
   - **infra_action**: `remove`
   - **confirm_remove**: 半角大文字で `REMOVE`（無いと失敗する仕様）
3. runを開くと、`infra-diff` ジョブ完了後、`infra-remove` ジョブが **Waiting** 状態で止まる
4. runページ**上部**に出る`::warning::`（削除対象の要約）と、**下部のSummary**（詳細な一覧表）を確認する
5. 問題なければ **Review deployments** から `load-test-ec2-remove` にチェックを入れて **Approve and deploy**
6. 承認後、`infra-remove` ジョブが自動的に走り、緑チェックで完了すれば削除完了

削除されるのはSSTが管理するインフラ（VPC・EC2・S3・IAMロール等）のみ。`/k6env/load-test/ec2/qa/*` のSSMパラメータ（base-url等）はSSTのstate外のため削除されない。不要になった場合は`aws ssm delete-parameter`で別途消す。

## トラブルシューティング

| 症状 | 原因・対処 |
|---|---|
| `run-load-test`が`exit code 99`で失敗、`summary.json`の`checks`が66%程度・`http_req_failed`が50%程度 | `auth-token`の期限切れ。認証不要な`/api/test`は成功するが、認証が必要な`/api/me`だけ失敗するため、ちょうど半分が失敗する。「認証情報の準備」を再実行する |
| `infra-deploy`は成功しているのに全体が失敗と表示される | `infra_action=deploy`は同じrun内で`run-load-test`も実行する仕様。`infra-deploy`ジョブ単体の結果を確認すること（成功していればインフラ作成自体は問題ない） |
| `Check k6 exit code`で`exit_code が見つからない` | インスタンスの起動処理自体が失敗した可能性。`user-data.log`を確認する。まず`infra_action=deploy`を実行済みか確認する |
| `run-instances`が`InvalidParameterCombination`で失敗 | Launch Templateとrun-instances呼び出し側でネットワーク設定が重複していないか確認（コード側の問題。通常発生しない） |
| ワークフローを実行しても`pending`のまま進まない | 同時実行制御（`concurrency`）により、前のrunが`waiting`（承認待ち）のまま残っていると新しいrunがブロックされる。前のrunを承認するか、却下してから再実行する |
| `infra_action=remove`が承認なしで即実行された | `load-test-ec2-remove` EnvironmentにRequired reviewersが設定されていない。Settings > Environments で設定する |
| 削除対象の一覧が見当たらない | ジョブの**ログ**（各ステップを展開した画面）ではなく、runページの**Summary**セクション（上部の`::warning::`、下部の詳細一覧）を見ること |

## 既知の制約

- **EC2インスタンスはオンデマンド起動**: 実行のたびに`run-instances`で新規起動し、終了後は自身が`shutdown -h now`で終了する（常時起動ではない）
- **Elastic IPは常時課金**: デプロイしている間はインスタンスの有無に関わらず課金される（NAT Gatewayより大幅に安いが、使い終わったら`infra_action=remove`で消すこと）
- **auth-tokenは手動更新が必要**: SAML SSOの実ログインを自動化できないため、人間が定期的に取得し直す必要がある。想定より早く無効化されることがある点に注意
- **REST合否条件（thresholds）は暫定値**: `smoke-rest.js`内の`http_req_failed: rate<0.1`・`p(95)<5000`等は仮の値

## 関連ファイル

- ワークフロー: `.github/workflows/load-test-ec2-qa.yml`
- インフラコード: `infra/src/services/load-test-ec2/`, `infra/src/stacks/load-test-ec2.ts`
- 起動スクリプト: `load-test-ec2/user-data.sh`（ブートストラップ）, `load-test-ec2/scripts/run-load-test.sh`（k6実行本体）
- シナリオ: `load-test/scenarios/smoke-rest.js`（ECS版と共有）

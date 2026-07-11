/// <reference path="../../../../load-test/.sst/platform/config.d.ts" />
import { err, ok, type Result } from "neverthrow";
import { RESOURCE_ID_PREFIX } from "../../config/constants";
import { awsError, type InfraError } from "../../config/error";

/** 結果JSONの自動削除までの日数。生ログの長期保管は不要なため短期保管でよい */
const RESULTS_LIFECYCLE_EXPIRATION_DAYS = 30;

/**
 * Load Test Bucket Resources
 *
 * k6負荷試験のシナリオファイル同期・結果JSON保存用の S3 バケット。
 */
export type LoadTestBucketResources = {
  bucket: sst.aws.Bucket;
};

/**
 * k6負荷試験用の S3 バケットを作成する。
 *
 * @remarks
 * - scenarios/ プレフィックス: GitHub Actions がリポジトリの load-test/scenarios/ を同期する（正はGit）
 * - results/ プレフィックス: ECS Fargateタスクが k6 の結果JSONをアップロードする
 * - SSE-S3（AES256）で暗号化、HTTPS通信を強制、パブリックアクセスは全ブロック
 * - results/ は {@link RESULTS_LIFECYCLE_EXPIRATION_DAYS} 日で自動削除
 */
export const createLoadTestBucket = (
  stage: string,
): Result<LoadTestBucketResources, InfraError> => {
  const prefix = `${RESOURCE_ID_PREFIX}-load-test-bucket`;
  const bucketName = `${prefix}-${stage}`;

  try {
    const bucket = new sst.aws.Bucket(`${prefix}-${stage}`, {
      transform: {
        bucket: {
          bucket: bucketName,
          // sst remove 時、results/scenarios にオブジェクトが残っていても削除できるようにする
          // （検証用・恒久データを持たないバケットのため強制削除を許容する）
          forceDestroy: true,
          serverSideEncryptionConfiguration: {
            rule: {
              applyServerSideEncryptionByDefault: {
                sseAlgorithm: "AES256",
              },
            },
          },
        },
        policy: {
          policy: $jsonStringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Deny",
                Action: ["s3:*"],
                Resource: [
                  `arn:aws:s3:::${bucketName}`,
                  `arn:aws:s3:::${bucketName}/*`,
                ],
                Principal: { AWS: "*" },
                Condition: { Bool: { "aws:SecureTransport": "false" } },
              },
            ],
          }),
        },
      },
    });

    new aws.s3.BucketLifecycleConfiguration(
      `${prefix}-lifecycle-configuration-${stage}`,
      {
        bucket: bucket.name,
        rules: [
          {
            id: `${prefix}-results-lifecycle-rule-${stage}`,
            status: "Enabled",
            expiration: { days: RESULTS_LIFECYCLE_EXPIRATION_DAYS },
            filter: { prefix: "results/" },
          },
        ],
      },
    );

    return ok({ bucket });
  } catch (error) {
    return err(awsError("Failed to create load test bucket resources", error));
  }
};

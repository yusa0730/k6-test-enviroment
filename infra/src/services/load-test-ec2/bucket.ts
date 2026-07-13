/// <reference path="../../../../load-test-ec2/.sst/platform/config.d.ts" />
import { err, ok, type Result } from "neverthrow";
import { RESOURCE_ID_PREFIX } from "../../config/constants";
import { awsError, type InfraError } from "../../config/error";

/** 結果JSON・ログの自動削除までの日数 */
const RESULTS_LIFECYCLE_EXPIRATION_DAYS = 30;

/**
 * Load Test EC2 Bucket Resources
 *
 * k6負荷試験（EC2版）のシナリオファイル同期・結果保存用のS3バケット。
 * ECS版のbucket.tsと役割は同じだが、ECS版のバケットとは独立させている。
 */
export type LoadTestEc2BucketResources = {
  bucket: sst.aws.Bucket;
};

/**
 * k6負荷試験（EC2版）用のS3バケットを作成する。
 *
 * @remarks
 * - scenarios/ プレフィックス: GitHub Actionsがリポジトリのload-test/scenarios/を同期する（ECS版と同じシナリオを共有）
 * - results/ プレフィックス: EC2インスタンスのuser-dataがk6の結果JSON・exit_code・実行ログをアップロードする
 *   （EC2にはECS Fargateのようなタスク終了コード取得APIが無いため、exit_codeを明示的にファイルとして残す）
 */
export const createLoadTestEc2Bucket = (
  stage: string,
): Result<LoadTestEc2BucketResources, InfraError> => {
  const prefix = `${RESOURCE_ID_PREFIX}-load-test-ec2-bucket`;
  const bucketName = `${prefix}-${stage}`;

  try {
    const bucket = new sst.aws.Bucket(`${prefix}-${stage}`, {
      transform: {
        bucket: {
          bucket: bucketName,
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
    return err(
      awsError("Failed to create load test ec2 bucket resources", error),
    );
  }
};

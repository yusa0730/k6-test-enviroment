/// <reference path="../../../../load-test-ec2/.sst/platform/config.d.ts" />
import { err, ok, type Result } from "neverthrow";
import { awsError, type InfraError } from "../../config/error";

/**
 * Load Test EC2 Instance Role Resources
 *
 * EC2上でk6を実行するインスタンス用のIAMロール（ECS版のtask-role.tsに相当）。
 * EC2はコンテナではないため Task Role / Task Execution Role の区別が無く、
 * インスタンスロール1つで完結する（ECRからのpullも発生しないため、その権限も不要）。
 */
export type LoadTestEc2InstanceRoleResources = {
  /** インスタンスロール本体 */
  role: aws.iam.Role;
  /** EC2に紐付けるインスタンスプロファイル */
  instanceProfile: aws.iam.InstanceProfile;
};

/**
 * k6負荷試験（EC2版）インスタンス用のIAMロールを作成する。
 *
 * @param prefix - リソース名のプレフィックス
 * @param stage - デプロイステージ
 * @param bucketArn - シナリオ同期・結果アップロード用S3バケットのARN
 * @param ssmParameterPrefix - 負荷試験用トークンを格納するSSM Parameterのパスprefix
 *
 * @remarks
 * 権限:
 * - S3: scenarios/* の読み取り、results/* への書き込み（結果JSON・実行ログ・exit_codeファイル）
 * - SSM: 負荷試験用トークンの取得（読み取り専用、対象パス配下に限定）
 * - SSM Session Manager: AL2023はSSM Agentがプリインストールされているため、この権限だけで
 *   ポート開放無しにSession Manager接続でデバッグできる（ECS Execに相当）
 *
 * インスタンスの自己終了は `ec2:TerminateInstances` 権限を使わず、OS側の `shutdown -h now` +
 * launch templateの `InstanceInitiatedShutdownBehavior: terminate` で行うため、その権限は含めない。
 */
export const createLoadTestEc2InstanceRole = (
  prefix: string,
  stage: string,
  bucketArn: $util.Output<string>,
  ssmParameterPrefix: string,
): Result<LoadTestEc2InstanceRoleResources, InfraError> => {
  const idPrefix = `${prefix}-instance`;

  try {
    const role = new aws.iam.Role(`${idPrefix}-role-${stage}`, {
      name: `${idPrefix}-role-${stage}`,
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ec2.amazonaws.com",
      }),
      inlinePolicies: [
        {
          name: `${idPrefix}-role-policy-${stage}`,
          policy: $jsonStringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["s3:ListBucket"],
                Resource: [$interpolate`${bucketArn}`],
                Condition: {
                  StringLike: { "s3:prefix": ["scenarios/*", "results/*"] },
                },
              },
              {
                Effect: "Allow",
                Action: ["s3:GetObject"],
                Resource: [$interpolate`${bucketArn}/scenarios/*`],
              },
              {
                Effect: "Allow",
                Action: ["s3:PutObject"],
                Resource: [$interpolate`${bucketArn}/results/*`],
              },
              {
                Effect: "Allow",
                Action: ["ssm:GetParameter", "ssm:GetParameters"],
                Resource: [`arn:aws:ssm:*:*:parameter${ssmParameterPrefix}`],
              },
              {
                Effect: "Allow",
                Action: [
                  "ssmmessages:CreateControlChannel",
                  "ssmmessages:CreateDataChannel",
                  "ssmmessages:OpenControlChannel",
                  "ssmmessages:OpenDataChannel",
                  "ec2messages:GetMessages",
                  "ec2messages:AcknowledgeMessage",
                  "ssm:UpdateInstanceInformation",
                ],
                Resource: ["*"],
              },
            ],
          }),
        },
      ],
      tags: { Name: `${idPrefix}-role-${stage}` },
    });

    const instanceProfile = new aws.iam.InstanceProfile(
      `${idPrefix}-profile-${stage}`,
      {
        name: `${idPrefix}-profile-${stage}`,
        role: role.name,
      },
    );

    return ok({ role, instanceProfile });
  } catch (error) {
    return err(
      awsError(
        `${idPrefix}-${stage}: Failed to create load test ec2 instance role`,
        error,
      ),
    );
  }
};

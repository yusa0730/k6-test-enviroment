/// <reference path="../../../../load-test/.sst/platform/config.d.ts" />
import { err, ok, type Result } from "neverthrow";
import { awsError, type InfraError } from "../../config/error";

/**
 * Load Test Task Role Resources
 *
 * ECS Fargate上でk6を実行するタスク用のIAMロール。
 */
export type LoadTestTaskRoleResources = {
  /** タスクロール（コンテナ実行時） */
  taskRole: aws.iam.Role;
  /** タスク実行ロール（コンテナ起動時） */
  taskExecutionRole: aws.iam.Role;
};

/**
 * k6負荷試験Fargateタスク用のIAMロールを作成する。
 *
 * @param prefix - リソース名のプレフィックス
 * @param stage - デプロイステージ
 * @param bucketArn - シナリオ同期・結果アップロード用S3バケットのARN
 * @param ssmParameterPrefix - 負荷試験用トークンを格納するSSM Parameterのパスprefix（例: /k6env/load-test/qa/*）
 *
 * @remarks
 * Task Roleの権限:
 * - S3: scenarios/* の読み取り、results/* への書き込み
 * - SSM: 負荷試験用トークンの取得（読み取り専用、対象パス配下に限定）
 * - SSM Session Manager: ECS Exec用（デバッグ時の接続確立）
 *
 * Task Execution Roleの権限:
 * - 基本: AmazonECSTaskExecutionRolePolicy（CloudWatch Logs・ECR pull）
 */
export const createLoadTestTaskRole = (
  prefix: string,
  stage: string,
  bucketArn: $util.Output<string>,
  ssmParameterPrefix: string,
): Result<LoadTestTaskRoleResources, InfraError> => {
  const idPrefix = `${prefix}-task`;

  try {
    const taskRole = new aws.iam.Role(`${idPrefix}-role-${stage}`, {
      name: `${idPrefix}-role-${stage}`,
      assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
        Service: "ecs-tasks.amazonaws.com",
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
                ],
                Resource: ["*"],
              },
            ],
          }),
        },
      ],
      tags: { Name: `${idPrefix}-role-${stage}` },
    });

    const taskExecutionRole = new aws.iam.Role(
      `${idPrefix}-execution-role-${stage}`,
      {
        name: `${idPrefix}-execution-role-${stage}`,
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
          Service: "ecs-tasks.amazonaws.com",
        }),
        managedPolicyArns: [
          "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
        ],
        tags: { Name: `${idPrefix}-execution-role-${stage}` },
      },
    );

    return ok({ taskRole, taskExecutionRole });
  } catch (error) {
    return err(
      awsError(`${idPrefix}-${stage}: Failed to create load test task role`, error),
    );
  }
};

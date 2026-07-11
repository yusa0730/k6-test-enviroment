/// <reference path="../../../../load-test/.sst/platform/config.d.ts" />
import { err, ok, type Result } from "neverthrow";
import { env } from "../../config/environments";
import { awsError, type InfraError } from "../../config/error";

/**
 * Load Test Fargate Resources
 *
 * k6を実行するECSクラスターとタスク定義（Serviceは作らない。GitHub Actionsから
 * aws ecs run-task でオンデマンド起動する一回限りのバッチ実行のため）。
 */
export type LoadTestFargateResources = {
  cluster: aws.ecs.Cluster;
  taskDefinition: aws.ecs.TaskDefinition;
  logGroup: aws.cloudwatch.LogGroup;
};

/**
 * k6負荷試験用のECSクラスター・タスク定義を作成する。
 *
 * @remarks
 * - Service は作らない。実行のたびに GitHub Actions ワークフローが aws ecs run-task で起動する
 * - cpu/memory は 5〜10 VU の軽量スモーク向けの初期値（0.5 vCPU / 1 GB）。本格負荷では
 *   タスク定義側の cpu/memory を引き上げる（Fargate単一タスクの上限は 16 vCPU / 120 GB）
 * - シナリオ名・対象URL・スタブ切替等は固定値にせず、GitHub Actions側の run-task --overrides
 *   でコンテナ起動時に注入する（同じタスク定義を使い回すため）
 */
export const createLoadTestFargate = (
  prefix: string,
  stage: string,
  ecs: {
    taskRoleArn: $util.Output<string>;
    executionRoleArn: $util.Output<string>;
    image: aws.ecr.GetImageResult | undefined;
    repositoryName: $util.Output<string>;
    accountId: string;
    bucketName: $util.Output<string>;
    ssmParameterPrefix: string;
  },
): Result<LoadTestFargateResources, InfraError> => {
  const idPrefix = `${prefix}-fargate`;

  try {
    const logGroup = new aws.cloudwatch.LogGroup(
      `${idPrefix}-log-group-${stage}`,
      {
        name: `/aws/ecs/service/${idPrefix}-${stage}`,
        retentionInDays: env.log.retentionInDays,
      },
    );

    const cluster = new aws.ecs.Cluster(`${idPrefix}-cluster-${stage}`, {
      name: `${idPrefix}-cluster-${stage}`,
      tags: { Name: `${idPrefix}-cluster-${stage}` },
    });

    const taskDefinition = new aws.ecs.TaskDefinition(
      `${idPrefix}-task-definition-${stage}`,
      {
        family: `${idPrefix}-task-definition-${stage}`,
        trackLatest: true,
        // 5〜10 VU の軽量スモーク用（0.5 vCPU / 1 GB）
        cpu: "512",
        memory: "1024",
        networkMode: "awsvpc",
        requiresCompatibilities: ["FARGATE"],
        runtimePlatform: {
          cpuArchitecture: "X86_64",
          operatingSystemFamily: "LINUX",
        },
        executionRoleArn: ecs.executionRoleArn,
        taskRoleArn: ecs.taskRoleArn,
        containerDefinitions: $util
          .all([ecs.repositoryName, ecs.bucketName])
          .apply(([repositoryName, bucketName]) =>
            $jsonStringify([
              {
                name: `${idPrefix}-k6-${stage}`,
                image: ecs.image
                  ? `${ecs.accountId}.dkr.ecr.${env.aws.mainRegion}.amazonaws.com/${repositoryName}:${ecs.image.imageTag ?? "latest"}`
                  : `${ecs.accountId}.dkr.ecr.${env.aws.mainRegion}.amazonaws.com/${repositoryName}:latest`,
                essential: true,
                logConfiguration: {
                  logDriver: "awslogs",
                  options: {
                    "awslogs-region": env.aws.mainRegion,
                    "awslogs-group": logGroup.name,
                    "awslogs-stream-prefix": "/load-test",
                  },
                },
                environment: [
                  { name: "AWS_REGION", value: env.aws.mainRegion },
                  { name: "RESULTS_BUCKET_NAME", value: bucketName },
                  // 負荷試験用トークンの取得先。実際の値はコンテナが実行時にSSMから取得する
                  { name: "SSM_PARAMETER_PREFIX", value: ecs.ssmParameterPrefix },
                ],
              },
            ]),
          ),
      },
    );

    return ok({ cluster, taskDefinition, logGroup });
  } catch (error) {
    return err(
      awsError(`${idPrefix}-${stage}: Failed to create load test fargate`, error),
    );
  }
};

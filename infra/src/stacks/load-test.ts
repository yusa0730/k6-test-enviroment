/// <reference path="../../../load-test/.sst/platform/config.d.ts" />
import { err, ok, type Result } from "neverthrow";
import { RESOURCE_ID_PREFIX } from "../config/constants";
import type { InfraError } from "../config/error";
import { createLoadTestBucket } from "../services/load-test/bucket";
import { createLoadTestFargate } from "../services/load-test/fargate";
import { createLoadTestNetwork } from "../services/load-test/network";
import { createLoadTestRepository } from "../services/load-test/repository";
import { createLoadTestTaskRole } from "../services/load-test/task-role";

/**
 * Load Test Stack
 *
 * k6負荷試験実行基盤専用のSSTスタック。既存アプリとは独立したVPC・ECSクラスターを持つ
 * （負荷は対象サイトの公開エンドポイント経由でかけるため、既存VPCへのピアリングは不要）。
 */
export type LoadTestStackResult = {
  clusterName: $util.Output<string>;
  taskDefinitionArn: $util.Output<string>;
  subnetId: $util.Output<string>;
  securityGroupId: $util.Output<string>;
  bucketName: $util.Output<string>;
  tokenParameterName: $util.Output<string>;
};

export const loadTestStack = async (): Promise<
  Result<LoadTestStackResult, InfraError>
> => {
  const prefix = `${RESOURCE_ID_PREFIX}-load-test`;
  const stage = $app.stage;
  const ssmParameterPrefix = `/${RESOURCE_ID_PREFIX}/load-test/${stage}`;

  const awsAccountId = await aws
    .getCallerIdentity({})
    .then((id) => id.accountId);

  const network = createLoadTestNetwork(stage);
  if (network.isErr()) {
    return err(network.error);
  }

  const bucket = createLoadTestBucket(stage);
  if (bucket.isErr()) {
    return err(bucket.error);
  }

  const repository = await createLoadTestRepository(stage);
  if (repository.isErr()) {
    return err(repository.error);
  }

  const taskRole = createLoadTestTaskRole(
    prefix,
    stage,
    bucket.value.bucket.arn,
    `${ssmParameterPrefix}/*`,
    awsAccountId,
  );
  if (taskRole.isErr()) {
    return err(taskRole.error);
  }

  const fargate = createLoadTestFargate(prefix, stage, {
    taskRoleArn: taskRole.value.taskRole.arn,
    executionRoleArn: taskRole.value.taskExecutionRole.arn,
    image: repository.value.image,
    repositoryName: repository.value.repository.name,
    accountId: awsAccountId,
    bucketName: bucket.value.bucket.name,
    ssmParameterPrefix,
  });
  if (fargate.isErr()) {
    return err(fargate.error);
  }

  // 負荷試験用トークン。httpbin.org の /headers に付けて「SSMから取得した資格情報を使う」
  // 構成上のパターン（画像の「Parameter StoreからAPI Keyを取得」）を再現するための検証用の値。
  // 実際に外部を認証するものではないため、機微情報ではない固定値でよい。
  const tokenParameter = new aws.ssm.Parameter(
    `${prefix}-token-parameter-${stage}`,
    {
      name: `${ssmParameterPrefix}/load-test-token`,
      type: "SecureString",
      value: "k6-load-test-demo-token",
      tags: { Name: `${prefix}-token-parameter-${stage}` },
    },
  );

  return ok({
    clusterName: fargate.value.cluster.name,
    taskDefinitionArn: fargate.value.taskDefinition.arn,
    subnetId: network.value.privateSubnet.id,
    securityGroupId: network.value.securityGroup.id,
    bucketName: bucket.value.bucket.name,
    tokenParameterName: tokenParameter.name,
  });
};

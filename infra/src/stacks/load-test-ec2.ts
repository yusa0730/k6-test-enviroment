/// <reference path="../../../load-test-ec2/.sst/platform/config.d.ts" />
import { err, ok, type Result } from "neverthrow";
import { RESOURCE_ID_PREFIX } from "../config/constants";
import type { InfraError } from "../config/error";
import { createLoadTestEc2Bucket } from "../services/load-test-ec2/bucket";
import { createLoadTestEc2InstanceRole } from "../services/load-test-ec2/instance-role";
import { createLoadTestEc2LaunchTemplate } from "../services/load-test-ec2/launch-template";
import { createLoadTestEc2Network } from "../services/load-test-ec2/network";

/**
 * Load Test EC2 Stack
 *
 * k6負荷試験実行基盤（EC2版）専用のSSTスタック。ECS版（stacks/load-test.ts）とは
 * 完全に独立したリソース一式を持つ（同時に存在させても衝突しない）。ECS版のコードは
 * 一切変更していない。EC2 と ECS のどちらでk6負荷試験基盤を構築するかを比較できるように、
 * 同じ役割（VPC・S3・IAM・実行基盤）を並行して用意している。
 */
export type LoadTestEc2StackResult = {
  launchTemplateId: $util.Output<string>;
  subnetId: $util.Output<string>;
  securityGroupId: $util.Output<string>;
  bucketName: $util.Output<string>;
  eipAllocationId: $util.Output<string>;
  tokenParameterName: $util.Output<string>;
};

export const loadTestEc2Stack = async (): Promise<
  Result<LoadTestEc2StackResult, InfraError>
> => {
  const prefix = `${RESOURCE_ID_PREFIX}-load-test-ec2`;
  const stage = $app.stage;
  // ECS版と衝突しないよう /k6env/load-test/ec2/ 配下に置く
  const ssmParameterPrefix = `/${RESOURCE_ID_PREFIX}/load-test/ec2/${stage}`;

  const network = createLoadTestEc2Network(stage);
  if (network.isErr()) {
    return err(network.error);
  }

  const bucket = createLoadTestEc2Bucket(stage);
  if (bucket.isErr()) {
    return err(bucket.error);
  }

  const instanceRole = createLoadTestEc2InstanceRole(
    prefix,
    stage,
    bucket.value.bucket.arn,
    `${ssmParameterPrefix}/*`,
  );
  if (instanceRole.isErr()) {
    return err(instanceRole.error);
  }

  const launchTemplate = createLoadTestEc2LaunchTemplate(prefix, stage, {
    subnetId: network.value.publicSubnet.id,
    securityGroupId: network.value.securityGroup.id,
    instanceProfileName: instanceRole.value.instanceProfile.name,
  });
  if (launchTemplate.isErr()) {
    return err(launchTemplate.error);
  }

  // 負荷試験用トークン。ECS版と同様、httpbin.org の /headers に付けて
  // 「SSMから取得した資格情報を使う」構成パターンを再現するための検証用の値。
  const tokenParameter = new aws.ssm.Parameter(
    `${prefix}-token-parameter-${stage}`,
    {
      name: `${ssmParameterPrefix}/load-test-token`,
      type: "SecureString",
      value: "k6-load-test-ec2-demo-token",
      tags: { Name: `${prefix}-token-parameter-${stage}` },
    },
  );

  return ok({
    launchTemplateId: launchTemplate.value.launchTemplate.id,
    subnetId: network.value.publicSubnet.id,
    securityGroupId: network.value.securityGroup.id,
    bucketName: bucket.value.bucket.name,
    eipAllocationId: network.value.eip.id,
    tokenParameterName: tokenParameter.name,
  });
};

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
  ssmParameterPrefix: string;
};

export const loadTestEc2Stack = async (): Promise<
  Result<LoadTestEc2StackResult, InfraError>
> => {
  const prefix = `${RESOURCE_ID_PREFIX}-load-test-ec2`;
  const stage = $app.stage;
  // ECS版と衝突しないよう /k6env/load-test/ec2/ 配下に置く
  const ssmParameterPrefix = `/${RESOURCE_ID_PREFIX}/load-test/ec2/${stage}`;

  const awsAccountId = await aws
    .getCallerIdentity({})
    .then((id) => id.accountId);

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
    awsAccountId,
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

  // 対象URL・SSOログイン情報・SAMLセッションCookie等の実値はコードに一切書かない。
  // instanceRole は ${ssmParameterPrefix}/* への読み取り権限だけを持ち、実際の
  // パラメータ（base-url / origin / sso-login-id / sso-login-password / auth-token）は
  // `aws ssm put-parameter` で運用者が別途登録する（README.mdのEC2版セクション参照）。

  return ok({
    launchTemplateId: launchTemplate.value.launchTemplate.id,
    subnetId: network.value.publicSubnet.id,
    securityGroupId: network.value.securityGroup.id,
    bucketName: bucket.value.bucket.name,
    eipAllocationId: network.value.eip.id,
    ssmParameterPrefix,
  });
};

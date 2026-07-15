/// <reference path="../../../../load-test-ec2/.sst/platform/config.d.ts" />
import { err, ok, type Result } from "neverthrow";
import { awsError, type InfraError } from "../../config/error";

/**
 * Load Test EC2 Launch Template Resources
 *
 * k6を実行するEC2インスタンスの起動テンプレート（ECS版のtask-definitionに相当）。
 * 常時起動のインスタンスは作らない。実行のたびにGitHub Actionsが aws ec2 run-instances で
 * このテンプレートを使ってオンデマンド起動する一回限りのバッチ実行のため。
 */
export type LoadTestEc2LaunchTemplateResources = {
  launchTemplate: aws.ec2.LaunchTemplate;
};

/**
 * k6負荷試験（EC2版）用のLaunch Templateを作成する。
 *
 * @remarks
 * - AMIはAmazon Linux 2023の最新版をSSM Public Parameterから解決する（固定AMI IDをコードに書かない）
 * - instanceType は 5〜10 VU の軽量スモーク向けに t3.small（2 vCPU burstable / 2 GiB）
 * - InstanceInitiatedShutdownBehavior: terminate にすることで、user-data内の `shutdown -h now` が
 *   そのままインスタンス終了（課金停止）になる。ec2:TerminateInstances権限をインスタンス自身に
 *   持たせる必要がない
 * - user-data はテンプレート側にはプレースホルダーを置かず、GitHub Actions側で
 *   run-instances 実行時に `--user-data` で毎回上書きする（同じテンプレートを使い回すため）
 */
export const createLoadTestEc2LaunchTemplate = (
  prefix: string,
  stage: string,
  ec2: {
    subnetId: $util.Output<string>;
    securityGroupId: $util.Output<string>;
    instanceProfileName: $util.Output<string>;
  },
): Result<LoadTestEc2LaunchTemplateResources, InfraError> => {
  const idPrefix = prefix;

  try {
    const ami = aws.ssm.getParameterOutput({
      name: "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
    });

    const launchTemplate = new aws.ec2.LaunchTemplate(
      `${idPrefix}-launch-template-${stage}`,
      {
        name: `${idPrefix}-launch-template-${stage}`,
        imageId: ami.value,
        instanceType: "t3.small",
        iamInstanceProfile: {
          name: ec2.instanceProfileName,
        },
        instanceInitiatedShutdownBehavior: "terminate",
        networkInterfaces: [
          {
            deviceIndex: 0,
            subnetId: ec2.subnetId,
            securityGroups: [ec2.securityGroupId],
            // EIPは起動後にGitHub Actions側でassociateするため、ここでは自動割当publicIPは付けない
            associatePublicIpAddress: "false",
          },
        ],
        tagSpecifications: [
          {
            resourceType: "instance",
            tags: { Name: `${idPrefix}-instance-${stage}` },
          },
        ],
        tags: { Name: `${idPrefix}-launch-template-${stage}` },
      },
    );

    return ok({ launchTemplate });
  } catch (error) {
    return err(
      awsError(
        `${idPrefix}-${stage}: Failed to create load test ec2 launch template`,
        error,
      ),
    );
  }
};

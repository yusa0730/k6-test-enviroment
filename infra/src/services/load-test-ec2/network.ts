/// <reference path="../../../../load-test-ec2/.sst/platform/config.d.ts" />
import { err, ok, type Result } from "neverthrow";
import { RESOURCE_ID_PREFIX } from "../../config/constants";
import { env } from "../../config/environments";
import { awsError, type InfraError } from "../../config/error";

/**
 * Load Test EC2 Network Resources
 *
 * k6負荷試験実行基盤（EC2版）専用の最小VPC。
 */
export type LoadTestEc2NetworkResources = {
  /** VPC 本体 */
  vpc: aws.ec2.Vpc;
  /** パブリックサブネット（EC2インスタンスの配置先） */
  publicSubnet: aws.ec2.Subnet;
  /** EC2インスタンス用セキュリティグループ（egressのみ許可） */
  securityGroup: aws.ec2.SecurityGroup;
  /** 固定送信元IP用のElastic IP（インスタンス起動のたびにGitHub Actions側でassociateする） */
  eip: aws.ec2.Eip;
};

/**
 * k6負荷試験（EC2版）用の独立したVPCを作成する。
 *
 * @remarks
 * ECS版はNAT Gatewayで送信元IPを固定していたが、EC2の場合はインスタンスをpublic subnetに直接置き、
 * Elastic IPをassociateするだけで同じ「送信元IP固定」が実現できる。NAT Gateway（時間課金＋データ処理課金）
 * が不要になり、コストはEIP分（起動中のインスタンス1台ぶん、時間課金のみ）だけで済む。
 * そのためNAT Gateway・private subnetは作らない。
 */
export const createLoadTestEc2Network = (
  stage: string,
): Result<LoadTestEc2NetworkResources, InfraError> => {
  const prefix = `${RESOURCE_ID_PREFIX}-load-test-ec2`;
  const availabilityZone = `${env.aws.mainRegion}a`;

  try {
    const vpc = new aws.ec2.Vpc(`${prefix}-vpc-${stage}`, {
      cidrBlock: "10.101.0.0/16",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: { Name: `${prefix}-vpc-${stage}`, ManagedBy: "k6env-load-test-ec2" },
    });

    const internetGateway = new aws.ec2.InternetGateway(
      `${prefix}-internet-gateway-${stage}`,
      {
        vpcId: vpc.id,
        tags: { Name: `${prefix}-internet-gateway-${stage}`, ManagedBy: "k6env-load-test-ec2" },
      },
    );

    const publicSubnet = new aws.ec2.Subnet(
      `${prefix}-public-subnet-${stage}`,
      {
        vpcId: vpc.id,
        cidrBlock: "10.101.0.0/24",
        availabilityZone,
        mapPublicIpOnLaunch: false,
        tags: { Name: `${prefix}-public-subnet-${stage}`, ManagedBy: "k6env-load-test-ec2" },
      },
    );

    const publicRouteTable = new aws.ec2.RouteTable(
      `${prefix}-public-route-table-${stage}`,
      {
        vpcId: vpc.id,
        tags: { Name: `${prefix}-public-route-table-${stage}`, ManagedBy: "k6env-load-test-ec2" },
      },
    );

    new aws.ec2.Route(`${prefix}-public-default-route-${stage}`, {
      routeTableId: publicRouteTable.id,
      gatewayId: internetGateway.id,
      destinationCidrBlock: "0.0.0.0/0",
    });

    new aws.ec2.RouteTableAssociation(
      `${prefix}-public-route-table-association-${stage}`,
      {
        routeTableId: publicRouteTable.id,
        subnetId: publicSubnet.id,
      },
    );

    // 固定送信元IP用のEIP。インスタンス自体には紐付けず「予約」だけしておき、
    // 実行のたびにGitHub Actions側で run-instances 直後に associate-address する。
    const eip = new aws.ec2.Eip(`${prefix}-eip-${stage}`, {
      domain: "vpc",
      tags: { Name: `${prefix}-eip-${stage}`, ManagedBy: "k6env-load-test-ec2" },
    });

    // security group（ingress不要、egressのみ許可。SSM Session Managerもoutbound HTTPSのみで動く）
    const securityGroup = new aws.ec2.SecurityGroup(
      `${prefix}-security-group-${stage}`,
      {
        vpcId: vpc.id,
        description: "k6 load test EC2 instance (egress only)",
        egress: [
          {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
          },
        ],
        tags: { Name: `${prefix}-security-group-${stage}`, ManagedBy: "k6env-load-test-ec2" },
      },
    );

    return ok({ vpc, publicSubnet, securityGroup, eip });
  } catch (error) {
    return err(
      awsError("Failed to create load test ec2 network resources", error),
    );
  }
};

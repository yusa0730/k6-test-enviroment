/// <reference path="../../../../load-test/.sst/platform/config.d.ts" />
import { err, ok, type Result } from "neverthrow";
import { RESOURCE_ID_PREFIX } from "../../config/constants";
import { env } from "../../config/environments";
import { awsError, type InfraError } from "../../config/error";

/**
 * Load Test Network Resources
 *
 * k6負荷試験実行基盤（ECS Fargate）専用の最小VPC。
 */
export type LoadTestNetworkResources = {
  /** VPC 本体 */
  vpc: aws.ec2.Vpc;
  /** プライベートサブネット（Fargateタスクの配置先） */
  privateSubnet: aws.ec2.Subnet;
  /** Fargateタスク用セキュリティグループ（egressのみ許可） */
  securityGroup: aws.ec2.SecurityGroup;
};

/**
 * k6負荷試験用の独立したVPCを作成する。
 *
 * AWS resources:
 * - VPC: 10.100.0.0/16（既存VPCとは独立、ピアリング不要）
 * - Internet Gateway: パブリックサブネットの疎通用
 * - Public Subnet: NAT Gateway配置用（1 AZ）
 * - Private Subnet: Fargateタスク配置用（1 AZ）
 * - NAT Gateway + EIP: プライベートサブネットの egress を固定IP化（allowlist対応）
 * - Security Group: egressのみ許可（ingress不要。k6は対象URLへ発信するのみ）
 *
 * @remarks
 * 負荷は対象サイトの公開エンドポイント経由でかけるため、既存VPCへのピアリングは不要。
 * 単一AZ・単一Fargateタスクの構成（分散実行はしない）。
 */
export const createLoadTestNetwork = (
  stage: string,
): Result<LoadTestNetworkResources, InfraError> => {
  const prefix = `${RESOURCE_ID_PREFIX}-load-test`;
  const availabilityZone = `${env.aws.mainRegion}a`;

  try {
    const vpc = new aws.ec2.Vpc(`${prefix}-vpc-${stage}`, {
      cidrBlock: "10.100.0.0/16",
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: { Name: `${prefix}-vpc-${stage}` },
    });

    const internetGateway = new aws.ec2.InternetGateway(
      `${prefix}-internet-gateway-${stage}`,
      {
        vpcId: vpc.id,
        tags: { Name: `${prefix}-internet-gateway-${stage}` },
      },
    );

    // public subnet（NAT Gateway 配置用）
    const publicSubnet = new aws.ec2.Subnet(
      `${prefix}-public-subnet-${stage}`,
      {
        vpcId: vpc.id,
        cidrBlock: "10.100.0.0/24",
        availabilityZone,
        tags: { Name: `${prefix}-public-subnet-${stage}` },
      },
    );

    const publicRouteTable = new aws.ec2.RouteTable(
      `${prefix}-public-route-table-${stage}`,
      {
        vpcId: vpc.id,
        tags: { Name: `${prefix}-public-route-table-${stage}` },
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

    // EIP + NAT Gateway（プライベートサブネットの egress 送信元IPを固定する）
    const eip = new aws.ec2.Eip(`${prefix}-eip-${stage}`, {
      domain: "vpc",
      tags: { Name: `${prefix}-eip-${stage}` },
    });

    const natGateway = new aws.ec2.NatGateway(
      `${prefix}-nat-gateway-${stage}`,
      {
        allocationId: eip.id,
        subnetId: publicSubnet.id,
        tags: { Name: `${prefix}-nat-gateway-${stage}` },
      },
    );

    // private subnet（Fargateタスク配置先）
    const privateSubnet = new aws.ec2.Subnet(
      `${prefix}-private-subnet-${stage}`,
      {
        vpcId: vpc.id,
        cidrBlock: "10.100.1.0/24",
        availabilityZone,
        tags: { Name: `${prefix}-private-subnet-${stage}` },
      },
    );

    const privateRouteTable = new aws.ec2.RouteTable(
      `${prefix}-private-route-table-${stage}`,
      {
        vpcId: vpc.id,
        tags: { Name: `${prefix}-private-route-table-${stage}` },
      },
    );

    new aws.ec2.Route(`${prefix}-private-default-route-${stage}`, {
      routeTableId: privateRouteTable.id,
      natGatewayId: natGateway.id,
      destinationCidrBlock: "0.0.0.0/0",
    });

    new aws.ec2.RouteTableAssociation(
      `${prefix}-private-route-table-association-${stage}`,
      {
        routeTableId: privateRouteTable.id,
        subnetId: privateSubnet.id,
      },
    );

    // security group（ingress不要、egressのみ許可）
    const securityGroup = new aws.ec2.SecurityGroup(
      `${prefix}-security-group-${stage}`,
      {
        vpcId: vpc.id,
        description: "k6 load test Fargate task (egress only)",
        egress: [
          {
            protocol: "-1",
            fromPort: 0,
            toPort: 0,
            cidrBlocks: ["0.0.0.0/0"],
          },
        ],
        tags: { Name: `${prefix}-security-group-${stage}` },
      },
    );

    return ok({ vpc, privateSubnet, securityGroup });
  } catch (error) {
    return err(awsError("Failed to create load test network resources", error));
  }
};

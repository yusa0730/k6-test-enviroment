/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: `k6-test-env-load-test-ec2-${input?.stage}`,
      removal: "remove",
      home: "aws",
      providers: {
        aws: {
          region: "ap-northeast-1",
        },
      },
    };
  },
  async run() {
    try {
      const stack = await import("../infra/src/stacks/load-test-ec2");
      const result = await stack.loadTestEc2Stack();
      if (result.isErr()) {
        throw result.error;
      }

      return {
        launchTemplateId: result.value.launchTemplateId,
        subnetId: result.value.subnetId,
        securityGroupId: result.value.securityGroupId,
        bucketName: result.value.bucketName,
        eipAllocationId: result.value.eipAllocationId,
        ssmParameterPrefix: result.value.ssmParameterPrefix,
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
});

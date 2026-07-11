/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: `k6-test-env-load-test-${input?.stage}`,
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
      const stack = await import("../infra/src/stacks/load-test");
      const result = await stack.loadTestStack();
      if (result.isErr()) {
        throw result.error;
      }

      return {
        clusterName: result.value.clusterName,
        taskDefinitionArn: result.value.taskDefinitionArn,
        subnetId: result.value.subnetId,
        securityGroupId: result.value.securityGroupId,
        bucketName: result.value.bucketName,
        tokenParameterName: result.value.tokenParameterName,
      };
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
});

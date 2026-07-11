/// <reference path="../../../../load-test/.sst/platform/config.d.ts" />
import { err, ok, type Result } from "neverthrow";
import { RESOURCE_ID_PREFIX } from "../../config/constants";
import { awsError, type InfraError } from "../../config/error";

/**
 * Load Test Repository Resources
 *
 * k6負荷試験用コンテナイメージを格納する ECR リポジトリ。
 */
export type LoadTestRepositoryResources = {
  /** ECR リポジトリ */
  repository: aws.ecr.Repository;
  /** リポジトリ内の最新イメージ情報（存在しない場合は undefined） */
  image: aws.ecr.GetImageResult | undefined;
};

/**
 * k6負荷試験用の ECR リポジトリを作成する。
 *
 * @remarks
 * - k6本体バージョン更新など、コンテナイメージ変更時のみビルド・プッシュする（シナリオはS3同期のため毎回のビルド不要）
 * - Lifecycle Policy: タグなしイメージを 30 日後に自動削除
 */
export const createLoadTestRepository = async (
  stage: string,
): Promise<Result<LoadTestRepositoryResources, InfraError>> => {
  const prefix = `${RESOURCE_ID_PREFIX}-load-test-repository`;

  try {
    const repository = new aws.ecr.Repository(`${prefix}-${stage}`, {
      name: `${prefix}-${stage}`,
      imageTagMutability: "MUTABLE",
      imageScanningConfiguration: {
        scanOnPush: true,
      },
      // sst remove 時、イメージが残っていても削除できるようにする（検証用の使い捨てリポジトリのため許容する）
      forceDelete: true,
      tags: { Name: `${prefix}-${stage}` },
    });

    let image: aws.ecr.GetImageResult | undefined;
    try {
      image = await aws.ecr.getImage({
        repositoryName: `${prefix}-${stage}`,
        imageTag: "latest",
      });
    } catch {
      console.warn("ECR image not found yet, skipping imageDigest trigger.");
    }

    new aws.ecr.LifecyclePolicy(`${prefix}-lifecycle-policy-${stage}`, {
      repository: repository.name,
      policy: $jsonStringify({
        rules: [
          {
            rulePriority: 1,
            description: "Keep 30 days",
            selection: {
              tagStatus: "untagged",
              countType: "sinceImagePushed",
              countUnit: "days",
              countNumber: 30,
            },
            action: { type: "expire" },
          },
        ],
      }),
    });

    return ok({ repository, image });
  } catch (error) {
    return err(awsError("Failed to create load test repository", error));
  }
};

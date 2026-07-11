/**
 * Infra Error
 *
 * AWSリソース作成時に発生したエラーを Result 型で扱うための共通エラー型。
 */
export type InfraError = {
  message: string;
  cause: unknown;
};

export const awsError = (message: string, cause: unknown): InfraError => ({
  message,
  cause,
});

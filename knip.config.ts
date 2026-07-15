import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    "load-test": {
      // シナリオは k6 バイナリが直接読み込む（TS/JSから import されない）ため entry として明示する。
      // k6/http 等は k6 ランタイム組み込みモジュールで npm パッケージではないため ignoreDependencies に含める。
      entry: ["scenarios/**/*.js", "sst.config.ts"],
      ignoreBinaries: ["k6"],
      ignoreDependencies: ["sst", "k6"],
    },
    "load-test-ec2": {
      // user-data.sh / scripts/run-load-test.sh はどちらもGitHub Actions・EC2起動時に
      // シェルスクリプトとして直接実行されるだけで、TS/JSからimportされないため
      // entry として明示する。
      entry: ["user-data.sh", "scripts/**/*.sh", "sst.config.ts"],
    },
    infra: {
      entry: ["src/**/*.ts"],
    },
  },
};

export default config;
